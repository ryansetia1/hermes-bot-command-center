/**
 * Replays lifecycle telemetry for four rooms on host 'default' to verify multi-entity UI.
 * Usage: node scripts/replay-four-rooms.mjs [collectorUrl]
 */

const targetUrl = process.argv[2] || process.env.PRESENCE_COLLECTOR_URL || 'http://127.0.0.1:8787/observe'

const now = Date.now()
const hostId = 'default'

const events = [
  // Room 1: build-room (2 bots: 1 speaking, 1 working)
  {
    hostId,
    roomId: 'build-room',
    botId: 'vega-the-engineer',
    pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
    source: 'tool',
    type: 'started',
    activity: 'Compiling TypeScript and bundling assets',
    at: new Date(now - 8_000).toISOString(),
  },
  {
    hostId,
    roomId: 'build-room',
    botId: 'artisan-bot',
    pet: { slug: 'atlas', version: '2.1.0', url: '/pets/atlas-v1.png' },
    source: 'llm',
    type: 'speaking',
    activity: 'Broadcasting build pass notification to chat',
    at: new Date(now - 3_000).toISOString(),
  },

  // Room 2: qa-lab (1 bot: working)
  {
    hostId,
    roomId: 'qa-lab',
    botId: 'orion-the-tester',
    pet: { slug: 'vega', version: '1.2.0', url: '/pets/vega-v1.svg' },
    source: 'tool',
    type: 'started',
    activity: 'Running Vitest and e2e integration test suite',
    at: new Date(now - 12_000).toISOString(),
  },

  // Room 3: triage-hub (2 bots: 1 idle, 1 unobserved via past timestamp)
  {
    hostId,
    roomId: 'triage-hub',
    botId: 'atlas-triage',
    pet: { slug: 'atlas', version: '2.1.0', url: '/pets/atlas-v1.png' },
    source: 'tool',
    type: 'completed',
    activity: 'Waiting for incoming incident reports',
    at: new Date(now - 15_000).toISOString(),
  },
  {
    hostId,
    roomId: 'triage-hub',
    botId: 'ghost-monitor',
    pet: { slug: 'vega', version: '0.9.0', url: '/pets/vega-v1.svg' },
    source: 'gateway',
    type: 'received',
    activity: 'Last heartbeat before network partition',
    at: new Date(now - 45_000).toISOString(), // > 30s TTL -> honest unobserved
  },

  // Room 4: ops-cockpit (2 bots: 1 speaking, 1 error)
  {
    hostId,
    roomId: 'ops-cockpit',
    botId: 'nova-deployer',
    pet: { slug: 'atlas', version: '3.0.0', url: '/pets/atlas-v1.png' },
    source: 'llm',
    type: 'speaking',
    activity: 'Streaming canary rollout status to Slack',
    at: new Date(now - 2_000).toISOString(),
  },
  {
    hostId,
    roomId: 'ops-cockpit',
    botId: 'sentinel-guard',
    pet: { slug: 'vega', version: '1.0.0', url: '/pets/vega-v1.svg' },
    source: 'tool',
    type: 'failed',
    activity: 'Connection timeout contacting secondary database',
    at: new Date(now - 10_000).toISOString(),
  },
]

async function run() {
  console.log(`Sending ${events.length} replay events for 4 rooms on host '${hostId}' to ${targetUrl}...`)
  for (const event of events) {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    })
    console.log(`  [${event.roomId}] ${event.botId}: HTTP ${res.status}`)
  }
  console.log('Replay completed successfully.')
}

run().catch((err) => {
  console.error('Replay failed:', err)
  process.exit(1)
})
