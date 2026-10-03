# CLAUDE.md

Guidelines for working with `hermes-bot-command-center`.

## Project Overview
Local MVP command center to monitor a Hermes bot via `presence.v1` telemetry.
- **Frontend**: Vite + React single-bot command center card.
- **Backend / Collector**: Node.js collector server receiving `/observe` HTTP POSTs and serving SSE `/events` & `/presence`.
- **Publisher Plugin**: Python Hermes plugin (`hermes_plugin/presence_publisher`) publishing lifecycle hooks to the collector.

## Common Commands
- `npm test`: Run backend/collector Vitest test suite (`vitest run`).
- `python3 -m unittest hermes_plugin.presence_publisher.test_publisher`: Run Python publisher unit tests.
- `npm run build`: Vite build check.
- `npm run dev`: Start Vite dev server.
- `npm run collector`: Start Node.js presence collector server.

## Code & Architecture Principles
- Keep changes minimal and focused (YAGNI / Ponytail).
- Clean Code: intention-revealing names, single responsibility, clean error handling.
- Presence contract (`presence.v1`): `hostId`, `roomId`, `botId`, `state`, `activity`, `updatedAt`, `pet { slug, version, url }`, `reason`.
- Publisher sends identity with every event; collector validates identity and stores state in-memory.
