# ADR-008: Multi-Node Coordinator Dispatch with Dual-Endpoint Health Polling

**Status:** Accepted
**Date:** 2026-03-01
**Deciders:** Nicolas Myers

---

## Context

BCOM-C needs a central orchestration view that can dispatch datagen runs to either node (SPARK-BOB or LINUX-DSKTP), monitor live job queues, track node health, and provide one-click cancel. The two nodes expose different health endpoints:

- `GET /api/system/stats` — SPARK-BOB (DGX Spark): GPU/VRAM/CPU/RAM
- `GET /api/system/linux/stats` — LINUX-DSKTP: CPU/RAM only (no GPU)

The question is how to poll these in a single-page coordinator without overloading the API or coupling health state to run-list state.

Options considered:
1. **Single unified poll** — one interval fetches runs + both node stats together
2. **Separate intervals per concern** — runs and queue on one cadence, node stats on another
3. **SSE for node health** — push-based health stream from each node

## Decision

Use **separate polling intervals** for node health vs. run data:

- Node health: `setInterval(pollNodeStats, 8000)` — both endpoints in one async call, results applied independently
- Run list + queue: `setInterval(pollRuns, 6000)` + `setInterval(pollQueue, 6000)` — separate to keep concerns isolated
- Node cards degrade gracefully: if a node endpoint returns non-200, the card enters `OFFLINE` state with dimmed metrics
- Dispatch form supports `queued` mode (passes `queued: true` to `POST /api/runs`) to allow background queue accumulation
- Multi-worker dispatch loops `POST /api/runs` N times with a 300ms stagger to avoid API thundering-herd

## Rationale

- Health data changes slower than run state — 8s vs 6s cadence reduces unnecessary re-renders on the node cards
- Independent error handling: a dead Linux node shouldn't break run-list polling
- No SSE for health: the `/api/system/*` endpoints are request/response; no stream is available
- Staggered multi-worker dispatch is compatible with the BobSpark-APIs queue without requiring batch endpoint support

## Consequences

- `coordinator.html` owns two poll timers (node stats) + two poll timers (runs + queue) — all cleared on `beforeunload`
- Node health cards show CPU/GPU/VRAM/RAM as labelled mini-bars with warn (≥70%) and crit (≥90%) color states
- Dispatch form validates workers (1–18), model, and task text before any POST
- Cancel individual runs via `DELETE /api/runs/{id}`; Cancel All Queued loops the queue list
- All run rows link to `datagen-run.html?id=<id>` (per ADR-007 URL-param routing pattern)
