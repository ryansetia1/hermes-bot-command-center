import { createContext, useContext, useEffect, useState } from 'react'

const PresenceContext = createContext(undefined)

export function PresenceProvider({ children }) {
  const [presence, setPresence] = useState(null)

  useEffect(() => {
    let active = true
    fetch('/presence')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Presence collector unavailable')))
      .then((snapshot) => active && setPresence(snapshot))
      .catch(() => active && setPresence({ state: 'unobserved', reason: 'Presence collector unavailable.' }))

    const stream = new EventSource('/events')
    stream.addEventListener('presence', (event) => active && setPresence(JSON.parse(event.data)))
    return () => { active = false; stream.close() }
  }, [])

  return <PresenceContext.Provider value={presence}>{children}</PresenceContext.Provider>
}

// Hermes roster is read once on mount; a failed fetch just means no seeded tiles.
export function useRoster() {
  const [roster, setRoster] = useState({ rooms: [], bots: [] })
  useEffect(() => {
    let active = true
    fetch('/roster').then((response) => response.ok ? response.json() : Promise.reject(new Error('Roster unavailable'))).then((data) => active && setRoster(data)).catch(() => {})
    return () => { active = false }
  }, [])
  return roster
}

// Room chat history from the read-only collector endpoint; the caller mounts it only while the sidebar is open.
const MESSAGES_POLL_MS = 4_000
export function useRoomMessages(roomId) {
  const [state, setState] = useState({ roomId: null, messages: [], failed: false })
  useEffect(() => {
    let active = true
    const load = () => fetch(`/rooms/${encodeURIComponent(roomId)}/messages?limit=100`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('History unavailable')))
      .then((data) => active && setState({ roomId, messages: data.messages, failed: false }))
      .catch(() => active && setState((prev) => ({ roomId, messages: prev.roomId === roomId ? prev.messages : [], failed: true })))
    load()
    const timer = setInterval(load, MESSAGES_POLL_MS)
    return () => { active = false; clearInterval(timer) }
  }, [roomId])
  return state.roomId === roomId ? state : { roomId, messages: [], failed: false }
}

export function usePresence() {
  const presence = useContext(PresenceContext)
  if (presence === undefined) throw new Error('usePresence must be used inside PresenceProvider')
  return presence
}
