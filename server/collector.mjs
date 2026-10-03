import { createServer } from 'node:http'

const stateForEvent = {
  'gateway:received': 'working',
  'llm:started': 'working',
  'llm:speaking': 'speaking',
  'llm:completed': 'idle',
  'tool:started': 'working',
  'tool:completed': 'idle',
  'tool:failed': 'error',
}

function defaultActivity(event, state) {
  if (event.activity) return event.activity
  if (state === 'idle') return 'Waiting for the next task'
  if (state === 'error') return 'Native lifecycle reported an error'
  return 'Processing native lifecycle event'
}

const isText = (value) => typeof value === 'string' && value.trim() !== ''

// presence.v1 identity comes from the publishing profile on every event; the collector never invents it.
function identityOf(event) {
  const { hostId, roomId, botId, pet } = event
  if (![hostId, roomId, botId, pet?.slug, pet?.version].every(isText)) throw new Error('Event identity requires hostId, roomId, botId and pet { slug, version, url }')
  if (!isText(pet.url) || !/^(\/|https?:\/\/)/.test(pet.url)) throw new Error('pet.url must be a root-relative path or http(s) URL')
  return { hostId, roomId, botId, pet: { slug: pet.slug, version: pet.version, url: pet.url } }
}

const noIdentity = { hostId: null, roomId: null, botId: null, pet: null }

export function createCollector({ ttlMs = 30_000, now = () => new Date() } = {}) {
  let latest = null
  let expiryTimer = null
  const clients = new Set()

  function getPresence() {
    if (!latest) return { version: 'presence.v1', ...noIdentity, state: 'unobserved', activity: null, updatedAt: null, reason: 'No native lifecycle event has been received.' }
    const elapsed = now().getTime() - new Date(latest.updatedAt).getTime()
    if (elapsed > ttlMs) return { version: 'presence.v1', ...latest.identity, state: 'unobserved', activity: latest.activity, updatedAt: latest.updatedAt, reason: `No native lifecycle event received within ${ttlMs / 1000} seconds.` }
    const { identity, ...observed } = latest
    return { version: 'presence.v1', ...identity, ...observed, reason: null }
  }

  function broadcast() {
    const message = `event: presence\ndata: ${JSON.stringify(getPresence())}\n\n`
    clients.forEach((response) => response.write(message))
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(broadcast, ttlMs + 1)
  }

  function ingest(event) {
    const state = stateForEvent[`${event.source}:${event.type}`]
    if (!state) throw new Error(`Unsupported native lifecycle event: ${event.source}:${event.type}`)
    // ponytail: single-bot MVP, the latest event's identity replaces the previous one; key by botId for multi-bot.
    latest = { identity: identityOf(event), state, activity: defaultActivity(event, state), updatedAt: event.at ?? now().toISOString() }
    scheduleExpiry()
    broadcast()
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/presence') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(getPresence()))
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.flushHeaders()
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }
    if (request.method === 'POST' && url.pathname === '/observe') {
      let body = ''
      for await (const chunk of request) body += chunk
      try {
        ingest(JSON.parse(body))
        response.writeHead(202).end()
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
      }
      return
    }
    response.writeHead(404).end()
  })

  return {
    get url() {
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    ingest,
    listen(port = 8787) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    close() {
      clearTimeout(expiryTimer)
      clients.forEach((response) => response.end())
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
