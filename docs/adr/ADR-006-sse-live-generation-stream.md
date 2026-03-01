# ADR-006: SSE Live Generation Stream + Feed via BobSpark-APIs Run Endpoints

**Status:** Accepted
**Date:** 2026-03-01
**Deciders:** Nicolas Myers

---

## Context

The Data Gen page needed two new live capabilities:

1. **Live worker cards** — while a datagen run is in progress, the UI should show per-worker token throughput (tok/s), current agent, iteration count, and a partial text snippet as the model generates.
2. **Generation feed** — a scrollable history of completed runs with a summary snippet and the ability to inspect the full reasoning/event chain for each run.

BobSpark-APIs (FastAPI on DGX Spark, `10.0.0.69:9010`) already exposes:
- `POST /api/runs` — submit a run (inline or queued)
- `GET /api/runs/{run_id}/stream` — SSE endpoint emitting `node_update`, `status`, `stream_end`, `error`
- `GET /api/runs?limit=N` — paginated run list
- `GET /api/runs/{run_id}` — full run detail including all stored events

Ross's reference dashboard used a dedicated `/api/datagen/monitor/qa` endpoint that does not exist in BobSpark-APIs.

---

## Decision

### Live Stream: SSE (EventSource) per worker card

Use the browser `EventSource` API connecting to `/api/runs/{run_id}/stream` for each active worker. One `EventSource` per run, closed on `stream_end` or error.

**Rejected alternative — polling:** Polling `/api/runs/{run_id}` on an interval would add latency and unnecessary server load. SSE is already implemented server-side and is the correct mechanism here.

### tok/s: EMA on delta of `tokens_out`

Each `node_update` event carries a cumulative `tokens_out`. tok/s is computed as an exponential moving average (α=0.3) over the delta between consecutive events, gated on `dt > 100ms` to avoid division by near-zero:

```js
const instant = dTokens / dt;
w.tokPerSec = w.tokPerSec === 0 ? instant : (0.3 * instant + 0.7 * w.tokPerSec);
```

This smooths bursty token delivery without lagging the display significantly.

### Batch workers: staggered launch

Up to 18 workers can be launched simultaneously. Workers are staggered with a 300ms delay between `POST /api/runs` calls to avoid hammering the API with concurrent submits. All workers share the same task string; the API assigns independent `run_id` values.

### Generation Feed: `GET /api/runs` + lazy detail fetch

No dedicated datagen feed endpoint exists. The feed polls `GET /api/runs?limit=50` every 8 seconds and fetches detail for any newly completed/failed/cancelled run via `GET /api/runs/{run_id}`. Run detail includes the full `events` array from the `run_events` PostgreSQL table.

**Immediate update on stream_end:** When an SSE `stream_end` fires for a live worker, `fetchRunDetail` is triggered immediately rather than waiting for the next poll cycle, so the feed updates without an 8s delay.

### Snippet extraction priority

Server-side, `_last_message_snippet()` in `runner.py` caps all snippets at 200 characters. For the feed summary, the best snippet is selected by:
1. Last non-null snippet from a non-`supervisor`/`system`/`finish` node (forward content)
2. Fallback: any snippet from any node
3. Final fallback: last `status` event message

### EXPAND — full event chain

The EXPAND button on each feed card renders the complete `node_update` event chain in chronological order: agent label + snippet for each event. Built lazily on first expand from `_feedCache[runId].events`. This replaces the original `max-height` toggle (which was useless since snippets are already ≤200 chars).

---

## Rationale

- **SSE over WebSocket** — SSE is sufficient for unidirectional server-push and is already implemented in BobSpark-APIs. WebSocket would require server-side changes.
- **No dedicated datagen endpoint** — Rather than adding a new endpoint to BobSpark-APIs, the existing run history endpoints carry enough information. This avoids scope creep on the API side.
- **EMA over simple rolling average** — EMA is stateless per worker (no buffer needed) and reacts faster to rate changes, which is important for short-duration runs.
- **Feed cache (`_feedCache`)** — Prevents double-fetching run details and allows the EXPAND event chain to be built without a second network call.

---

## Consequences

- **snippet cap is a hard limit** — 200-char snippets are a server-side constraint in `runner.py`. Increasing this requires a BobSpark-APIs change and is out of scope for the dashboard.
- **Feed does not persist across page reload** — `_feedCache` is in-memory. Refreshing the page triggers a fresh poll of `/api/runs?limit=50` which re-fetches recent history, so this is acceptable.
- **Max 18 workers** — Constrained by the spinbox UI. The API has no enforced limit; 18 was chosen as a practical ceiling for the DGX Spark's concurrency capacity.
- **SSE connections are not re-opened on reconnect** — If the connection drops mid-run, the card shows `CONN LOST`. A future improvement could auto-reconnect and resume from the last known `tokens_out`.
