# Data Model: TorWatch V2 Shared Backend and BFF

**Feature**: `001-build-torwatch-version` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

Existing V1 storage is preserved; all V2 schema work in this milestone is additive
(expand-migrate-contract; destructive cleanup requires its own removal gate). Existing
tables/migrations: `torrent-streamer/migrations/001_core.sql` … `004_imdb_ratings.sql`.

## Entities

### Title

A movie, series, or anime work merged deterministically across providers.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Opaque namespaced identifier, `provider:externalId` (e.g. `tmdb:123`, `anilist:456`, `imdb:tt1234567`); stable across requests for the same query context |
| `type` | enum | `movie \| series \| anime` |
| `title`, `originalTitle` | string | Non-empty display title |
| `year` | int? | Provider-supplied; may be absent |
| `artwork` | map | `poster`, `background`, `logo` URLs (server-side URLs or provider URLs) |
| `overview` | string | May be empty on provider degradation |
| `providerIds` | map<string,string> | Every contributing provider's external ID |
| `imdbId` | string? | When resolvable (links to `/v1/imdb/ratings/{ttID}`) |
| `mergedFrom` | []string | Providers that contributed (observability/diagnostics) |

Validation: merge is deterministic per query (fixed provider priority + fixed tie-breaks,
research R4). No merge output may depend on map iteration order.

### Episode

A playable unit of a series/anime title.

| Field | Type | Rules |
|---|---|---|
| `id` | string | Namespaced episode identifier |
| `titleId` | string → Title | Owning title |
| `season`, `episode` | int | Non-negative; the tuple + subject keys watch progress |
| `title`, `airDate`, `still` | string/date/URL? | Provider-supplied, may be absent (degradation) |
| `anilistId`, `kitsuId`, `tmdbId` | string? | Cross-links used for metadata enrichment and subtitle hash queries |

State transitions: none (metadata is derived/cached, never user-mutated).

### CatalogSection

A curated or computed collection of titles served by the BFF (`/v2/catalog/sections`).

| Field | Type | Rules |
|---|---|---|
| `id` | string | e.g. `trending`, `popular-anime`, `continue-watching` |
| `kind` | enum | `provider` (server-computed from provider data) \| `household` (computed from local progress, e.g. continue-watching via `/v1/continue`) |
| `titleIds` | []string | Ordered deterministically |
| `cachedAt` | timestamp | Cache provenance; stale-but-valid on provider outage |

### SourcePick

The deterministic, persisted torrent source chosen for a title/episode (existing `picks`
table; V1 behavior preserved per FR-002).

| Field | Type | Rules |
|---|---|---|
| `id` | uuid | Existing PK |
| `seriesId` / `season` / `episode` (or movie subject) | | Selection scope |
| `profileHash` | string | Capability profile of the requester (V1 hardcodes `h264|hevc|av1`; stays V1 during migration) |
| `infoHash`, `magnet`, `releaseGroup`, `resolution`, `codec`, `fileIndex` | | Chosen source; scoring inputs retained |
| `createdAt` | timestamp | Persisted pick survives restarts (SC-005) |

Uniqueness: existing `(series_id, season, episode, profile_hash)` semantics unchanged.

### WatchLease  *(revived V1 machinery + V2 fields)*

One client's active interest in a torrent resource. In-memory
(`internal/watch/watchmgr.go`); not persisted.

| Field | Type | Rules |
|---|---|---|
| `leaseId` | string | 16 random bytes hex (V1 `genID`) |
| `key` | `{cat, id, fileIndex}` | Resource key: `cat` ∈ `movie\|tv\|anime`, `id` = normalized infoHash (uppercase hex) or raw magnet, `fileIndex` = -1 when unknown |
| `clientId` | string | **V2 (additive)**: client-generated opaque UUID; format/length validated; not authentication (FR-013) |
| `lastSeen` | timestamp | Refreshed by `/watch/ping` |
| `state` | enum | `active → (stale-pruned \| closed)`; resources for a key release only when every lease expires/goes stale |

Semantics (spec Clarification 1): multiple concurrent leases per key; no takeover;
`/watch/close` does not stop the torrent immediately (quick-reload tolerance, V1
behavior); reaper ticker default 30 s, staleAfter default 20 s (both configurable in V2).

### StreamSession

An active playback stream served to a client.

| Field | Type | Rules |
|---|---|---|
| `sessionId` | string | Server-generated identifier (16 random bytes hex) |
| `leaseId` | string → WatchLease | One of possibly several concurrent leases for the key |
| `clientId` | string → Client/Deployment | Streaming client |
| `key` | resource key | Distinct-key admission accounting unit |
| `state` | enum | `active → (clientClosed \| reaped)`; mid-stream disconnect reclaims stream/buffer resources promptly and persists progress to last reported position (spec Edge Case) |

### WatchProgress

