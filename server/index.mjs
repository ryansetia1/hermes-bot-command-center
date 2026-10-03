import { createCollector } from './collector.mjs'

const collector = createCollector({ ttlMs: Number(process.env.PRESENCE_TTL_MS ?? 30_000) })
await collector.listen(Number(process.env.PRESENCE_PORT ?? 8787))
console.log(`Presence collector listening at ${collector.url}`)
