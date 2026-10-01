# Offline downloads contracts (D01)

Status: **finalized before server consumers** (per tasks D01). These schemas
and semantics are implemented and tested as pure logic in
`torrent-streamer/internal/downloads` plus additive migration
`009_downloads.sql`; the HTTP surface is wired in D02 behind the
`downloads.offline.v1` capability. Existing stream/watch/session APIs are
unchanged. Anything not listed here is out of scope for v1.

Design rules enforced throughout (plan "Backend contract gate D01"):

- Source/file identities are **opaque server references** (canonical
  `seriesId` + season/episode + validated internal pick id). The API never
  accepts arbitrary user URLs and never exposes provider secrets, magnet
  URIs, or indexer details through download manifests or errors.
- Download URLs/IDs do NOT establish application authentication; the private
  LAN/overlay boundary is unchanged and nothing here introduces public
  exposure.
- Capability `downloads.offline.v1` is advertised ONLY when the
  implementation is functional (D02) — never as a promise.

## 1. Server instance identity

`GET /v1/version` gains one additive field:

```json
{ "instanceId": "3f2a…-uuid-v4" }
```

- Generated once, persisted in `server_instance` (migration 009), stable
  across restarts and URL changes.
- **Semantics:** identity of the server INSTANCE (data store). A URL change
  may refer to the same instance; the same URL after a server reinstall may
  refer to a different instance. Hostname alone never implies sameness.
- Clients MUST scope local download inventory and offline progress by
  `instanceId`, never by URL. Progress import (§6) is only ever sent to the
  instance that owns the original progress records.
- Older servers omit the field; clients treat absence as "instance scoping
  unavailable" and keep downloads disabled.

## 2. Capability

`capabilities` gains `"downloads.offline.v1"` only when the prep pipeline,
asset serving, and retention are functional. A server that lists the
capability but fails a workflow is a defect, not a client problem.

## 3. Preparation jobs

### Create — `POST /v1/downloads/jobs`

Request:

```json
{
  "idempotencyKey": "client-generated attempt UUID",
  "seriesId": "tmdb:movie:693134",
  "season": 0,
  "episode": 0,
  "sourceId": "opaque id returned by torrent search",
  "sourceKind": "movie",
  "fileIndex": 0,
  "subtitles": ["en"]
}
```

- `idempotencyKey` is per client (`client_id` derives from the existing
  client identity header/param used by the session APIs). Retrying the same
  key returns the same job with `200`; a new attempt uses a new key.
- `sourceId` MUST be the unexpired opaque id returned with the exact search
  result the user selected. The server resolves it and records the internal
  pick; magnets and indexer URLs never cross this boundary. `sourceKind` is
  `movie`, `tv`, or `anime`; `fileIndex` is optional except when a selected
  season pack needs a specific episode. Unresolved/foreign identities →
  `400 invalid_source`. The legacy internal `pickId` form remains accepted by
  server-side contract fixtures, not product clients.
- `season`/`episode` are 0 for movies.
- `subtitles` is the OPTIONAL list of requested sidecar languages (lowercase
  ISO 639-1). The job is ready only with EVERY requested language present in
  the manifest; a requested language the source cannot provide keeps the job
  from becoming ready — the client then retries or re-enqueues without it
  (the "Continue without subtitles" choice).
- Response `201` (or `200` on idempotent replay):

```json
{ "jobId": "uuid", "state": "preparing", "reasonCode": "" }
```

### Read — `GET /v1/downloads/jobs/{id}`

```json
{ "jobId": "uuid", "seriesId": "tmdb:movie:693134", "season": 0, "episode": 0,
  "state": "ready", "reasonCode": "",
  "readyAt": "2026-09-28T10:00:00Z", "expiresAt": "2026-09-30T10:00:00Z" }
```

Durable job states (machine, enforced by CHECK constraint and the Go state
machine): `preparing`, `ready`, `failed`, `cancelled`, `expired`.

Safe `reasonCode` values — enumeration is closed; no internal details:

| state | reasonCode |
|---|---|
| preparing | `""` |
| ready | `""` |
| failed | `source_unavailable` \| `insufficient_server_storage` \| `preparation_failed` |
| cancelled | `client_cancelled` \| `replaced` |
| expired | `retention_expired` |

Transitions: `preparing → ready | failed | cancelled`; `ready → cancelled |
expired`. `failed`, `cancelled`, `expired` are terminal for that job; a retry
is a NEW job with a new idempotency key. Server restart resumes/reconciles
`preparing` jobs (bounded admission, D02); jobs are never lost by restart.

### Cancel / renew

- `POST /v1/downloads/jobs/{id}/cancel` → cancels a `preparing` job
  (`client_cancelled`) and releases its claim; `ready` jobs respond
  `409 not_cancellable` (removal is a device-side operation).
- `POST /v1/downloads/jobs/{id}/renew` → extends retention (§5). Returns the
  job body; `409` with reason `retention_expired` once expired.

Errors use the existing machine-readable envelope
(`{"error":{"code","message"}}`): `invalid_source`, `not_found`,
`not_cancellable`, `capacity_exceeded` (bounded admission; existing
semantics), `storage_full`.

## 4. Ready manifest — `GET /v1/downloads/jobs/{id}/manifest`

Served only for `ready` jobs.

