# Research: TorWatch V2 Shared Backend and BFF

**Feature**: `001-build-torwatch-version` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

All unknowns were resolved from checked-in code, tests, the approved spec (including its
2026-09-04 Clarifications), the project constitution (v2.0.0), and
`docs/v2-server-package/`. No NEEDS CLARIFICATION items remain.

## R1. Where does catalog aggregation live today?

- **Decision**: Port renderer-side provider logic into the existing Go backend as a new
  `internal/catalog` package; expose it under versioned `/v2/catalog/*` endpoints.
- **Rationale**: Verified that ALL provider calls (TMDb, AniList, Jikan, Cinemeta,
  AniZip, Kitsu) execute in the Electron renderer (`electron-app/src/lib/services/*.ts`)
  — the Go backend has zero catalog code. The Go service already owns search/resolve/
  stream/subtitles/progress, so the backend is the natural single home (constitution
  principle III; spec FR-001).
- **Alternatives considered**: Keeping aggregation in Electron and adding a thin proxy —
  rejected: leaves non-Electron clients incomplete (the defining V2 gap). Separate
  aggregation microservice — rejected: spec Assumption forbids splitting the monolith.

## R2. How should V2 handle the V1 route surface?

- **Decision**: Freeze-during-migration, not forever. Every V1 route keeps its meaning at
  every checkpoint; changes happen only under versioned contracts or compatibility
  adapters, with documented removal gates (no remaining consumer, contract tests green,
  rollback recorded).
- **Rationale**: Constitution v2.0.0 replaced the "frozen V1" rule with safe-evolution
  gates; the repaired spec (FR-002, FR-010, US4, SC-003) requires exactly this. The
  baseline inventory shows which routes are live (Electron uses `/healthz`, `/stream`,
  `/files`, `/subtitles/*`, `/v1/torrents/*`, `/v1/imdb/*`, `/v1/session/heartbeat`,
  `/v1/resume*`, `/v1/continue*`, `/buffer/*`) and   which are dormant (no callers found:
  `/add`, `/prefetch`, `/stats`, `/v1/session/start|ended`, `/v1/resume/source/probe`,
  `/v1/resume.m3u`, `/watch/*`). P0 correction (D-1): `/subtitles/configure` was
  initially misclassified as dormant; P0 grep found a live consumer
  (`electron-app/electron/ipc/setup-ipc.js:166`) — it is live.
- **Alternatives considered**: Permanent additive-only freeze — rejected: contradicts the
  approved spec and blocks contract evolution. Immediate cleanup of dormant routes —
  rejected: removal requires a gate, and `/watch/*` becomes live again in V2 (see R5).

## R3. What protocol/version surface should the server expose?

- **Decision**: `internal/buildinfo` + `GET /v1/version` returning `{serverVersion,
  revision, builtAt, protocolVersion, supportedProtocolRange, goVersion, os, arch,
  capabilities}`; `GET /readyz` for component readiness; `/healthz` body unchanged
  (`{"status":"ok"}`). Clients decide compatibility by comparing protocol ranges and
  capability flags; the server returns machine-readable `unsupported_protocol` /
  `unsupported_capability` errors (with the server-supported range) for requests it
  cannot serve, and never rejects a client for a differing application version.
- **Rationale**: The handoff (`docs/v2-server-package/architecture.md` §10) already
  specifies `/healthz`, `/readyz`, `/v1/version` additively; today only `/healthz`
  exists and returns a constant body, and `TORWATCH_APP_VERSION` reaches logs only.
  The spec Clarification (Q4) requires client-decided negotiation.
- **Alternatives considered**: Server-enforced minimum-version rejection — rejected:
  breaks independent upgrade in the old-server/new-client direction (FR-011, spec
  Clarification 4). Application-version comparison — rejected: spec explicitly bases
  compatibility on protocol ranges/capabilities, not app versions.

## R4. How are catalog identifiers and merge rules made deterministic?

- **Decision**: Opaque namespaced identifiers (`tmdb:<id>`, `anilist:<id>`,
  `jikan:<id>`, `imdb:<id>`, `kitsu:<id>`), one `Provider` interface with per-provider
  timeout/degradation policy, and a deterministic merge: fixed provider priority order
  + fixed tie-break keys (exact title/season/episode match fields), no reliance on map
  iteration order. Bounded TTL cache per provider so outages degrade to stale-but-valid
  or remaining providers (spec Edge Case 1).
- **Rationale**: Mirrors the proven V1 pattern where `/v1/torrents/search` hides indexer
  URLs/credentials behind opaque `sourceId`; the renderer's merge logic
  (`anime-catalog.ts`, `anime-matching.ts`, `adapters/media.ts`) is being ported and
  will be locked by characterization (P0) and parity (P4) tests first.
- **Alternatives considered**: Returning raw per-provider payloads and merging in
  clients — rejected: recreates divergent shared rules in every client (principle III).

## R5. How do multi-client leases work given the V1 code?

- **Decision**: Revive the dormant `/watch/*` machinery as the multi-client primitive,
  preserving V1 semantics: per-key (`cat|infoHash|fileIndex`), multiple concurrent
  leases per key, resources released only when every lease expires or goes stale
  (staleAfter 20 s / reaper 30 s — values become configurable). Lease records gain an
  untrusted opaque `client_id` (client-generated crypto-random UUID, format-validated)
  for correlation. A new `internal/admission` policy limits active DISTINCT resource
  keys (configurable, default = 1 guaranteed distinct title on the 4 GB host) and
  rejects only new stream/lease requests with machine-readable `capacity_exceeded` +
  retry guidance — never terminating or taking over healthy leases.
