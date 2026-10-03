import { useCallback, useEffect, useRef, useState } from 'react'
import { usePresence, useRoomMessages, useRoster } from './PresenceProvider.jsx'
import { DIRECT_ROOM_ID, deriveRooms, mergeRoster } from './rooms.js'
import { isUnread, useReadMarks } from './readMarks.js'
import { isSheet, petSrc, sheetRow } from './petSprite.js'
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

function Pet({ pet, botId, state }) {
  const src = pet?.url ? petSrc(pet) : null
  const [failedSrc, setFailedSrc] = useState(null)
  if (!src || failedSrc === src) {
    const initials = (botId || 'bot').slice(0, 2).toUpperCase()
    return <div className="pet-fallback" aria-label={`${botId} avatar`}>{initials}</div>
  }
  if (isSheet(pet)) {
    return (
      <>
        <div
          className={`pet-sheet${state === 'unobserved' ? ' pet-static' : ''}`}
          role="img"
          aria-label={`${pet.slug || botId} avatar`}
          style={{ backgroundImage: `url("${src}")`, '--row': sheetRow(state) }}
        />
        <img className="pet-probe" src={src} alt="" onError={() => setFailedSrc(src)} />
      </>
    )
  }
  return (
    <img
      className="pet"
      src={src}
      alt={`${pet.slug || botId} avatar`}
      onError={() => setFailedSrc(src)}
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
          <Pet key={`${bot.hostId}:${bot.botId}`} pet={bot.pet} botId={bot.botId} state={bot.state} />
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

const botKey = (bot) => `${bot.hostId}:${bot.roomId}:${bot.botId}`

function Sprite({ bot, spot, unread, onSelect }) {
  const status = stateCopy[bot.state] || stateCopy.unobserved
  const key = botKey(bot)
  const typing = bot.state === 'working' || bot.state === 'speaking'
  const [position, setPosition] = useState({ ...spot, flip: false })
  const positionRef = useRef(position)
  positionRef.current = position
  // A bot with an unread reply stays put so it is easy to click; it resumes wandering once read.
  const wanders = bot.state === 'idle' && !unread

  useEffect(() => {
    if (!wanders || prefersReducedMotion()) return undefined
    const timer = setInterval(() => {
      const target = wanderTarget()
      setPosition({ ...target, flip: target.x < positionRef.current.x })
    }, WANDER_MS + Math.random() * 2_000)
    return () => clearInterval(timer)
  }, [wanders])

  return (
    <div className={`sprite ${status.tone}`} style={{ left: `${position.x}%`, top: `${position.y}%` }}>
      {typing && <span className="typing-bubble" aria-hidden="true"><i /><i /><i /></span>}
      {unread && <span className="unread-badge" aria-hidden="true">✉</span>}
      <button
        type="button"
        className="sprite-btn"
        data-key={key}
        aria-label={`${bot.botId}: ${status.label}${typing ? ', typing' : ''}${unread ? ', unread message' : ''}`}
        onClick={() => onSelect(key)}
      >
        <span className={`sprite-body${position.flip ? ' flipped' : ''}`}>
          <Pet pet={bot.pet} botId={bot.botId} state={bot.state} />
        </span>
      </button>
    </div>
  )
}

const clockTime = (at) => (Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

// Read-only room history; every value renders as a text node (React escapes it), never as HTML.
function RoomSidebar({ roomId }) {
  const { messages, failed } = useRoomMessages(roomId, true)
  const listRef = useRef(null)
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])
  return (
    <aside className="room-sidebar" id={`room-sidebar-${roomId}`} aria-label="Room messages">
      <ol className="room-log" ref={listRef} tabIndex={0} aria-label="Messages, oldest first">
        {messages.map((message) => (
          <li key={message.id} className={`log-entry log-${message.from.kind}`}>
            <span className="log-head"><strong>{message.from.name || message.from.kind || 'unknown'}</strong> <time>{clockTime(message.at)}</time></span>
            <span className="log-text">{message.text}</span>
          </li>
        ))}
      </ol>
      {messages.length === 0 && <p className="intro">{failed ? 'No history available for this room.' : 'No messages yet.'}</p>}
    </aside>
  )
}

function Dialog({ bot, onClose }) {
  const status = stateCopy[bot.state] || stateCopy.unobserved
  const closeRef = useRef(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="vn-dialog" role="dialog" aria-label={`${bot.botId} message`}>
      <div className="vn-portrait"><Pet pet={bot.pet} botId={bot.botId} state={bot.state} /></div>
      <div className="vn-head">
        <span className="vn-name">{bot.botId}</span>
        <span className={`pill pill-${status.tone}`}>{status.label}</span>
        <span className="vn-age">{secondsAgo(bot.updatedAt)}</span>
        <button type="button" className="vn-btn" ref={closeRef} onClick={onClose} aria-label="Close dialog">×</button>
      </div>
      <p className="vn-text">{bot.message ?? `No message yet. ${bot.activity ?? ''}`}</p>
      {bot.message && bot.reason && <p className="vn-age">{bot.reason}</p>}
      {/* ponytail: sending is disabled; no supported route into a Hermes group room exists (see issue #18 spike). */}
      <textarea className="vn-input" disabled rows={1} aria-label={`Message ${bot.botId}`} aria-describedby="vn-send-note" placeholder="Sending is not available yet" />
      <p className="vn-age" id="vn-send-note">Read-only: Hermes has no supported way to post into a group room from outside the desktop app.</p>
    </div>
  )
}

function RoomScene({ roomId, roomName, bots, readMarks, onRead, onDismissRoom }) {
  const [openKey, setOpenKey] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const floorRef = useRef(null)
  const openKeyRef = useRef(null)
  openKeyRef.current = openKey ?? openKeyRef.current
  const sortedBots = [...bots].sort((a, b) => {
    const prioA = STATE_PRIORITY[a.state] ?? 99
    const prioB = STATE_PRIORITY[b.state] ?? 99
    if (prioA !== prioB) return prioA - prioB
    return (a.botId || '').localeCompare(b.botId || '')
  })
  const spots = spreadPositions(sortedBots.length)
  const openBot = bots.find((bot) => botKey(bot) === openKey)
  const openMessageAt = openBot?.messageAt

  // Opening, and any new message while open, counts as read.
  useEffect(() => {
    if (openKey && openMessageAt) onRead(openKey, openMessageAt)
  }, [openKey, openMessageAt, onRead])

  const closeDialog = useCallback(() => {
    setOpenKey(null)
    // The sprite that opened the dialog gets focus back once the dialog is gone.
    requestAnimationFrame(() => floorRef.current?.querySelector(`[data-key="${CSS.escape(openKeyRef.current)}"]`)?.focus())
  }, [])
  const displayName = roomName || (roomId === DIRECT_ROOM_ID ? '1o1 room' : roomId)

  return (
    <section className="room-scene" aria-labelledby={`room-title-${roomId}`}>
      <div className="room-summary">
        <div className="room-meta">
          <p className="kicker">{roomId === DIRECT_ROOM_ID ? '1O1 ROOM' : 'ROOM'}</p>
          <h2 id={`room-title-${roomId}`}>{displayName}</h2>
          <span className="room-total-badge">{bots.length} {bots.length === 1 ? 'bot' : 'bots'}</span>
        </div>
        {roomId !== DIRECT_ROOM_ID && (
          <button
            type="button"
            className="btn-room-clear"
            aria-expanded={sidebarOpen}
            aria-controls={`room-sidebar-${roomId}`}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? 'Hide messages' : 'Show messages'}
          </button>
        )}
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
      <div className={`room-body${sidebarOpen ? ' with-sidebar' : ''}`}>
      <div className="scene-floor" ref={floorRef}>
        {openBot && <div className="vn-backdrop" onClick={closeDialog} />}
        {sortedBots.map((bot, i) => (
          <Sprite
            key={botKey(bot)}
            bot={bot}
            spot={spots[i]}
            unread={isUnread(bot.messageAt, readMarks[botKey(bot)])}
            onSelect={setOpenKey}
          />
        ))}
        {openBot && (
          <Dialog bot={openBot} onClose={closeDialog} />
        )}
      </div>
      {sidebarOpen && <RoomSidebar roomId={roomId} />}
      </div>
    </section>
  )
}

export default function App() {
  const presence = usePresence()
  const roster = useRoster()
  const [dismissedKeys, setDismissedKeys] = useState(new Set())
  const [selected, setSelected] = useState(null)
  const [readMarks, markRead] = useReadMarks()

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

  const rawEntities = mergeRoster(allEntities, roster).filter((b) => {
    const key = `${b.hostId}:${b.roomId}:${b.botId}`
    if (dismissedKeys.has(key)) return false
    // Filter out stale test artifact: default bot in build-room when unobserved
    if (b.roomId === 'build-room' && b.botId === 'default' && b.state === 'unobserved') return false
    return true
  })

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
            readMarks={readMarks}
            onRead={markRead}
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
