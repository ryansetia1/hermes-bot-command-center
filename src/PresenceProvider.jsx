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

export function usePresence() {
  const presence = useContext(PresenceContext)
  if (presence === undefined) throw new Error('usePresence must be used inside PresenceProvider')
  return presence
}