- **Rationale**: `internal/watch/watchmgr.go` already implements exactly the
  shared-lease model the spec Clarification (Q1) requires; it is registered but has zero
  callers today, so reviving it is additive. The V1 reaper contract ("close does not
  stop immediately, allow quick reloads") is preserved.
- **Alternatives considered**: Exclusive lease with takeover — rejected: contradicts
  spec Clarification 1. Deleting `/watch/*` — rejected: it is the natural multi-client
  primitive and the spec requires observable lease coordination. Memory-based admission
  — rejected: spec Clarification 5 mandates key-count-based deterministic admission.

## R6. How is watch progress made multi-client safe without breaking V1?

- **Decision**: Expand `watch_progress` additively (migration
  `005_progress_multiclient.sql`: `progress_revision BIGINT` (server-assigned,
  monotonic), `writer_client_id`, `stream_session_id`, plus per-session sequence
  tracking) and enforce in `SaveProgressUpdate`: last-write-wins by successful server
  commit order (never client timestamps), out-of-order sequence numbers within one
  stream session are rejected/ignored, deliberate rewind from a valid session is a new
  write. Furthest-position-wins is prohibited. `clientId`/`sessionId`/`seq` are optional
  request fields so V1 callers keep working unchanged.
- **Rationale**: Current schema already has `updated_at` (trigger-maintained) and LWW
  overwrite semantics; the spec Clarification (Q3) requires commit-order LWW with
  revision metadata and the session-sequence guard against delayed heartbeat retries.
  The two existing write paths (renderer heartbeat + `/stream` auto-save estimate) both
  route through the single ordered write path. Migration 005 is purely additive, so a
  pre-005 binary still runs against the migrated database (verified rollback).
- **Alternatives considered**: Furthest-position-wins — rejected by spec (breaks
  intentional rewind/episode restart). Per-device progress rows — rejected: progress is
  household-shared under the default subject (spec Clarification 2); client ID is
  metadata, not an ownership key.

## R7. How does the Electron client migrate without breaking?

- **Decision**: Three-step consumer migration: (1) pure refactor — collapse ~8 hardcoded
  `http://localhost:4001` call sites + 4 CSP files onto one configurable `api-client.ts`
  base URL (default unchanged); (2) catalog consumers switch to `/v2/catalog/*` behind a
  runtime flag `catalogSource=renderer|bff`, default `renderer`, flipped only after
  end-to-end verification; (3) renderer provider HTTP code deleted only after the
  removal gate (flag verified through a release cycle + parity suite green).
- **Rationale**: Constitution principle II (new path beside old, one consumer at a time)
  and FR-010 removal gates. Research confirmed there is no existing base-URL config
  mechanism, so the refactor must precede any repointing.
- **Alternatives considered**: Big-bang renderer swap — rejected: violates the
  constitution. Server-side proxy that keeps renderer code untouched — rejected: leaves
  provider credentials and CSP in the client and defeats the BFF purpose.

## R8. What is the second client?

- **Decision**: A minimal Go CLI reference client in `tools/reference-client/` that
  completes the full journey using only public endpoints plus negotiation; it is a test
  harness, not a shipped product.
- **Rationale**: SC-002 requires two different clients with zero per-client backend
  changes; spec Assumption says the second client is initially a minimal test/reference
  client. A Go CLI reuses the repo's toolchain and needs no new packaging.
- **Alternatives considered**: Polished web/mobile client — rejected: explicitly out of
  scope for this milestone (spec Assumption, FR-014).

## R9. How does deployment integrate with docs/v2-server-package/?

- **Decision**: Adopt the handoff as-is for packaging (config extraction, system
  endpoints, Prowlarr bootstrap, `deploy/torwatch-server/` bundle, multi-arch images,
  backup/restore/update/rollback, Radxa acceptance) and sequence it as phase P7, after
  the BFF behavior phases that it will serve. Its "do not move catalog logic in this
  workstream" rule is respected by making catalog migration (P3–P5) a separate phase
  owned by this plan.
- **Rationale**: The handoff is authoritative for packaging and is explicitly the
  deployment direction named in the spec Assumptions; nothing has been implemented yet
  (handoff README status), so this plan must own the sequencing without duplicating it.
- **Alternatives considered**: Doing packaging first — rejected: BFF contract tests can
  run against a locally launched backend; packaging depends on config/buildinfo from P1
  anyway. Ignoring the handoff — rejected: constitution names it authoritative context.

## R10. Baseline risks to carry into tasks

- `/watch/*` Key parsing quirks (`watchmgr.go:121–199`: JSON fileIndex parsed but
  ignored, body closed mid-parse) must be re-derived when adding `client_id`.
- `/stream` auto-save uses a flat 1.5 MB/s byte→seconds estimate; it must be reconciled
  with heartbeat fidelity, not silently trusted.
- Provider API keys currently ship inside the Electron app (`.env`, CSP); moving them
  server-side is a security improvement but requires an operator config surface
  (handoff §7 optional settings).
- `data/imdb-ratings.db*` SQLite leftovers are unreferenced; do not build on them.
- Dormant SSE support exists (`/buffer/info?sse=1`); Electron polls JSON at 1 s. V2
  keeps both forms working (gateway must not buffer either).