```json
{
  "manifestVersion": 1,
  "jobId": "uuid",
  "revision": 7,
  "expiresAt": "2026-09-30T10:00:00Z",
  "video": {
    "kind": "video",
    "path": "/v1/downloads/jobs/<jobId>/assets/video",
    "sizeBytes": 2147483648,
    "sha256": "<64 hex>"
  },
  "subtitles": [
    { "kind": "subtitle", "lang": "en", "path": "/v1/downloads/jobs/<jobId>/assets/subtitles/en",
      "sizeBytes": 54321, "sha256": "<64 hex>" }
  ]
}
```

- `manifestVersion` is `1`; clients reject unknown versions.
- `revision` is immutable for the life of the job: a changed validator
  (§4.1) means a DIFFERENT revision and resume data MUST be discarded —
  never append bytes from a different revision.
- Asset `path` values are **origin-relative**, must begin with
  `/v1/downloads/jobs/<same job id>/assets/`, contain no scheme, no
  authority, no `..`, no credentials, and no query string. Validation is
  implemented in `downloads.ValidateManifest` (tested) — cross-origin
  credential forwarding is structurally impossible.
- The manifest is the complete package: the video plus EVERY requested
  required subtitle. A missing sidecar keeps the job in `preparing` (or
  failed with `preparation_failed`) — never silently ready.

### 4.1 Asset serving — `GET/HEAD <path>`

- `ETag: "<sha256 first 32 hex>"`; `Accept-Ranges: bytes`;
  `Content-Length` exact.
- `Range`/`If-Range`: correct `200`/`206`/`416` semantics; `If-Range` with a
  stale/foreign validator → full `200` (never mixed-revision bytes).
- Bounded, efficient streaming (no whole-file buffering); readers are pinned
  against mid-transfer deletion until their response completes.
- Assets remain byte-stable for the job's lifetime; deletion happens only at
  expiry/cancel with bounded cleanup after active readers drain.

## 5. Retention

- Independent of watch heartbeats and view state.
- Default: **48 hours from `readyAt`**. `POST …/renew` extends by 48h from
  the renewal instant; total age from `readyAt` is capped at **14 days**.
- Expiry is evaluated lazily but persistently (job flips to `expired` with
  `retention_expired`; assets cleaned up in bounded background work).
- A device that reconnects after expiry sees `expired`/`retention_expired`
  → client shows **Needs preparation**; enqueue again (new idempotency key).
  Files already completed on the device remain playable (device files are
  independent of server cleanup).

## 6. Offline progress import

Separate additive endpoint `POST /v1/progress/offline` (capability-gated
together with `downloads.offline.v1` in v1).

Request:

```json
{
  "updateId": "stable per-attempt UUID (device-persisted until acknowledged)",
  "seriesId": "tmdb:tv:1396", "season": 1, "episode": 4,
  "positionS": 600, "durationS": 2820,
  "baseRevision": 12
}
```

- `baseRevision` is the server progress revision the device's offline state
  was based on (from the last successful sync/ack). `0` means "record should
  be absent/never synced".
- Semantics (pure decision implemented in `downloads.ApplyOfflineProgress`,
  exercised transactionally by the SQL layer in D02):

| condition | outcome |
|---|---|
| `updateId` already recorded for this client | `duplicate` — return the RECORDED result; never re-apply |
| record absent and `baseRevision == 0` | `committed` (new record, next revision) |
| record absent and `baseRevision != 0` | `conflict` (current: revision 0 / position 0) |
| `baseRevision == record.revision` | `committed` (deliberate rewind is a valid write; furthest-position-wins is prohibited; client wall-clock is never consulted) |
| otherwise | `conflict` with the CURRENT server position/revision |

Response:

```json
{ "outcome": "committed", "revision": 13, "positionS": 600, "durationS": 2820 }
{ "outcome": "duplicate", "revision": 13, "positionS": 600, "durationS": 2820 }
{ "outcome": "conflict",
  "current": { "revision": 14, "positionS": 900, "durationS": 2820 } }
```

- `conflict` maps to WF08: the client shows both positions with source
  labels; the user's explicit choice produces a NEW conditional update (new
  `updateId`, fresh `baseRevision`). A concurrent change during resolution
  yields a new conflict — never a blind overwrite.
- Queued updates are NEVER sent to a different instance than the one that
  issued `baseRevision` (instance identity §1).
- The `(client_id, update_id)` ledger (`offline_progress_updates`) makes
  retries idempotent forever; retention of ledger rows is unbounded for v1
  (small rows) with a documented cleanup threshold deferred to operations.

## 7. Data ownership and migration note

- New tables (migration `009_downloads.sql`, purely additive):
  - `server_instance` — singleton persistent instance identity (§1).
  - `download_jobs` — durable prep jobs: canonical identity, validated
    `pick_id`, state machine, reason code, manifest JSON, ready/expiry
    timestamps, prep-worker claim. `UNIQUE (client_id, idempotency_key)`.
  - `download_assets` — per-job immutable assets: kind, server-relative
    path under the download root, exact size, SHA-256. `ON DELETE CASCADE`
    with the owning job.
  - `offline_progress_updates` — idempotency ledger for §6.
- Ownership: the server owns preparation, retention, and server-side
  progress; the DEVICE owns downloaded bytes, local manifest state, and
  local progress until import. Server cache cleanup NEVER implies device
  deletion.
- Migration safety: every statement is `IF NOT EXISTS`/additive; old
  binaries ignore the new tables; no existing table or column is altered.
  Downgrade is safe: pre-009 binaries keep working and retained rows simply
  expire by the documented lifecycle. No destructive cleanup exists in v1.
- Secrets/safety: no provider credentials, magnets, or indexer data are
  stored in the new tables or returned in any payload; diagnostics record
  redacted job IDs only.
