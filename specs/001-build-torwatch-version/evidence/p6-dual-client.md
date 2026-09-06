# P6 Evidence — Protocol Negotiation Clients + Reference Client (dual-client)

**Phase**: P6 (plan.md) | **Date**: 2026-09-04 | **Baseline**: Phase 5 exit (evidence/p5-flag-verification.md; T042 interactive journey still pending — non-blocking for this phase, which uses public endpoints directly)

## Gate status before this phase

- Phase 6 automated exit checks: PASS (flag tests, gateway tests, full suites, build).
- Electron BFF journey (P5/T042): **still pending interactive verification** — recorded as a non-blocking gap for this phase; the reference client exercises the backend independently and does not consume the Electron flag state. The combined dual-client acceptance (quickstart §3) remains pending and is recorded below.

## Implementation

- **T045 — reference-client skeleton + negotiation** (`torrent-streamer/tools/reference-client/`): `main.go` (CLI: version|search|title|episodes|resolve|stream|heartbeat|resume|journey), `negotiate.go` (`Negotiate(serverRange, clientMin, clientMax)` — overlap ⇒ highest mutually supported protocol; no overlap ⇒ `ProtocolMismatchError` with an actionable upgrade message; **application versions are structurally never consulted**; version discovery is never gated; missing `/v1/version` fails open for pre-P1 backends), client-id persistence (`LoadOrCreateClientID` — cryptographically random UUID v4, persisted at `<user-config>/torwatch-reference-client/client-id`, stable across runs, fresh on reinstall; treated strictly as an untrusted opaque identifier per FR-013 — no registration, no authentication).
- **T046 — catalog commands** (`catalog.go`): `Search`/`TitleDetail`/`Episodes` against `/v2/catalog/*` only; `Search` additionally requires the advertised `catalog.bff.v2` capability (missing ⇒ workflow blocked with guidance, version discovery unaffected).
- **T047 — playback journey** (`playback.go`): `Resolve` (POST `/v1/torrents/resolve`), `StreamRange` (GET `/stream` with `Range` header; asserts 206 + Content-Range + exact byte count), `Heartbeat` (POST `/v1/session/heartbeat`, `clientId` as opaque correlation metadata), `Resume` (GET `/v1/resume`, 15 s rewind preserved), and `RunJourney` (full SC-001 sequence).
- **T048 — Electron startup negotiation** (`src/lib/version-check.ts`): `ensureServerCompatible` fetches `/v1/version` (60 s session cache), blocks only non-overlapping workflows with `ProtocolMismatchError` (actionable message + both ranges), fails open on missing/unreachable version endpoints, never gates health/version discovery. Wired into `catalog-gateway.ts` — every bff-mode catalog workflow negotiates first; renderer mode unaffected.
- **T049 — server contract tests** (`internal/httpapi/negotiation_test.go`): `unsupported_protocol` 400 carries `supportedProtocolRange:[1,1]`; `unsupported_capability` 400 carries the advertised capability list; **differing application versions (`0.0.1-ancient`, `99.0.0-future`, `not-a-version`) are never rejected when protocol ranges overlap** (all three return 200).

## Verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Reference-client unit + integration tests | `go test -count=1 ./tools/reference-client/` | PASS 18/18 — negotiation matrix (overlap/width/highest-mutual/no-overlap/missing range), client-id stability + UUID format + per-install independence, fail-open for pre-P1 backends, version discovery never gated, catalog commands on public endpoints only, missing-capability guidance, ranged stream 206/1024 bytes/Content-Range, resume 15 s rewind, explicit no-viable-source outcome, full journey |
| **Dual-client harness demonstration** | `TestDualClientSharedBackendAndProgressVisibility` | PASS — two independent clients (different persisted ids, zero per-client backend changes) against ONE backend: identical search results; client A heartbeat (640 s) visible to client B's resume (625 s after server rewind); client B's newer progress (900 s) visible to client A (885 s). Shared-progress visibility under the same household subject proven at harness level |
| Negotiation server contracts (T049) | `go test -count=1 ./internal/httpapi/ -run TestNegotiation` | PASS 3/3 |
| Full Go suite | `go test -count=1 ./...`, `go vet ./...` | PASS / PASS |
| Electron tests | `npm test` | PASS 64/64 — includes the new version-check suite (range helpers, app-version irrelevance, actionable blocking, fail-open, cacheability) and the gateway tests now proving the bff path negotiates before every workflow |
| Renderer bundle | `npx vite build` | PASS |

## T050 — dual-client verification per quickstart §3: **PARTIAL — interactive run PENDING**

Proven at harness level (above): same endpoints, same contracts, shared progress visibility, two independent clients, one backend. The full quickstart §3 acceptance — Electron (client A) + reference client (client B) running the complete journey concurrently against a live deployment, including shared lease observation (`activeLeases: 2`) and `capacity_exceeded` behavior — requires the P7 lease/admission work plus a live backend + interactive Electron, and is therefore recorded as **PENDING**, not passed.

## Outstanding verification (pending, never passed)

1. Interactive dual-client run per quickstart §3 (Electron + reference client vs one deployment) — after P7 lands the lease surface.
2. Electron dual-mode journey (P5/T042) — still pending from Phase 5.
3. Live-provider reachability (real TMDb/AniList credentials) — fixtures only, by design.

## Rollback

`git revert` the Phase 7 commits — removes `tools/reference-client/` (test harness only; nothing shipped), `internal/httpapi/negotiation_test.go`, `src/lib/version-check.ts`, the gateway negotiation hook, and this evidence. V1 routes, Electron behavior, renderer rollback code, and the P5 flag default (`renderer`) are untouched.
