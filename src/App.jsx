import { useState } from 'react'
import { usePresence } from './PresenceProvider.jsx'

const stateCopy = {
  idle: { label: 'Idle', description: 'Ready for work', tone: 'idle' },
  working: { label: 'Working', description: 'Handling a task', tone: 'working' },
  speaking: { label: 'Speaking', description: 'Responding in room', tone: 'speaking' },
  error: { label: 'Error', description: 'Needs attention', tone: 'error' },
  unobserved: { label: 'Unobserved', description: 'Lifecycle signal is stale', tone: 'unobserved' },
}

const STATE_PRIORITY = {
  speaking: 1,
  working: 2,
  error: 3,
  idle: 4,
  unobserved: 5,
}

function secondsAgo(updatedAt) {
  if (!updatedAt) return 'No event received'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1_000))
  if (seconds < 60) return `Updated ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `Updated ${minutes}m ${seconds % 60}s ago`
}

function Pet({ pet, botId }) {
  const [failed, setFailed] = useState(false)
  if (failed || !pet?.url) {
    const initials = (botId || 'bot').slice(0, 2).toUpperCase()
    return <div className="pet-fallback" aria-label={`${botId} avatar`}>{initials}</div>
  }
  return (
    <img
      className="pet"
      src={pet.url}
      alt={`${pet.slug || botId} avatar`}
      onError={() => setFailed(true)}
    />
  )
}

function BotCard({ bot, onDismiss }) {
  const status = stateCopy[bot.state] || stateCopy.unobserved
  const stateIcon = bot.state === 'unobserved' ? '?' : '●'
  const key = `${bot.hostId}:${bot.roomId}:${bot.botId}`

  return (
    <article className="bot-card" aria-labelledby={`bot-${bot.botId}`}>
      <div className="card-top">
        <div className="card-top-left">
          <span className="contract">{bot.version || 'presence.v1'}</span>
          <span className="host">{bot.hostId}</span>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="btn-card-dismiss"
            onClick={() => onDismiss(key)}
            title="Dismiss bot"
            aria-label={`Dismiss ${bot.botId}`}
          >
            ×
          </button>
        )}
      </div>

      <div className="profile">
        <Pet pet={bot.pet} botId={bot.botId} />
        <div>
          <p className="kicker">BOT IDENTITY</p>
          <h3 id={`bot-${bot.botId}`}>{bot.botId}</h3>
          <p className="room">#{bot.roomId}</p>
        </div>
      </div>

      <div className={`state ${status.tone}`}>
        <span className="state-icon" aria-hidden="true">{stateIcon}</span>
        <div>
          <strong>{status.label}</strong>
          <span>{status.description}</span>
        </div>
      </div>

      <dl>
        <div>
          <dt>Last activity</dt>
          <dd>{bot.activity ?? '—'}</dd>
        </div>
        <div>
          <dt>Telemetry</dt>
          <dd>{secondsAgo(bot.updatedAt)}</dd>
        </div>
        {bot.reason && (
          <div className="reason">
            <dt>Why unobserved</dt>
            <dd>{bot.reason}</dd>
          </div>
        )}
      </dl>

      <footer>
        <span>pet/{bot.pet?.slug || 'unknown'}</span>
        <span>v{bot.pet?.version || '1.0.0'}</span>
      </footer>
    </article>
  )
}

function RoomSection({ roomId, bots, onDismissBot, onDismissRoom }) {
  // Sort bots: speaking first, working second, then error, idle, and unobserved
  const sortedBots = [...bots].sort((a, b) => {
    const prioA = STATE_PRIORITY[a.state] ?? 99
    const prioB = STATE_PRIORITY[b.state] ?? 99
    if (prioA !== prioB) return prioA - prioB
    const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
    const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
    if (timeA !== timeB) return timeB - timeA
    return (a.botId || '').localeCompare(b.botId || '')
  })

  const counts = {
    speaking: bots.filter((b) => b.state === 'speaking').length,
    working: bots.filter((b) => b.state === 'working').length,
    idle: bots.filter((b) => b.state === 'idle').length,
    error: bots.filter((b) => b.state === 'error').length,
    unobserved: bots.filter((b) => b.state === 'unobserved').length,
  }

  return (
    <section className="room-section" aria-labelledby={`room-title-${roomId}`}>
      <div className="room-summary">
        <div className="room-meta">
          <p className="kicker">ROOM</p>
          <h2 id={`room-title-${roomId}`}>#{roomId}</h2>
          <span className="room-total-badge">{bots.length} {bots.length === 1 ? 'bot' : 'bots'}</span>
        </div>
        <div className="room-pills">
          {counts.speaking > 0 && (
            <span className="pill pill-speaking">{counts.speaking} speaking</span>
          )}
          {counts.working > 0 && (
            <span className="pill pill-working">{counts.working} working</span>
          )}
          {counts.idle > 0 && (
            <span className="pill pill-idle">{counts.idle} idle</span>
          )}
          {counts.error > 0 && (
            <span className="pill pill-error">{counts.error} error</span>
          )}
          {counts.unobserved > 0 && (
            <span className="pill pill-unobserved">{counts.unobserved} unobserved</span>
          )}
          {onDismissRoom && (
            <button
              type="button"
              className="btn-room-clear"
              onClick={() => onDismissRoom(roomId)}
              title={`Clear all bots in #${roomId}`}
            >
              Clear Room
            </button>
          )}
        </div>
      </div>

      <div className="bot-grid">
        {sortedBots.map((bot) => (
          <BotCard
            key={`${bot.hostId}:${bot.roomId}:${bot.botId}`}
            bot={bot}
            onDismiss={onDismissBot}
          />
        ))}
      </div>
    </section>
  )
}

