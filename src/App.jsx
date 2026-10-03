import { useState } from 'react'
import { usePresence } from './PresenceProvider.jsx'

const stateCopy = {
  idle: { label: 'Idle', description: 'Ready for work', tone: 'idle' },
  working: { label: 'Working', description: 'Handling a task', tone: 'working' },
  speaking: { label: 'Speaking', description: 'Responding in room', tone: 'speaking' },
  error: { label: 'Error', description: 'Needs attention', tone: 'error' },
  unobserved: { label: 'Unobserved', description: 'Lifecycle signal is stale', tone: 'unobserved' },
}

function secondsAgo(updatedAt) {
  if (!updatedAt) return 'No event received'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1_000))
  return `Updated ${seconds} sec ago`
}

function Pet({ pet, botId }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <div className="pet-fallback" aria-label={`${botId} pet fallback`}>{botId.slice(0, 2).toUpperCase()}</div>
  return <img className="pet" src={pet.url} alt={`${pet.slug} pet`} onError={() => setFailed(true)} />
}

export default function App() {
  const presence = usePresence()
  const status = stateCopy[presence.state]

  return <main className="shell">
    <header><p className="kicker">LOCAL · MULTI-DEVICE READY</p><h1>Hermes Bot<br /><em>Command Center</em></h1><p className="intro">Live lifecycle telemetry for bots operating in Hermes Rooms.</p></header>
    <section className="activity-card" aria-labelledby="bot-name">
      <div className="card-top"><span className="contract">presence.v1</span><span className="host">{presence.hostId}</span></div>
      <div className="profile"><Pet pet={presence.pet} botId={presence.botId} /><div><p className="kicker">BOT ACTIVITY</p><h2 id="bot-name">{presence.botId}</h2><p className="room">#{presence.roomId}</p></div></div>
      <div className={`state ${status.tone}`}><span className="state-icon" aria-hidden="true">{presence.state === 'unobserved' ? '?' : '●'}</span><div><strong>{status.label}</strong><span>{status.description}</span></div></div>
      <dl><div><dt>Last activity</dt><dd>{presence.activity ?? '—'}</dd></div><div><dt>Telemetry</dt><dd>{secondsAgo(presence.updatedAt)}</dd></div>{presence.reason && <div className="reason"><dt>Why unobserved</dt><dd>{presence.reason}</dd></div>}</dl>
      <footer><span>pet/{presence.pet.slug}</span><span>v{presence.pet.version}</span></footer>
    </section>
    <p className="footnote">Published from native gateway, LLM, and tool lifecycle events — never UI scraping or synthetic heartbeats.</p>
  </main>
}
