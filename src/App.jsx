import { useEffect, useRef, useState } from 'react'
import { usePresence } from './PresenceProvider.jsx'
import { DIRECT_ROOM_ID, deriveRooms } from './rooms.js'
import { spreadPositions, wanderTarget } from './wander.js'

const WANDER_MS = 4_000
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

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

const PILL_STATES = ['speaking', 'working', 'idle', 'error', 'unobserved']

function RoomTile({ room, onOpen }) {
  return (
    <button type="button" className="room-tile" onClick={() => onOpen(room)}>
      <span className="room-tile-name">{room.roomName}</span>
      <span className="room-tile-members">
        {room.bots.map((bot) => (
          <Pet key={`${bot.hostId}:${bot.botId}`} pet={bot.pet} botId={bot.botId} />
        ))}
      </span>
      <span className="room-pills">
        {PILL_STATES.map((state) => {
          const count = room.bots.filter((b) => b.state === state).length
          return count > 0 && <span key={state} className={`pill pill-${state}`}>{count} {state}</span>
        })}
      </span>
    </button>
  )
}

function LobbySection({ title, rooms, onOpen, emptyText }) {
  return (
    <section className="lobby-section">
      <h2 className="lobby-title">{title}</h2>
      {rooms.length === 0 ? (
        <p className="intro">{emptyText}</p>
      ) : (
        <div className="room-tile-grid">
          {rooms.map((room) => (
            <RoomTile key={room.id} room={room} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  )
}

function Sprite({ bot, spot, onDismiss, onSelect }) {
  const status = stateCopy[bot.state] || stateCopy.unobserved
  const key = `${bot.hostId}:${bot.roomId}:${bot.botId}`
  const [position, setPosition] = useState({ ...spot, flip: false })
  const positionRef = useRef(position)
  positionRef.current = position
  const idle = bot.state === 'idle'

  useEffect(() => {
    if (!idle || prefersReducedMotion()) return undefined
    const timer = setInterval(() => {
      const target = wanderTarget()
      setPosition({ ...target, flip: target.x < positionRef.current.x })
    }, WANDER_MS + Math.random() * 2_000)
    return () => clearInterval(timer)
  }, [idle])

  return (
    <div className={`sprite ${status.tone}`} style={{ left: `${position.x}%`, top: `${position.y}%` }}>
      <button
        type="button"
        className="sprite-btn"
        aria-label={`${bot.botId}: ${status.label}`}
        onClick={() => onSelect?.(key)}
      >
        <span className="sprite-body" style={position.flip ? { transform: 'scaleX(-1)' } : undefined}>
          <Pet pet={bot.pet} botId={bot.botId} />
        </span>
      </button>
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
  )
}

function RoomScene({ roomId, roomName, bots, onDismissBot, onDismissRoom }) {
  const sortedBots = [...bots].sort((a, b) => {
    const prioA = STATE_PRIORITY[a.state] ?? 99
    const prioB = STATE_PRIORITY[b.state] ?? 99
    if (prioA !== prioB) return prioA - prioB
    return (a.botId || '').localeCompare(b.botId || '')
  })
  const spots = spreadPositions(sortedBots.length)
  const displayName = roomName || (roomId === DIRECT_ROOM_ID ? '1o1 room' : roomId)

  return (
    <section className="room-scene" aria-labelledby={`room-title-${roomId}`}>
      <div className="room-summary">
        <div className="room-meta">
          <p className="kicker">{roomId === DIRECT_ROOM_ID ? '1O1 ROOM' : 'ROOM'}</p>
          <h2 id={`room-title-${roomId}`}>{displayName}</h2>
          <span className="room-total-badge">{bots.length} {bots.length === 1 ? 'bot' : 'bots'}</span>
        </div>
        {onDismissRoom && (
          <button
            type="button"
            className="btn-room-clear"
            onClick={() => onDismissRoom(roomId)}
            title={`Clear all bots in ${displayName}`}
          >
            Clear Room
          </button>
        )}
      </div>
      <div className="scene-floor">
        {sortedBots.map((bot, i) => (
          <Sprite key={`${bot.hostId}:${bot.roomId}:${bot.botId}`} bot={bot} spot={spots[i]} onDismiss={onDismissBot} />
        ))}
      </div>
    </section>
  )
}

export default function App() {
  const presence = usePresence()
  const [dismissedKeys, setDismissedKeys] = useState(new Set())
  const [selected, setSelected] = useState(null)

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

  // Rooms with speaking/working bots first
  const byPriority = (roomA, roomB) => {
    const minPrioA = Math.min(...roomA.bots.map((b) => STATE_PRIORITY[b.state] ?? 99))
    const minPrioB = Math.min(...roomB.bots.map((b) => STATE_PRIORITY[b.state] ?? 99))
    if (minPrioA !== minPrioB) return minPrioA - minPrioB
    return roomA.roomName.localeCompare(roomB.roomName)
  }
  const derived = deriveRooms(rawEntities)
  const groupRooms = derived.groupRooms.sort(byPriority)
  const oneOnOneRooms = derived.oneOnOneRooms.sort(byPriority)
  const openRoom = (room) => setSelected(room.id)
  const selectedRoom = selected && [...groupRooms, ...oneOnOneRooms].find((r) => r.id === selected)

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
            <strong className="metric-val">{groupRooms.length + oneOnOneRooms.length}</strong>
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

      {selectedRoom ? (
        <div className="rooms-container">
          <button type="button" className="btn-back" onClick={() => setSelected(null)}>
            ← Back to lobby
          </button>
          <RoomScene
            roomId={selectedRoom.roomId}
            roomName={selectedRoom.roomName}
            bots={selectedRoom.bots}
            onDismissBot={handleDismissBot}
            onDismissRoom={selectedRoom.roomId === DIRECT_ROOM_ID ? undefined : handleDismissRoom}
          />
        </div>
      ) : (
        <div className="lobby">
          <LobbySection
            title="Group chat rooms"
            rooms={groupRooms}
            onOpen={openRoom}
            emptyText="No group chat rooms yet."
          />
          <LobbySection
            title="1o1 rooms"
            rooms={oneOnOneRooms}
            onOpen={openRoom}
            emptyText="No 1o1 rooms yet."
          />
          <section className="lobby-section">
            <h2 className="lobby-title">Discord &amp; Telegram</h2>
            <div className="room-tile coming-soon" aria-disabled="true">
              <span className="room-tile-name">Coming soon</span>
              <span className="intro">Discord and Telegram rooms will appear here.</span>
            </div>
          </section>
        </div>
      )}

      <p className="footnote">
        Published from native gateway, LLM, and tool lifecycle events — never UI scraping or synthetic heartbeats.
      </p>
    </main>
  )
}
