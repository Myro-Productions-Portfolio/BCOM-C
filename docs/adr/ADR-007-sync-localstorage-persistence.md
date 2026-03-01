# ADR-007: Synchronous localStorage-Only Persistence for Settings and Themes

**Status:** Accepted
**Date:** 2026-03-01
**Deciders:** Nicolas Myers

---

## Context

The settings page (settings.html) originally implemented , , and  as  functions with backend fetch calls to  and . On every page load,  awaited a 3-second  fetch, and  awaited a 2-second fetch. An async IIFE in the init block sequenced these calls.

This caused two classes of failure:
1. **Race conditions**:  and  ran before the async fetch resolved, leaving form fields in their HTML default state.
2. **Silent bad state from nginx fallback**: Caddy/nginx returns 200+HTML for unknown API paths when the backend is unavailable.  but  throws — caught silently — leaving  null. Settings then fail to apply.

BCOM-C is a static single-origin dashboard. There is no multi-device sync requirement. The backend API is optional infrastructure, not a persistence contract.

## Decision

All persistence in  is **synchronous and localStorage-only**:

-  — sync, writes to  only, no backend POST
-  — sync, reads from  only, no backend fetch
-  — sync, reads from  via , no backend fetch
- Init block — plain synchronous calls, no async IIFE

## Rationale

 is synchronous by spec. No / is needed or appropriate for localStorage reads/writes. Removing backend fetches from the persistence layer eliminates the entire class of async race and silent-error failures. BCOM-C has no requirement for server-side settings storage.

## Consequences

- Settings and themes persist correctly across page refreshes and navigation.
- No 2–3 second blocking fetches on page load.
- Backend  and  endpoints are no longer called by the settings page. They may be removed from BobSpark-APIs in a future cleanup.
- Any future multi-device sync must be implemented as an explicit, non-blocking layer on top of localStorage — never as a blocking init dependency.
