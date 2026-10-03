#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export function parseCliArgs(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Hermes Bot Command Center Launcher

Usage:
  npm run dashboard [options]
  node scripts/launcher.mjs [options]

Options:
  --no-open               Do not open the dashboard URL in the browser
  --port <port>           Specify Vite dev server port (default: 5173)
  --presence-port <port>  Specify presence collector port (default: 8787)
  -h, --help              Show this help message

All other flags are forwarded directly to Vite.
`)
    process.exit(0)
  }

  const options = {
    open: true,
    viteArgs: [],
    customEnv: {},
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-open') {
      options.open = false
    } else if (arg === '--open') {
      options.open = true
    } else if (arg === '--port' && i + 1 < args.length) {
      options.port = args[++i]
      options.viteArgs.push('--port', options.port)
    } else if (arg.startsWith('--port=')) {
      options.port = arg.slice(7)
      options.viteArgs.push(arg)
    } else if (arg === '--presence-port' && i + 1 < args.length) {
      options.presencePort = args[++i]
      options.customEnv.PRESENCE_PORT = options.presencePort
    } else if (arg.startsWith('--presence-port=')) {
      options.presencePort = arg.slice(16)
      options.customEnv.PRESENCE_PORT = options.presencePort
    } else {
      options.viteArgs.push(arg)
    }
  }

  return options
}

export function resolveViteBin(cwd = process.cwd()) {
  try {
    const req = createRequire(path.join(cwd, 'package.json'))
    const vitePkgJson = req.resolve('vite/package.json')
    return path.resolve(path.dirname(vitePkgJson), 'bin/vite.js')
  } catch {
    return path.resolve(cwd, 'node_modules/vite/bin/vite.js')
  }
}

export function resolveCollectorScript(cwd = process.cwd()) {
  return path.resolve(cwd, 'server/index.mjs')
}

export function extractDashboardUrl(line) {
  // Strip ANSI color escape codes
  const cleanLine = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
  const match = cleanLine.match(/Local:\s+(https?:\/\/[^\s]+)/i)
  if (match) {
    return match[1].trim()
  }
  return null
}

export function openBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform
  const spawnFn = options.spawn ?? spawn
  const isCi = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false'
  const shouldOpen = options.open ?? (
    !isCi &&
    process.env.NO_OPEN !== '1' &&
    process.env.OPEN !== 'false'
  )

  if (!shouldOpen) return false

  try {
    if (platform === 'darwin') {
      const child = spawnFn('open', [url], { stdio: 'ignore', detached: true })
      if (child.on) child.on('error', () => {})
      if (child.unref) child.unref()
      return true
    }
    if (platform === 'win32') {
      const child = spawnFn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
      if (child.on) child.on('error', () => {})
      if (child.unref) child.unref()
      return true
    }
    if (platform === 'linux') {
      const child = spawnFn('xdg-open', [url], { stdio: 'ignore', detached: true })
      if (child.on) child.on('error', () => {})
      if (child.unref) child.unref()
      return true
    }
  } catch {
    return false
  }
  return false
}

export function stopChildProcess(child, signal = 'SIGTERM', timeoutMs = 2000) {
  if (!child || child.killed || child.exitCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let finished = false
    const onExit = () => {
      if (!finished) {
        finished = true
        clearTimeout(timer)
        resolve()
      }
    }

    child.once('exit', onExit)

    try {
      child.kill(signal)
    } catch {
      onExit()
      return
    }

    const timer = setTimeout(() => {
      if (!finished) {
        try {
          child.kill('SIGKILL')
        } catch {}
        onExit()
      }
    }, timeoutMs)
    if (timer.unref) timer.unref()
  })
}

export function createLauncher(config = {}) {
  const cwd = config.cwd ?? process.cwd()
  const logger = config.logger ?? console
  const open = config.open ?? true
  const customEnv = config.customEnv ?? {}
  const viteArgs = config.viteArgs ? [...config.viteArgs] : []
  const spawnFn = config.spawn ?? spawn
  const openBrowserFn = config.openBrowser ?? openBrowser

  const collectorScript = config.collectorScript ?? resolveCollectorScript(cwd)
  const viteBin = config.viteBin ?? resolveViteBin(cwd)

  let collectorProcess = null
  let viteProcess = null
  let isShuttingDown = false
  let urlReported = false

  let resolveReadyUrl
  let rejectReadyUrl
  const readyUrlPromise = new Promise((resolve, reject) => {
    resolveReadyUrl = resolve
    rejectReadyUrl = reject
  })
  // Prevent unhandled rejection warnings if stopped before ready
  readyUrlPromise.catch(() => {})

  function pipeWithPrefix(readable, prefix, onLine) {
    if (!readable) return
    if (typeof readable.resume !== 'function') readable.resume = () => {}
    if (typeof readable.pause !== 'function') readable.pause = () => {}
    const rl = readline.createInterface({ input: readable })
    rl.on('line', (line) => {
      if (onLine) onLine(line)
      logger.log(`[${prefix}] ${line}`)
    })
  }

  function pipeErrWithPrefix(readable, prefix) {
    if (!readable) return
    if (typeof readable.resume !== 'function') readable.resume = () => {}
    if (typeof readable.pause !== 'function') readable.pause = () => {}
    const rl = readline.createInterface({ input: readable })
    rl.on('line', (line) => {
      logger.error(`[${prefix}] ${line}`)
    })
  }

  async function stop(signal = 'SIGTERM', exitCode = 0) {
    if (isShuttingDown) return
    isShuttingDown = true
    if (!urlReported && rejectReadyUrl) {
      rejectReadyUrl(new Error(`Launcher stopped with ${signal} before dashboard was ready.`))
    }
    logger.log(`\n[launcher] Stopping services (${signal})...`)

    removeSignalHandlers()

    await Promise.all([
      stopChildProcess(collectorProcess, signal),
      stopChildProcess(viteProcess, signal),
    ])

    logger.log('[launcher] All services shut down cleanly.')
    return { exited: true, exitCode }
  }

  function handleUnexpectedExit(serviceName, code, signal) {
    if (isShuttingDown) return
    if (!urlReported && rejectReadyUrl) {
      rejectReadyUrl(new Error(`${serviceName} exited unexpectedly (code: ${code}, signal: ${signal}) before ready.`))
    }
    logger.error(`[launcher] ${serviceName} process exited unexpectedly (code: ${code}, signal: ${signal}).`)
    stop('SIGTERM', code || 1).then(() => {
      if (config.exitOnCrash !== false) {
        process.exit(code || 1)
      }
    })
  }

  const onSigInt = () => stop('SIGINT', 0).then(() => process.exit(0))
  const onSigTerm = () => stop('SIGTERM', 0).then(() => process.exit(0))
  const onSigHup = () => stop('SIGHUP', 0).then(() => process.exit(0))
  const onProcessExit = () => {
    // Synchronous emergency cleanup
    if (collectorProcess && !collectorProcess.killed && collectorProcess.exitCode === null) {
      try { collectorProcess.kill('SIGKILL') } catch {}
    }
    if (viteProcess && !viteProcess.killed && viteProcess.exitCode === null) {
      try { viteProcess.kill('SIGKILL') } catch {}
    }
  }

  function registerSignalHandlers() {
    process.on('SIGINT', onSigInt)
    process.on('SIGTERM', onSigTerm)
    process.on('SIGHUP', onSigHup)
    process.on('exit', onProcessExit)
  }

  function removeSignalHandlers() {
    process.off('SIGINT', onSigInt)
    process.off('SIGTERM', onSigTerm)
    process.off('SIGHUP', onSigHup)
    process.off('exit', onProcessExit)
  }

  async function start() {
    logger.log('[launcher] Starting Hermes Command Center (collector + dashboard)...')
    registerSignalHandlers()

    const sharedEnv = {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      ...customEnv,
    }

    // 1. Spawn collector child process
    collectorProcess = spawnFn(process.execPath, [collectorScript], {
      cwd,
      env: sharedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    pipeWithPrefix(collectorProcess.stdout, 'collector')
    pipeErrWithPrefix(collectorProcess.stderr, 'collector')

    collectorProcess.on('exit', (code, signal) => {
      handleUnexpectedExit('Collector', code, signal)
    })

    // 2. Spawn Vite child process
    viteProcess = spawnFn(process.execPath, [viteBin, ...viteArgs], {
      cwd,
      env: sharedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    pipeWithPrefix(viteProcess.stdout, 'vite', (line) => {
      if (!urlReported) {
        const detectedUrl = extractDashboardUrl(line)
        if (detectedUrl) {
          urlReported = true
          logger.log(`\n[launcher] Dashboard ready at ${detectedUrl}`)
          const opened = openBrowserFn(detectedUrl, { open })
          if (opened) {
            logger.log(`[launcher] Opened dashboard in browser.`)
          }
          resolveReadyUrl(detectedUrl)
        }
      }
    })
    pipeErrWithPrefix(viteProcess.stderr, 'vite')

    viteProcess.on('exit', (code, signal) => {
      handleUnexpectedExit('Vite', code, signal)
    })

    return {
      collectorProcess,
      viteProcess,
      readyUrl: readyUrlPromise,
      stop,
    }
  }

  return {
    start,
    stop,
    get isShuttingDown() { return isShuttingDown },
    get collectorProcess() { return collectorProcess },
    get viteProcess() { return viteProcess },
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const cliOptions = parseCliArgs(process.argv.slice(2))
  const launcher = createLauncher(cliOptions)
  launcher.start().catch((err) => {
    console.error('[launcher] Fatal error starting dashboard:', err)
    process.exit(1)
  })
}
