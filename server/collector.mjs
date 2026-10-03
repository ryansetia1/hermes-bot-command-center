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

export function createCollector({ identity, ttlMs = 30_000, now = () => new Date() }) {
  let latest = null
  let expiryTimer = null
  const clients = new Set()

  function getPresence() {
    if (!latest) return { version: 'presence.v1', ...identity, state: 'unobserved', activity: null, updatedAt: null, reason: 'No native lifecycle event has been received.' }
    const elapsed = now().getTime() - new Date(latest.updatedAt).getTime()
    if (elapsed > ttlMs) return { version: 'presence.v1', ...identity, state: 'unobserved', activity: latest.activity, updatedAt: latest.updatedAt, reason: `No native lifecycle event received within ${ttlMs / 1000} seconds.` }
    return { version: 'presence.v1', ...identity, ...latest, reason: null }
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
    latest = { state, activity: defaultActivity(event, state), updatedAt: event.at ?? now().toISOString() }
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
