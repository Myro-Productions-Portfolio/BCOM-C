# ADR-009: Parallel Entity Detail Fetch with Slide-Out Panel

**Status:** Accepted
**Date:** 2026-03-01
**Deciders:** Nicolas Myers

---

## Context

The Datasets page needs to display rich per-entity detail (stats, example previews, provenance chain) without navigating away from the list view. Unlike run details (ADR-007, which uses a full separate page), datasets are browsed in bulk — users scan the table, select one, inspect it, then continue scanning. A full-page navigation breaks that flow.

Additionally, dataset detail requires three separate API calls per entity:
- `GET /api/data/datasets/{id}/stats`
- `GET /api/data/datasets/{id}/examples`
- `GET /api/data/datasets/{id}/provenance`

Options considered:
1. **Sequential fetch** — stats → examples → provenance, one after the other
2. **Full detail page** — navigate to a separate `dataset-detail.html?id=` (per ADR-007)
3. **Slide-out panel with parallel fetch** — CSS-animated right panel, all three sub-endpoints fetched concurrently via `Promise.all`

## Decision

Use a **slide-out detail panel** (fixed right panel with CSS `transform: translateX`) and fetch all sub-endpoints in **parallel via `Promise.all`**.

- The panel overlays the list without navigation; clicking the backdrop or CLOSE dismisses it
- `Promise.all([stats, examples, provenance])` fires all three fetches simultaneously; each result is handled independently (null if endpoint unavailable)
- The panel renders as soon as all three resolve, showing graceful fallbacks for any missing sub-resource
- List page retains its filter/search state throughout — no page reload required

## Rationale

- `Promise.all` cuts perceived load time vs. sequential fetch (three ~parallel API round-trips instead of three sequential ones)
- Slide-out keeps the dataset list visible and filterable without route change — better for exploratory browsing
- Independent null-handling means one missing endpoint (e.g. `/provenance` not yet implemented) does not break the panel
- Consistent with ADR-001 (vanilla JS) — no modal library, no framework, pure CSS transition
- Contrast with ADR-007 (URL-param pages): detail pages are appropriate for deep inspection (full run streams, event chains); slide panels are appropriate for quick entity review (datasets, registry entries)

## Consequences

- All future "list + quick detail" views (data sources, model registry, etc.) should use the slide-panel pattern
- Full-page detail pages (ADR-007) remain the pattern for entities requiring SSE streams or deep inspection
- The panel CSS (`transform: translateX`, `transition: 0.22s`) must co-exist with any existing fixed-position elements on the page
- `Promise.all` requires all fetch calls to be individually `.catch`-wrapped so a single 404 does not reject the whole batch