export default function App() {
  const presence = usePresence()
  const [dismissedKeys, setDismissedKeys] = useState(new Set())

  if (!presence) {
    return (
      <main className="shell">
        <p className="kicker">CONNECTING TO LOCAL COLLECTOR</p>
        <p className="intro">Waiting for presence telemetry…</p>
      </main>
    )
  }

  // Legacy slice compatibility: if entities array is absent or empty, check top-level presence
  const allEntities = Array.isArray(presence.entities) && presence.entities.length > 0
    ? presence.entities
    : (presence.botId ? [presence] : [])

  const rawEntities = allEntities.filter((b) => {
    const key = `${b.hostId}:${b.roomId}:${b.botId}`
    if (dismissedKeys.has(key)) return false
    // Filter out stale test artifact: default bot in build-room when unobserved
    if (b.roomId === 'build-room' && b.botId === 'default' && b.state === 'unobserved') return false
    return true
  })

  const handleDismissBot = (key) => {
    setDismissedKeys((prev) => new Set([...prev, key]))
    fetch(`/presence?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {})
  }

  const handleDismissRoom = (roomId) => {
    const keysInRoom = rawEntities
      .filter((b) => (b.roomId || 'default-room') === roomId)
      .map((b) => `${b.hostId}:${b.roomId}:${b.botId}`)
    setDismissedKeys((prev) => new Set([...prev, ...keysInRoom]))
    fetch(`/presence?roomId=${encodeURIComponent(roomId)}`, { method: 'DELETE' }).catch(() => {})
  }

  const handleClearAllUnobserved = () => {
    const unobservedKeys = rawEntities
      .filter((b) => b.state === 'unobserved')
      .map((b) => `${b.hostId}:${b.roomId}:${b.botId}`)
    setDismissedKeys((prev) => new Set([...prev, ...unobservedKeys]))
    fetch('/presence?state=unobserved', { method: 'DELETE' }).catch(() => {})
  }

  if (rawEntities.length === 0) {
    return (
      <main className="shell">
        <header>
          <p className="kicker">LOCAL · MULTI-ROOM</p>
          <h1>Hermes Bot<br /><em>Command Center</em></h1>
          <p className="intro">Live lifecycle telemetry for bots operating in Hermes Rooms.</p>
        </header>
        <section className="empty-card">
          <p className="kicker">PRESENCE UNAVAILABLE</p>
          <p className="intro">{presence.reason || 'No native lifecycle events recorded.'}</p>
        </section>
      </main>
    )
  }

  // Group entities by roomId
  const roomsMap = new Map()
  for (const entity of rawEntities) {
    const roomId = entity.roomId || 'default-room'
    if (!roomsMap.has(roomId)) roomsMap.set(roomId, [])
    roomsMap.get(roomId).push(entity)
  }

  // Sort rooms by priority of contained bots: speaking/working rooms first
  const sortedRooms = Array.from(roomsMap.entries()).sort(([roomA, botsA], [roomB, botsB]) => {
    const minPrioA = Math.min(...botsA.map((b) => STATE_PRIORITY[b.state] ?? 99))
    const minPrioB = Math.min(...botsB.map((b) => STATE_PRIORITY[b.state] ?? 99))
    if (minPrioA !== minPrioB) return minPrioA - minPrioB
    return roomA.localeCompare(roomB)
  })

  const primaryHost = presence.hostId || rawEntities[0]?.hostId || 'default'
  const totalBots = rawEntities.length
  const activeBots = rawEntities.filter((b) => b.state === 'speaking' || b.state === 'working').length
  const unobservedBots = rawEntities.filter((b) => b.state === 'unobserved').length

  return (
    <main className="shell">
      <header className="main-header">
        <div>
          <p className="kicker">LOCAL · MULTI-ROOM</p>
          <h1>Hermes Bot<br /><em>Command Center</em></h1>
          <p className="intro">Live lifecycle telemetry for bots operating in Hermes Rooms.</p>
        </div>
        <div className="host-badge-bar">
          <div className="metric">
            <span className="metric-label">HOST</span>
            <strong className="metric-val">{primaryHost}</strong>
          </div>
          <div className="metric">
            <span className="metric-label">ROOMS</span>
            <strong className="metric-val">{sortedRooms.length}</strong>
          </div>
          <div className="metric">
            <span className="metric-label">BOTS</span>
            <strong className="metric-val">{totalBots}</strong>
          </div>
          <div className="metric">
            <span className="metric-label">ACTIVE</span>
            <strong className="metric-val metric-active">{activeBots}</strong>
          </div>
          {unobservedBots > 0 && (
            <button
              type="button"
              className="btn-header-clean"
              onClick={handleClearAllUnobserved}
              title="Clear all stale unobserved bots"
            >
              Clear Stale ({unobservedBots})
            </button>
          )}
        </div>
      </header>

      <div className="rooms-container">
        {sortedRooms.map(([roomId, bots]) => (
          <RoomSection
            key={roomId}
            roomId={roomId}
            bots={bots}
            onDismissBot={handleDismissBot}
            onDismissRoom={handleDismissRoom}
          />
        ))}
      </div>

      <p className="footnote">
        Published from native gateway, LLM, and tool lifecycle events — never UI scraping or synthetic heartbeats.
      </p>
    </main>
  )
}
