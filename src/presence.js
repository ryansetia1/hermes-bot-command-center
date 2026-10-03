const stateForEvent = {
  'gateway:connected': 'idle',
  'gateway:disconnected': 'error',
  'llm:started': 'working',
  'llm:speaking': 'speaking',
  'tool:started': 'working',
  'tool:failed': 'error',
  'tool:completed': 'idle',
}

function defaultActivity(event, state) {
  if (event.activity) return event.activity
  if (state === 'idle') return 'Waiting for the next task'
  if (state === 'error') return 'Native lifecycle reported an error'
  return 'Processing native lifecycle event'
}

export function createLifecyclePublisher({ identity, ttlMs = 30_000 }) {
  let latest = null
  const listeners = new Set()
  const emit = () => listeners.forEach((listener) => listener())

  return {
    ingest(event) {
      const state = stateForEvent[`${event.source}:${event.type}`]
      if (!state) throw new Error(`Unsupported native lifecycle event: ${event.source}:${event.type}`)
      latest = { state, activity: defaultActivity(event, state), updatedAt: event.at }
      emit()
    },
    getPresence(now = new Date().toISOString()) {
      if (!latest) return { version: 'presence.v1', ...identity, state: 'unobserved', activity: null, updatedAt: null, reason: 'No native lifecycle event has been received.' }
      const elapsed = new Date(now).getTime() - new Date(latest.updatedAt).getTime()
      if (elapsed > ttlMs) {
        return { version: 'presence.v1', ...identity, state: 'unobserved', activity: latest.activity, updatedAt: latest.updatedAt, reason: `No native lifecycle event received within ${ttlMs / 1000} seconds.` }
      }
      return { version: 'presence.v1', ...identity, ...latest, reason: null }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const defaultIdentity = {
  hostId: 'macbook-ryan',
  roomId: 'build-room',
  botId: 'vega-the-engineer',
  pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
}

export function createDefaultPublisher() {
  const publisher = createLifecyclePublisher({ identity: defaultIdentity })
  publisher.ingest({ source: 'gateway', type: 'connected', activity: 'Connected through native gateway lifecycle', at: new Date().toISOString() })
  return publisher
}
