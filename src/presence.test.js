import { describe, expect, it } from 'vitest'
import { createLifecyclePublisher } from './presence.js'

const identity = {
  hostId: 'macbook-ryan',
  roomId: 'build-room',
  botId: 'vega-the-engineer',
  pet: { slug: 'vega', version: '1.0.0', url: 'https://example.com/pets/vega-v1.png' },
}

describe('presence.v1 lifecycle publisher', () => {
  it('replays native lifecycle events into presence.v1 transitions', () => {
    const publisher = createLifecyclePublisher({ identity, ttlMs: 30_000 })

    publisher.ingest({ source: 'gateway', type: 'connected', at: '2026-10-03T10:00:00.000Z' })
    publisher.ingest({ source: 'tool', type: 'started', activity: 'Running test suite', at: '2026-10-03T10:00:05.000Z' })
    publisher.ingest({ source: 'llm', type: 'speaking', activity: 'Sending result', at: '2026-10-03T10:00:11.000Z' })

    expect(publisher.getPresence('2026-10-03T10:00:11.000Z')).toEqual({
      version: 'presence.v1', ...identity, state: 'speaking', activity: 'Sending result',
      updatedAt: '2026-10-03T10:00:11.000Z', reason: null,
    })
  })

  it('marks presence unobserved after TTL rather than pretending it is idle', () => {
    const publisher = createLifecyclePublisher({ identity, ttlMs: 30_000 })
    publisher.ingest({ source: 'gateway', type: 'connected', at: '2026-10-03T10:00:00.000Z' })

    expect(publisher.getPresence('2026-10-03T10:00:30.001Z')).toMatchObject({
      state: 'unobserved',
      reason: 'No native lifecycle event received within 30 seconds.',
    })
  })
})
