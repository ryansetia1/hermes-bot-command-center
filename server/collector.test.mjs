import { afterEach, describe, expect, it } from 'vitest'
import { createCollector } from './collector.mjs'

const identity = {
  hostId: 'macbook-ryan',
  roomId: 'build-room',
  botId: 'vega-the-engineer',
  pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
}

const collectors = []
afterEach(() => collectors.splice(0).forEach((collector) => collector.close()))

async function startCollector(options = {}) {
  const collector = createCollector({ identity, ttlMs: 30_000, ...options })
  collectors.push(collector)
  await collector.listen(0)
  return collector
}

describe('local presence collector', () => {
  it('accepts a native hook observation and broadcasts presence.v1 over SSE', async () => {
    const collector = await startCollector()
    const events = []
    const stream = new AbortController()
    const response = await fetch(`${collector.url}/events`, { signal: stream.signal })
    const reader = response.body.getReader()
    const readEvent = reader.read().then(({ value }) => events.push(new TextDecoder().decode(value)))

    const observed = await fetch(`${collector.url}/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tool', type: 'started', activity: 'Running test suite', at: '2026-10-03T10:00:05.000Z' }),
    })

    expect(observed.status).toBe(202)
    await readEvent
    expect(events.join('')).toContain('"state":"working"')
    expect(events.join('')).toContain('"activity":"Running test suite"')
    stream.abort()
  })

  it('broadcasts unobserved over SSE when native observations expire', async () => {
    const collector = await startCollector({ ttlMs: 10 })
    const controller = new AbortController()
    const response = await fetch(`${collector.url}/events`, { signal: controller.signal })
    const reader = response.body.getReader()

    await fetch(`${collector.url}/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'llm', type: 'started' }),
    })
    const working = new TextDecoder().decode((await reader.read()).value)
    const unobserved = new TextDecoder().decode((await reader.read()).value)

    expect(working).toContain('"state":"working"')
    expect(unobserved).toContain('"state":"unobserved"')
    expect(unobserved).toContain('"reason":"No native lifecycle event received within 0.01 seconds."')
    controller.abort()
  })
})
