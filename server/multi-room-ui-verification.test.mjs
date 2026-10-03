import { afterEach, describe, expect, it } from 'vitest'
import { createCollector } from './collector.mjs'

const collectors = []
afterEach(() => collectors.splice(0).forEach((collector) => collector.close()))

async function startCollector(options = {}) {
  const collector = createCollector({ ttlMs: 30_000, ...options })
  collectors.push(collector)
  await collector.listen(0)
  return collector
}

const observe = (collector, event) => fetch(`${collector.url}/observe`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(event),
})

describe('UI multi-room replay verification (4 rooms on host default)', () => {
  it('verifies four rooms on host default with speaking/working prioritization and honest unobserved preservation', async () => {
    const fixedNow = new Date('2026-10-03T12:00:00.000Z')
    const collector = await startCollector({ ttlMs: 30_000, now: () => fixedNow })

    const hostId = 'default'
    const nowMs = fixedNow.getTime()

    const events = [
      // Room 1: build-room (2 bots: 1 working, 1 speaking)
      {
        hostId,
        roomId: 'build-room',
        botId: 'vega-the-engineer',
        pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
        source: 'tool',
        type: 'started',
        activity: 'Compiling TypeScript and bundling assets',
        at: new Date(nowMs - 8_000).toISOString(),
      },
      {
        hostId,
        roomId: 'build-room',
        botId: 'artisan-bot',
        pet: { slug: 'atlas', version: '2.1.0', url: '/pets/atlas-v1.png' },
        source: 'llm',
        type: 'speaking',
        activity: 'Broadcasting build pass notification to chat',
        at: new Date(nowMs - 3_000).toISOString(),
      },

      // Room 2: qa-lab (1 bot: working)
      {
        hostId,
        roomId: 'qa-lab',
        botId: 'orion-the-tester',
        pet: { slug: 'vega', version: '1.2.0', url: '/pets/vega-v1.svg' },
        source: 'tool',
        type: 'started',
        activity: 'Running Vitest and e2e integration test suite',
        at: new Date(nowMs - 12_000).toISOString(),
      },

      // Room 3: triage-hub (2 bots: 1 idle, 1 stale -> honest unobserved)
      {
        hostId,
        roomId: 'triage-hub',
        botId: 'atlas-triage',
        pet: { slug: 'atlas', version: '2.1.0', url: '/pets/atlas-v1.png' },
        source: 'tool',
        type: 'completed',
        activity: 'Waiting for incoming incident reports',
        at: new Date(nowMs - 15_000).toISOString(),
      },
      {
        hostId,
        roomId: 'triage-hub',
        botId: 'ghost-monitor',
        pet: { slug: 'vega', version: '0.9.0', url: '/pets/vega-v1.svg' },
        source: 'gateway',
        type: 'received',
        activity: 'Last heartbeat before network partition',
        at: new Date(nowMs - 45_000).toISOString(), // > 30s TTL
      },

      // Room 4: ops-cockpit (2 bots: 1 speaking, 1 error)
      {
        hostId,
        roomId: 'ops-cockpit',
        botId: 'nova-deployer',
        pet: { slug: 'atlas', version: '3.0.0', url: '/pets/atlas-v1.png' },
        source: 'llm',
        type: 'speaking',
        activity: 'Streaming canary rollout status to Slack',
        at: new Date(nowMs - 2_000).toISOString(),
      },
      {
        hostId,
        roomId: 'ops-cockpit',
        botId: 'sentinel-guard',
        pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
        source: 'tool',
        type: 'failed',
        activity: 'Connection timeout contacting secondary database',
        at: new Date(nowMs - 10_000).toISOString(),
      },
    ]

    for (const evt of events) {
      const res = await observe(collector, evt)
      expect(res.status).toBe(202)
    }

    const presence = await (await fetch(`${collector.url}/presence`)).json()

    // 1. Verify hostId is default
    expect(presence.hostId).toBe('default')

    // 2. Verify all 7 entities are recorded across 4 rooms
    expect(presence.entities).toHaveLength(7)
    const distinctRooms = [...new Set(presence.entities.map((e) => e.roomId))].sort()
    expect(distinctRooms).toEqual(['build-room', 'ops-cockpit', 'qa-lab', 'triage-hub'])

    // 3. Verify each room has the expected bot entities and states
    const byRoom = (r) => presence.entities.filter((e) => e.roomId === r)

    // build-room: artisan-bot (speaking), vega-the-engineer (working)
    const buildBots = byRoom('build-room')
    expect(buildBots).toHaveLength(2)
    expect(buildBots.find((b) => b.botId === 'artisan-bot').state).toBe('speaking')
    expect(buildBots.find((b) => b.botId === 'vega-the-engineer').state).toBe('working')

    // qa-lab: orion-the-tester (working)
    const qaBots = byRoom('qa-lab')
    expect(qaBots).toHaveLength(1)
    expect(qaBots[0].state).toBe('working')

    // triage-hub: atlas-triage (idle), ghost-monitor (honest unobserved, never mapped to idle!)
    const triageBots = byRoom('triage-hub')
    expect(triageBots).toHaveLength(2)
    const idleBot = triageBots.find((b) => b.botId === 'atlas-triage')
    const unobservedBot = triageBots.find((b) => b.botId === 'ghost-monitor')
    expect(idleBot.state).toBe('idle')
    expect(unobservedBot.state).toBe('unobserved')
    expect(unobservedBot.state).not.toBe('idle')
    expect(unobservedBot.reason).toBe('No native lifecycle event received within 30 seconds.')

    // ops-cockpit: nova-deployer (speaking), sentinel-guard (error)
    const opsBots = byRoom('ops-cockpit')
    expect(opsBots).toHaveLength(2)
    expect(opsBots.find((b) => b.botId === 'nova-deployer').state).toBe('speaking')
    expect(opsBots.find((b) => b.botId === 'sentinel-guard').state).toBe('error')

    // 4. Verify snapshot map contains all 7 compound keys
    expect(Object.keys(presence.snapshots)).toHaveLength(7)
    expect(presence.snapshots['default:build-room:artisan-bot']).toBeDefined()
    expect(presence.snapshots['default:triage-hub:ghost-monitor'].state).toBe('unobserved')
  })
})
