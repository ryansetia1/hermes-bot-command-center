import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import http from 'node:http'
import {
  createLauncher,
  extractDashboardUrl,
  openBrowser,
  parseCliArgs,
  stopChildProcess,
} from './launcher.mjs'

const activeLaunchers = []
afterEach(async () => {
  for (const launcher of activeLaunchers.splice(0)) {
    try {
      await launcher.stop('SIGTERM')
    } catch {}
  }
})

describe('Launcher CLI arguments and utilities', () => {
  it('parses CLI arguments correctly', () => {
    const opts1 = parseCliArgs(['--no-open', '--port', '5190', '--presence-port', '8888', '--host'])
    expect(opts1.open).toBe(false)
    expect(opts1.port).toBe('5190')
    expect(opts1.presencePort).toBe('8888')
    expect(opts1.customEnv.PRESENCE_PORT).toBe('8888')
    expect(opts1.viteArgs).toEqual(['--port', '5190', '--host'])

    const opts2 = parseCliArgs(['--port=5191', '--presence-port=8889'])
    expect(opts2.open).toBe(true)
    expect(opts2.port).toBe('5191')
    expect(opts2.presencePort).toBe('8889')
    expect(opts2.customEnv.PRESENCE_PORT).toBe('8889')
  })

  it('extracts dashboard URLs and strips ANSI escapes', () => {
    expect(extractDashboardUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(extractDashboardUrl('\u001b[32m  ➜  Local:   \u001b[39m\u001b[36mhttp://127.0.0.1:5174/\u001b[39m')).toBe('http://127.0.0.1:5174/')
    expect(extractDashboardUrl('Random log line')).toBeNull()
  })

  it('handles browser opening logic with platform and CI checks', () => {
    let spawnedCmd = null
    let spawnedArgs = null
    const mockSpawn = (cmd, args) => {
      spawnedCmd = cmd
      spawnedArgs = args
      return { on: () => {}, unref: () => {} }
    }

    // Opens on darwin when enabled
    const opened = openBrowser('http://localhost:5173', {
      platform: 'darwin',
      open: true,
      spawn: mockSpawn,
    })
    expect(opened).toBe(true)
    expect(spawnedCmd).toBe('open')
    expect(spawnedArgs).toEqual(['http://localhost:5173'])

    // Respects open: false
    const notOpened = openBrowser('http://localhost:5173', {
      platform: 'darwin',
      open: false,
      spawn: mockSpawn,
    })
    expect(notOpened).toBe(false)
  })

  it('stops child processes and escalates to SIGKILL if necessary', async () => {
    // Normal graceful exit mock
    const mockChildNormal = new EventEmitter()
    mockChildNormal.killed = false
    mockChildNormal.exitCode = null
    mockChildNormal.kill = (sig) => {
      expect(sig).toBe('SIGTERM')
      setImmediate(() => {
        mockChildNormal.exitCode = 0
        mockChildNormal.emit('exit', 0, sig)
      })
      return true
    }

    await stopChildProcess(mockChildNormal, 'SIGTERM', 100)
    expect(mockChildNormal.exitCode).toBe(0)

    // Stubborn child requiring SIGKILL escalation
    const signals = []
    const mockChildStubborn = new EventEmitter()
    mockChildStubborn.killed = false
    mockChildStubborn.exitCode = null
    mockChildStubborn.kill = (sig) => {
      signals.push(sig)
      if (sig === 'SIGKILL') {
        mockChildStubborn.exitCode = null
        mockChildStubborn.emit('exit', null, 'SIGKILL')
      }
      return true
    }

    await stopChildProcess(mockChildStubborn, 'SIGTERM', 30)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('Launcher orchestration and lifecycle', () => {
  function createMockProcess(name) {
    const proc = new EventEmitter()
    proc.name = name
    proc.killed = false
    proc.exitCode = null
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = (sig) => {
      proc.killed = true
      proc.lastSignal = sig
      setImmediate(() => {
        if (proc.exitCode === null) {
          proc.exitCode = sig === 'SIGKILL' ? null : 0
          proc.emit('exit', proc.exitCode, sig)
        }
      })
      return true
    }
    return proc
  }

  it('starts both processes, detects ready URL, and shuts down on stop()', async () => {
    let collectorProc = null
    let viteProc = null
    const openedUrls = []

    const mockSpawn = (cmd, args) => {
      if (args[0].includes('server/index.mjs')) {
        collectorProc = createMockProcess('collector')
        return collectorProc
      }
      viteProc = createMockProcess('vite')
      return viteProc
    }

    const launcher = createLauncher({
      spawn: mockSpawn,
      openBrowser: (url) => { openedUrls.push(url); return true },
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      exitOnCrash: false,
    })
    activeLaunchers.push(launcher)

    const startPromise = launcher.start()

    // Wait microtask for spawn to execute
    await new Promise((r) => setImmediate(r))

    // Simulate collector output
    collectorProc.stdout.write('Presence collector listening at http://127.0.0.1:8787\n')

    // Simulate Vite ready output
    viteProc.stdout.write('  ➜  Local:   http://localhost:5173/\n')

    const { readyUrl } = await startPromise
    const url = await readyUrl

    expect(url).toBe('http://localhost:5173/')
    expect(openedUrls).toEqual(['http://localhost:5173/'])

    // Calling stop() forwards signal to both child processes
    await launcher.stop('SIGTERM')

    expect(collectorProc.killed).toBe(true)
    expect(collectorProc.lastSignal).toBe('SIGTERM')
    expect(viteProc.killed).toBe(true)
    expect(viteProc.lastSignal).toBe('SIGTERM')
  })

  it('prevents orphan processes if one child exits unexpectedly', async () => {
    let collectorProc = null
    let viteProc = null

    const mockSpawn = (cmd, args) => {
      if (args[0].includes('server/index.mjs')) {
        collectorProc = createMockProcess('collector')
        return collectorProc
      }
      viteProc = createMockProcess('vite')
      return viteProc
    }

    const launcher = createLauncher({
      spawn: mockSpawn,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      exitOnCrash: false,
    })
    activeLaunchers.push(launcher)

    await launcher.start()

    // Both processes are initially running
    expect(collectorProc.exitCode).toBeNull()
    expect(viteProc.exitCode).toBeNull()

    // Simulate collector crashing (e.g. port conflict with exit code 1)
    collectorProc.exitCode = 1
    collectorProc.emit('exit', 1, null)

    // Wait for the launcher event loop to react
    await new Promise((r) => setTimeout(r, 50))

    // Vite must have been killed to prevent an orphan process!
    expect(viteProc.killed).toBe(true)
    expect(viteProc.lastSignal).toBe('SIGTERM')
  })

  it('prevents orphan processes if Vite exits unexpectedly by killing collector', async () => {
    let collectorProc = null
    let viteProc = null

    const mockSpawn = (cmd, args) => {
      if (args[0].includes('server/index.mjs')) {
        collectorProc = createMockProcess('collector')
        return collectorProc
      }
      viteProc = createMockProcess('vite')
      return viteProc
    }

    const launcher = createLauncher({
      spawn: mockSpawn,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      exitOnCrash: false,
    })
    activeLaunchers.push(launcher)

    await launcher.start()

    expect(collectorProc.exitCode).toBeNull()
    expect(viteProc.exitCode).toBeNull()

    // Simulate Vite crashing
    viteProc.exitCode = 1
    viteProc.emit('exit', 1, null)

    await new Promise((r) => setTimeout(r, 50))

    // Collector must have been killed to prevent an orphan process!
    expect(collectorProc.killed).toBe(true)
    expect(collectorProc.lastSignal).toBe('SIGTERM')
  })

  it('forwards SIGINT to both child processes when stopping with SIGINT', async () => {
    let collectorProc = null
    let viteProc = null

    const mockSpawn = (cmd, args) => {
      if (args[0].includes('server/index.mjs')) {
        collectorProc = createMockProcess('collector')
        return collectorProc
      }
      viteProc = createMockProcess('vite')
      return viteProc
    }

    const launcher = createLauncher({
      spawn: mockSpawn,
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      exitOnCrash: false,
    })
    activeLaunchers.push(launcher)

    await launcher.start()

    await launcher.stop('SIGINT')

    expect(collectorProc.killed).toBe(true)
    expect(collectorProc.lastSignal).toBe('SIGINT')
    expect(viteProc.killed).toBe(true)
    expect(viteProc.lastSignal).toBe('SIGINT')
  })
})

describe('Launcher end-to-end integration', () => {
  it('launches real collector and vite dev server together, exposes both, and terminates cleanly', async () => {
    const testPresencePort = '8987'
    const testVitePort = '5199'

    const launcher = createLauncher({
      open: false,
      customEnv: { PRESENCE_PORT: testPresencePort },
      viteArgs: ['--port', testVitePort, '--no-open'],
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      exitOnCrash: false,
    })
    activeLaunchers.push(launcher)

    const { readyUrl } = await launcher.start()

    // Wait for Vite ready URL
    const dashboardUrl = await readyUrl
    expect(dashboardUrl).toContain(`:${testVitePort}`)

    // 1. Verify Collector responds on testPresencePort
    const collectorRes = await fetch(`http://127.0.0.1:${testPresencePort}/presence`)
    expect(collectorRes.status).toBe(200)
    const presenceData = await collectorRes.json()
    expect(presenceData.version).toBe('presence.v1')

    // 2. Verify Vite responds on testVitePort
    const viteRes = await fetch(`http://localhost:${testVitePort}/`)
    expect(viteRes.status).toBe(200)
    const viteHtml = await viteRes.text()
    expect(viteHtml).toContain('<div id="root"></div>')

    // 3. Stop launcher and verify both child processes exit cleanly
    await launcher.stop('SIGTERM')

    // Wait briefly for ports to release
    await new Promise((r) => setTimeout(r, 100))

    // Verify collector is no longer accepting requests
    await expect(fetch(`http://127.0.0.1:${testPresencePort}/presence`)).rejects.toThrow()
  }, 10_000)
})
