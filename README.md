# Hermes Bot Command Center

A local vertical slice for observing one Hermes bot via **presence.v1** telemetry.

## What it proves

- A lifecycle-native publisher accepts gateway, LLM, and tool events—no UI scraping or fabricated heartbeats.
- `presence.v1` carries `hostId`, `roomId`, `botId`, `state`, `activity`, `updatedAt`, `pet { slug, version, url }`, and an unobserved reason.
- After the TTL expires, the publisher returns `unobserved`, never a misleading `idle` state.
- The dashboard renders one profile-aware Bot Activity Card and falls back to bot initials if the versioned pet asset cannot load.

## Run

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
npm run build
```

The current `createDefaultPublisher()` is a local adapter. A per-host publisher/central collector can replace that source without changing the card’s `presence.v1` contract.
