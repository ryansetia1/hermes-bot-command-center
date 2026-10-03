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
    expect(streamed).toEqual(expected)
    expect(await (await fetch(`${collector.url}/presence`)).json()).toEqual(expected)
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
})
