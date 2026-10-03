import { createCollector } from './collector.mjs'

const identity = {
  hostId: process.env.PRESENCE_HOST_ID ?? 'macbook-ryan',
  roomId: process.env.PRESENCE_ROOM_ID ?? 'build-room',
  botId: process.env.PRESENCE_BOT_ID ?? 'vega-the-engineer',
  pet: {
    slug: process.env.PRESENCE_PET_SLUG ?? 'vega',
    version: process.env.PRESENCE_PET_VERSION ?? '1.0.0',
    url: process.env.PRESENCE_PET_URL ?? '/pets/vega-v1.svg',
  },
}

const collector = createCollector({ identity, ttlMs: Number(process.env.PRESENCE_TTL_MS ?? 30_000) })
await collector.listen(Number(process.env.PRESENCE_PORT ?? 8787))
console.log(`Presence collector listening at ${collector.url}`)
