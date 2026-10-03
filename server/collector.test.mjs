import { afterEach, describe, expect, it } from 'vitest'
import { createCollector } from './collector.mjs'

// Arbitrary identity: nothing here exists in collector defaults, so it can only arrive via the event.
const identity = {
  hostId: 'studio-mini-7',
  roomId: 'night-shift',
  botId: 'orion-the-tester',
  pet: { slug: 'orion', version: '2.3.4', url: '/pets/orion-v2.png' },
}

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

describe('local presence collector', () => {
  it('reports no identity before any native event', async () => {
    const collector = await startCollector()
    const presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence).toMatchObject({ version: 'presence.v1', state: 'unobserved', hostId: null, botId: null, pet: null })
  })

  it('carries the event identity through /observe into presence.v1 over SSE and /presence', async () => {
    const collector = await startCollector({ now: () => new Date('2026-10-03T10:00:06.000Z') })
    const stream = new AbortController()
    const response = await fetch(`${collector.url}/events`, { signal: stream.signal })
    const reader = response.body.getReader()

    const observed = await observe(collector, { ...identity, source: 'tool', type: 'started', activity: 'Running test suite', at: '2026-10-03T10:00:05.000Z' })
    expect(observed.status).toBe(202)

    const sse = new TextDecoder().decode((await reader.read()).value)
    const streamed = JSON.parse(sse.split('data: ')[1])
    const expected = { version: 'presence.v1', ...identity, state: 'working', activity: 'Running test suite', updatedAt: '2026-10-03T10:00:05.000Z', reason: null }
    expect(streamed).toMatchObject(expected)
    expect(streamed.entities).toEqual([expected])
    expect(streamed.snapshots['studio-mini-7:night-shift:orion-the-tester']).toEqual(expected)
    const presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence).toMatchObject(expected)
    expect(presence.entities).toEqual([expected])
    stream.abort()
  })

  it('rejects events without a complete identity', async () => {
    const collector = await startCollector()
    for (const event of [
      { source: 'llm', type: 'started' },
      { ...identity, botId: '', source: 'llm', type: 'started' },
      { ...identity, pet: { slug: 'orion', version: '1' }, source: 'llm', type: 'started' },
      { ...identity, pet: { ...identity.pet, url: 'javascript:alert(1)' }, source: 'llm', type: 'started' },
    ]) expect((await observe(collector, event)).status).toBe(400)
    expect((await (await fetch(`${collector.url}/presence`)).json()).botId).toBeNull()
  })

  it('broadcasts unobserved with the last identity when native observations expire', async () => {
    const collector = await startCollector({ ttlMs: 10 })
    const controller = new AbortController()
    const response = await fetch(`${collector.url}/events`, { signal: controller.signal })
    const reader = response.body.getReader()

    await observe(collector, { ...identity, source: 'llm', type: 'started' })
    const working = new TextDecoder().decode((await reader.read()).value)
    const unobserved = new TextDecoder().decode((await reader.read()).value)

    expect(working).toContain('"state":"working"')
    expect(unobserved).toContain('"state":"unobserved"')
    expect(unobserved).toContain('"botId":"orion-the-tester"')
    expect(unobserved).toContain('"reason":"No native lifecycle event received within 0.01 seconds."')
    controller.abort()
  })

  it('tracks multiple entities keyed by hostId + roomId + botId across multiple rooms', async () => {
    const collector = await startCollector()
    const botA1 = { hostId: 'default', roomId: 'build-room', botId: 'vega', pet: { slug: 'vega', version: '1.0', url: '/pets/vega.png' } }
    const botA2 = { hostId: 'default', roomId: 'build-room', botId: 'bob', pet: { slug: 'bob', version: '1.0', url: '/pets/bob.png' } }
    const botB1 = { hostId: 'default', roomId: 'qa-lab', botId: 'orion', pet: { slug: 'orion', version: '1.0', url: '/pets/orion.png' } }
    const botC1 = { hostId: 'default', roomId: 'ops-cockpit', botId: 'nova', pet: { slug: 'nova', version: '1.0', url: '/pets/nova.png' } }

    await observe(collector, { ...botA1, source: 'tool', type: 'started', activity: 'Building bundle' })
    await observe(collector, { ...botA2, source: 'llm', type: 'speaking', activity: 'Speaking in chat' })
    await observe(collector, { ...botB1, source: 'tool', type: 'completed', activity: 'Tests done' })
    await observe(collector, { ...botC1, source: 'tool', type: 'failed', activity: 'Deployment crash' })

    const presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence.entities).toHaveLength(4)

    // Keyed by hostId + roomId + botId
    expect(presence.snapshots['default:build-room:vega']).toMatchObject({
      hostId: 'default', roomId: 'build-room', botId: 'vega', state: 'working', activity: 'Building bundle',
    })
    expect(presence.snapshots['default:build-room:bob']).toMatchObject({
      hostId: 'default', roomId: 'build-room', botId: 'bob', state: 'speaking', activity: 'Speaking in chat',
    })
    expect(presence.snapshots['default:qa-lab:orion']).toMatchObject({
      hostId: 'default', roomId: 'qa-lab', botId: 'orion', state: 'idle', activity: 'Tests done',
    })
    expect(presence.snapshots['default:ops-cockpit:nova']).toMatchObject({
      hostId: 'default', roomId: 'ops-cockpit', botId: 'nova', state: 'error', activity: 'Deployment crash',
    })

    // Legacy slice points to the most recent entity (botC1)
    expect(presence).toMatchObject({
      hostId: 'default',
      roomId: 'ops-cockpit',
      botId: 'nova',
      state: 'error',
    })
  })

  it('enforces independent TTL per entity without affecting other entities', async () => {
    let currentTime = new Date('2026-10-03T12:00:00.000Z').getTime()
    const collector = await startCollector({ ttlMs: 1_000, now: () => new Date(currentTime) })
    const bot1 = { hostId: 'default', roomId: 'room-1', botId: 'bot-1', pet: { slug: 'p1', version: '1', url: '/pets/p1.png' } }
    const bot2 = { hostId: 'default', roomId: 'room-2', botId: 'bot-2', pet: { slug: 'p2', version: '1', url: '/pets/p2.png' } }

    // Ingest bot1 at t=0
    await observe(collector, { ...bot1, source: 'tool', type: 'started', activity: 'Task 1', at: new Date(currentTime).toISOString() })

    // Advance 600ms, then ingest bot2
    currentTime += 600
    await observe(collector, { ...bot2, source: 'tool', type: 'started', activity: 'Task 2', at: new Date(currentTime).toISOString() })

    // Advance 600ms more (total t=1200ms from bot1, t=600ms from bot2).
    // bot1 elapsed 1200ms (>1000ms) -> unobserved; bot2 elapsed 600ms (<1000ms) -> working
    currentTime += 600

    const snapshotAt1200 = await (await fetch(`${collector.url}/presence`)).json()
    const b1 = snapshotAt1200.snapshots['default:room-1:bot-1']
    const b2 = snapshotAt1200.snapshots['default:room-2:bot-2']

    expect(b1.state).toBe('unobserved')
    expect(b1.reason).toContain('No native lifecycle event received within 1 seconds.')
    expect(b2.state).toBe('working')
    expect(b2.reason).toBeNull()

    // Advance 600ms more (total t=1800ms from bot1, t=1200ms from bot2). Both now unobserved
    currentTime += 600

    const snapshotAt1800 = await (await fetch(`${collector.url}/presence`)).json()
    expect(snapshotAt1800.snapshots['default:room-1:bot-1'].state).toBe('unobserved')
    expect(snapshotAt1800.snapshots['default:room-2:bot-2'].state).toBe('unobserved')

    // Re-activating bot1 restores bot1 while leaving bot2 unobserved
    await observe(collector, { ...bot1, source: 'llm', type: 'speaking', activity: 'Back online', at: new Date(currentTime).toISOString() })
    const snapshotRestored = await (await fetch(`${collector.url}/presence`)).json()
    expect(snapshotRestored.snapshots['default:room-1:bot-1'].state).toBe('speaking')
    expect(snapshotRestored.snapshots['default:room-2:bot-2'].state).toBe('unobserved')
  })

  it('streams multi-entity and multi-room snapshots over SSE with entity expiration', async () => {
    const collector = await startCollector({ ttlMs: 25 })
    const controller = new AbortController()
    const response = await fetch(`${collector.url}/events`, { signal: controller.signal })
    const reader = response.body.getReader()

    const bot1 = { hostId: 'default', roomId: 'frontend', botId: 'fe-bot', pet: { slug: 'fe', version: '1', url: '/pets/fe.png' } }
    const bot2 = { hostId: 'default', roomId: 'backend', botId: 'be-bot', pet: { slug: 'be', version: '1', url: '/pets/be.png' } }

    await observe(collector, { ...bot1, source: 'llm', type: 'speaking', activity: 'Explaining UI' })
    const msg1 = new TextDecoder().decode((await reader.read()).value)
    const data1 = JSON.parse(msg1.split('data: ')[1])
    expect(data1.entities).toHaveLength(1)
    expect(data1.snapshots['default:frontend:fe-bot'].state).toBe('speaking')

    await observe(collector, { ...bot2, source: 'tool', type: 'started', activity: 'Running migrations' })
    const msg2 = new TextDecoder().decode((await reader.read()).value)
    const data2 = JSON.parse(msg2.split('data: ')[1])
    expect(data2.entities).toHaveLength(2)
    expect(data2.snapshots['default:frontend:fe-bot'].state).toBe('speaking')
    expect(data2.snapshots['default:backend:be-bot'].state).toBe('working')

    // Read expiration message when fe-bot expires
    const msg3 = new TextDecoder().decode((await reader.read()).value)
    const data3 = JSON.parse(msg3.split('data: ')[1])
    expect(data3.snapshots['default:frontend:fe-bot'].state).toBe('unobserved')
    expect(data3.snapshots['default:frontend:fe-bot'].reason).toContain('No native lifecycle event received')

    controller.abort()
  })

  it('preserves unobserved as honest unobserved data and never maps it to idle', async () => {
    const collector = await startCollector({ ttlMs: 15 })
    const bot = { hostId: 'default', roomId: 'auditing', botId: 'auditor', pet: { slug: 'au', version: '1', url: '/pets/au.png' } }

    // First observe idle
    await observe(collector, { ...bot, source: 'llm', type: 'completed' })
    const idleSnapshot = await (await fetch(`${collector.url}/presence`)).json()
    expect(idleSnapshot.snapshots['default:auditing:auditor'].state).toBe('idle')
    expect(idleSnapshot.snapshots['default:auditing:auditor'].activity).toBe('Waiting for the next task')
    expect(idleSnapshot.snapshots['default:auditing:auditor'].reason).toBeNull()

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 20))
    const expiredSnapshot = await (await fetch(`${collector.url}/presence`)).json()
    const entity = expiredSnapshot.snapshots['default:auditing:auditor']
    expect(entity.state).toBe('unobserved')
    expect(entity.state).not.toBe('idle')
    expect(entity.reason).toContain('No native lifecycle event received within 0.015 seconds.')
    // Original activity is honestly preserved, not overwritten by "Waiting for the next task"
    expect(entity.activity).toBe('Waiting for the next task')
  })

  it('allows removing stale or unwanted entities via DELETE /presence and broadcasts update', async () => {
    const collector = await startCollector({ ttlMs: 50 })
    const bot1 = { hostId: 'default', roomId: 'build-room', botId: 'default', pet: { slug: 'default', version: '1', url: '/pets/default.png' } }
    const bot2 = { hostId: 'default', roomId: 'direct', botId: 'atlas', pet: { slug: 'atlas', version: '1', url: '/pets/atlas.png' } }
    const bot3 = { hostId: 'default', roomId: 'direct', botId: 'elio', pet: { slug: 'elio', version: '1', url: '/pets/elio.png' } }

    await observe(collector, { ...bot1, source: 'llm', type: 'completed' })
    await observe(collector, { ...bot2, source: 'tool', type: 'started' })
    await observe(collector, { ...bot3, source: 'llm', type: 'speaking' })

    let presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence.entities).toHaveLength(3)

    // Delete specific key (e.g. the stuck default:build-room:default)
    const del1 = await fetch(`${collector.url}/presence?key=default:build-room:default`, { method: 'DELETE' })
    expect(del1.status).toBe(200)
    const res1 = await del1.json()
    expect(res1).toEqual({ ok: true, deleted: 1 })

    presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence.entities).toHaveLength(2)
    expect(presence.snapshots['default:build-room:default']).toBeUndefined()
    expect(presence.snapshots['default:direct:atlas']).toBeDefined()
    expect(presence.snapshots['default:direct:elio']).toBeDefined()

    // Delete by roomId
    const del2 = await fetch(`${collector.url}/presence?roomId=direct`, { method: 'DELETE' })
    const res2 = await del2.json()
    expect(res2).toEqual({ ok: true, deleted: 2 })

    presence = await (await fetch(`${collector.url}/presence`)).json()
    expect(presence.entities).toHaveLength(0)
    expect(presence.state).toBe('unobserved')
  })
})