Per title/episode saved position, shared across clients (existing `watch_progress`
table + additive V2 columns via `005_progress_multiclient.sql`).

| Field | Type | Rules |
|---|---|---|
| `subject_id` | string | Household subject (V1 default subject from client; e.g. Electron `deviceId`) |
| `series_id`, `season`, `episode` | | `UNIQUE(subject_id, series_id, season, episode)` (existing) |
| `position_s`, `duration_s` | numeric | CHECK ≥ 0 (existing); resumable only when `position_s > 0 AND (duration_s <= 0 OR percent < 95)` |
| `percent` | numeric | 0–100 CHECK (existing); completion threshold 95 |
| `source_uri/source_name/source_kind/source_file_index` | | Source snapshot for exact re-attach on resume (existing, migration 003) |
| `updated_at` | timestamp | Trigger-maintained (existing) |
| `progress_revision` | bigint | **V2 (migration 005)**: server-assigned monotonic per row; every successful commit increments |
| `writer_client_id` | string? | **V2**: last-writer client ID (metadata only — never the sole ownership key) |
| `stream_session_id` | string? | **V2**: session that produced the write |
| `last_seq` | bigint | Latest writer's sequence metadata; independent session guards live in `watch_progress_sessions` |

Write rules (spec Clarification 3): last-write-wins by successful server commit order,
never client timestamps; within one stream session, `seq` older than the session's
`last_seq` is rejected/ignored (delayed heartbeat retries cannot rewind); deliberate
rewind/replay from a valid session is a normal new write; furthest-position-wins
prohibited. Next-episode queueing and dismissal-clearing behavior (V1
`SaveProgressUpdate`) preserved.

State transitions: `none → watching (partial) → completed (percent ≥ 95, optional
next-episode row)`; manual dismissal rows in `continue_dismissals` unchanged.

### WatchProgressSession (migration 006)

`watch_progress_sessions` has primary key `(progress_id, session_id)` and a
`last_seq` bigint. `progress_id` references `watch_progress.id` with cascading
delete. Each accepted explicit-session update writes its checkpoint and sequence
in one transaction while holding the progress row lock. First writes create the
row with `ON CONFLICT DO NOTHING` before taking the same lock. Existing checkpoint
metadata seeds the known session guard on upgrade; history already lost before
this migration cannot be reconstructed.

### Client / Deployment

| Field | Type | Rules |
|---|---|---|
| `clientId` | string | Client-generated cryptographically random UUID on first run, persisted locally (e.g. V1 `device-id.ts` pattern generalized); validated for format/length server-side; untrusted opaque value |
| `supportedProtocolRange` | [min,max] | Declared by client; compared against server range at workflow start |
| `appVersion` | string? | Informational only — never used for compatibility decisions (FR-011) |
| `capabilities` | []string? | Optional client capability declaration for future use |

Reinstallation generates a new `clientId` with no server registration; a future
authentication milestone MAY associate device IDs with accounts/profiles (FR-013).

### ProviderCache  *(new table, additive — e.g. `catalog_cache` in migration 005)*

Server-side TTL cache of provider responses backing graceful degradation.

| Field | Type | Rules |
|---|---|---|
| `cacheKey` | text | `provider + request-parameters hash`; PK |
| `payload` | jsonb | Raw provider response |
| `fetchedAt`, `expiresAt` | timestamp | Bounded TTL per provider; stale entries served as `stale-but-valid` when a provider is down (spec Edge Case 1), never garbage-collected while in use |
| `status` | enum | `fresh \| stale` |

### IMDbRating / DatasetImport / SearchCache / Series / Episodes / Devices

Unchanged from migrations 001–004 (FR-002: V1 responsibilities preserved). `devices`
table exists but gains no auth semantics in this milestone.

## Relationship Overview

```text
Title 1..* Episode
Title 1..1 CatalogSection membership (computed)
Title/Episode 1..0..1 SourcePick  (profileHash-scoped)
SourcePick/Source 1..* StreamSession *..1 WatchLease (key) *..1 Client/Deployment
WatchProgress: (subject, seriesId, season, episode) unique; references source snapshot;
               writer_client_id → Client; stream_session_id → StreamSession
ProviderCache: standalone; keyed by provider request
```

## Migration Plan (schema)

| Migration | Kind | Contents | Rollback story |
|---|---|---|---|
| `005_progress_multiclient.sql` | expand (additive only) | `watch_progress` + `progress_revision`, `writer_client_id`, `stream_session_id`, `last_seq`; backfill `progress_revision = 1` on existing rows; new `catalog_cache` table | Purely additive — pre-005 binaries ignore new columns and keep working (verified in P7 exit gate); no destructive cleanup this milestone |
| `006_progress_session_sequences.sql` | expand (additive) | Persist per-item/session sequence guards; seed the latest known session from existing progress | Existing rows and columns remain intact. Older binaries can read them, but do not enforce or maintain the independent session guards. |
