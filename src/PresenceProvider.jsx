import { createContext, useContext, useEffect, useState } from 'react'
import { createDefaultPublisher } from './presence.js'

const PresenceContext = createContext(null)
const publisher = createDefaultPublisher()

export function PresenceProvider({ children, source = publisher }) {
  const [presence, setPresence] = useState(() => source.getPresence())

  useEffect(() => {
    const sync = () => setPresence(source.getPresence())
    const unsubscribe = source.subscribe(sync)
    const interval = window.setInterval(sync, 1_000)
    return () => { unsubscribe(); window.clearInterval(interval) }
  }, [source])

  return <PresenceContext.Provider value={presence}>{children}</PresenceContext.Provider>
}

export function usePresence() {
  const presence = useContext(PresenceContext)
  if (!presence) throw new Error('usePresence must be used inside PresenceProvider')
  return presence
}
