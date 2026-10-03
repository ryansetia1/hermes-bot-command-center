# CLAUDE.md

Guidelines for working with `hermes-bot-command-center`.

## Project Overview
Local command center to monitor Hermes bots via `presence.v1` telemetry.
- **Frontend**: Vite + React command center with per-room hierarchy, room summaries, and prioritized bot cards.
- **Backend / Collector**: Node.js collector server receiving `/observe` HTTP POSTs and serving SSE `/events` & `/presence` with multi-entity snapshots keyed by `hostId + roomId + botId` and independent entity TTLs.
- **Publisher Plugin**: Python Hermes plugin (`hermes_plugin/presence_publisher`) publishing lifecycle hooks to the collector.

## Common Commands
- `npm run dashboard`: Start both local presence collector and Vite dashboard in one command.
- `npm run dev`: Start Vite dev server only.
- `npm run collector`: Start Node.js presence collector server only.
- `npm test`: Run backend/collector Vitest test suite (`vitest run`).
- `python3 -m unittest hermes_plugin.presence_publisher.test_publisher`: Run Python publisher unit tests.
- `npm run build`: Vite build check.
- `node scripts/replay-four-rooms.mjs`: Replay 4-room telemetry on host default to verify UI.

## Code & Architecture Principles
- Keep changes minimal and focused (YAGNI / Ponytail).
- Clean Code: intention-revealing names, single responsibility, clean error handling.
- Presence contract (`presence.v1`): `hostId`, `roomId`, `botId`, `state`, `activity`, `updatedAt`, `pet { slug, version, url }`, `reason`.
- Publisher sends identity with every event; collector validates identity and stores state in-memory.
