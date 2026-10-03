import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PET_FILES = { 'pet.json': 'application/json', 'spritesheet.webp': 'image/webp', 'spritesheet.png': 'image/png' }

const isText = (value) => typeof value === 'string' && value.trim() !== ''

// presence.v1 identity comes from the publishing profile on every event; the collector never invents it.
function identityOf(event) {
  const { hostId, roomId, botId, pet, roomName } = event
  if (![hostId, roomId, botId, pet?.slug, pet?.version].every(isText)) throw new Error('Event identity requires hostId, roomId, botId and pet { slug, version, url }')
  if (!isText(pet.url) || !/^(\/|https?:\/\/)/.test(pet.url)) throw new Error('pet.url must be a root-relative path or http(s) URL')
  const identity = { hostId, roomId, botId, pet: { slug: pet.slug, version: pet.version, url: pet.url } }
  if (isText(roomName)) {
    identity.roomName = roomName.trim()
  }
  return identity
}

const noIdentity = { hostId: null, roomId: null, roomName: null, botId: null, pet: null }

export const entityKey = ({ hostId, roomId, botId }) => `${hostId}:${roomId}:${botId}`

export function createCollector({ ttlMs = 30_000, now = () => new Date(), hermesHome = process.env.HERMES_HOME_DIR || join(homedir(), '.hermes') } = {}) {
  const entities = new Map()
  const expiryTimers = new Map()
  let latestKey = null
  const clients = new Set()

  function entityPresence(entity) {
    const elapsed = now().getTime() - new Date(entity.updatedAt).getTime()
    if (elapsed > ttlMs) {
      return {
        version: 'presence.v1',
        ...entity.identity,
        state: 'unobserved',
        activity: entity.activity,
        updatedAt: entity.updatedAt,
        reason: `No native lifecycle event received within ${ttlMs / 1000} seconds.`,
      }
    }
    return {
      version: 'presence.v1',
      ...entity.identity,
      state: entity.state,
      activity: entity.activity,
      updatedAt: entity.updatedAt,
      reason: null,
    }
  }

  function getPresence() {
    if (entities.size === 0) {
      return {
        version: 'presence.v1',
        ...noIdentity,
        state: 'unobserved',
        activity: null,
        updatedAt: null,
        reason: 'No native lifecycle event has been received.',
        entities: [],
        snapshots: {},
      }
    }

    const entityList = Array.from(entities.values()).map(entityPresence)
    const snapshots = Object.fromEntries(entityList.map((item) => [entityKey(item), item]))
    const latestEntity = (latestKey && entities.has(latestKey))
      ? entityPresence(entities.get(latestKey))
      : entityList[entityList.length - 1]

    return {
      version: 'presence.v1',
      ...latestEntity,
      entities: entityList,
      snapshots,
    }
  }

  function broadcast() {
    const message = `event: presence\ndata: ${JSON.stringify(getPresence())}\n\n`
    clients.forEach((response) => response.write(message))
  }

  function scheduleExpiry(key) {
    if (expiryTimers.has(key)) {
      clearTimeout(expiryTimers.get(key))
    }
    const timer = setTimeout(() => {
      expiryTimers.delete(key)
      broadcast()
    }, ttlMs + 1)
    expiryTimers.set(key, timer)
  }

  function ingest(event) {
    const identity = identityOf(event)
    const state = stateForEvent[`${event.source}:${event.type}`]
    if (!state) throw new Error(`Unsupported native lifecycle event: ${event.source}:${event.type}`)

    const key = entityKey(identity)
    latestKey = key

    const existing = entities.get(key)
    if (existing && !identity.roomName && existing.identity.roomName) {
      identity.roomName = existing.identity.roomName
    }

    entities.set(key, {
      identity,
      state,
      activity: defaultActivity(event, state),
      updatedAt: event.at ?? now().toISOString(),
    })

    scheduleExpiry(key)
    broadcast()
  }

  function remove({ key, roomId, botId, state } = {}) {
    let deletedCount = 0
    const keysToDelete = []

    for (const [k, ent] of entities.entries()) {
      const pres = entityPresence(ent)
      const matchesKey = key ? k === key : true
      const matchesRoom = roomId ? ent.identity.roomId === roomId : true
      const matchesBot = botId ? ent.identity.botId === botId : true
      const matchesState = state ? pres.state === state : true

      if (matchesKey && matchesRoom && matchesBot && matchesState) {
        keysToDelete.push(k)
      }
    }

    for (const k of keysToDelete) {
      if (expiryTimers.has(k)) {
        clearTimeout(expiryTimers.get(k))
        expiryTimers.delete(k)
      }
      entities.delete(k)
      if (latestKey === k) latestKey = null
      deletedCount++
    }

    broadcast()
    return deletedCount
  }

  // GET /hermes-pets/<profile>/<slug>/<file>: read-only; every segment is validated, so no path traversal.
  async function servePet(pathname, response) {
    const [, , profile, slug, file, ...extra] = pathname.split('/')
    const contentType = PET_FILES[file]
    if (extra.length || !contentType || ![profile, slug].every((segment) => SAFE_SEGMENT.test(segment))) {
      response.writeHead(400).end()
      return
    }
    const profileHome = profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
    // The profile's own pets first, then the shared pets dir of the Hermes root.
    for (const home of [profileHome, hermesHome]) {
      try {
        const body = await readFile(join(home, 'pets', slug, file))
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' }).end(body)
        return
      } catch { /* try the next location */ }
    }
    response.writeHead(404).end()
  }

  // GET /hermes-avatars/<profile>/avatar.png: the profile's own avatar image.
  async function serveAvatar(pathname, response) {
    const [, , profile, file, ...extra] = pathname.split('/')
    if (extra.length || file !== 'avatar.png' || !SAFE_SEGMENT.test(profile)) {
      response.writeHead(400).end()
      return
    }
    const profileHome = profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
    try {
      const body = await readFile(join(profileHome, 'assets', file))
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/presence') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(getPresence()))
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/hermes-pets/')) {
      await servePet(url.pathname, response)
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/hermes-avatars/')) {
      await serveAvatar(url.pathname, response)
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
    if (request.method === 'DELETE' && url.pathname === '/presence') {
      const key = url.searchParams.get('key')
      const roomId = url.searchParams.get('roomId')
      const botId = url.searchParams.get('botId')
      const state = url.searchParams.get('state')
      const deleted = remove({ key, roomId, botId, state })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, deleted }))
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
    remove,
    listen(port = 8787) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    close() {
      for (const timer of expiryTimers.values()) clearTimeout(timer)
      expiryTimers.clear()
      clients.forEach((response) => response.end())
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
