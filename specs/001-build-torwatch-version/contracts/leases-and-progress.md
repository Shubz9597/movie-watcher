# Contract: Shared Watch Leases, Capacity Admission, and Server-Ordered Progress

**Feature**: `001-build-torwatch-version` | **Owner**: `internal/watch` (leases/progress/capacity), `internal/httpapi/session.go` (write path) | **Status**: designed (implemented in P7)

Normative for multi-client playback semantics. Everything here preserves V1 route shapes
additively; V1 callers that omit the new fields behave exactly as before.

## Shared watch leases (`/watch/*`)

Model (spec Clarification 1, FR-007): multiple clients MAY concurrently hold leases and
stream the same title/episode. Resources (torrent/buffer) for a key are released only
after EVERY lease for that key has expired or gone stale. Lease takeover does not exist
in this milestone.

### `POST|GET /watch/open`

Adds a lease for a resource key. Request (query or JSON body) — existing fields plus:

```json
{ "cat": "tv", "infoHash": "ABCDEF…", "fileIndex": 0, "clientId": "c1a7…-uuid-v4", "sessionId": "…" }
```

- `clientId` OPTIONAL this milestone: client-generated cryptographically random UUID,
  persisted locally; server validates format/length only (untrusted opaque value — not
  authentication, FR-013).
- `sessionId` OPTIONAL: correlates the lease with the StreamSession that will stream.

Response `200`: `{ "leaseId": "hex16", "key": {…}, "activeLeases": 2 }`
(`activeLeases` is an additive observability field). When admission denies a NEW key:
`503 capacity_exceeded` (below) — never affects existing keys.

### `POST|GET /watch/ping`

Refreshes `lastSeen` for `leaseId`. `204` on success; `404` when unknown/expired. V1
semantics unchanged.

### `POST|GET /watch/close`

Releases the lease. `204`. Does NOT immediately stop the torrent (V1 quick-reload
tolerance). Releasing the last lease schedules resource release after staleAfter.

### Reaping (configurable in V2)

Defaults preserved from V1: `staleAfter = 20s`, reaper ticker = `30s`. A key's resources
stop when it has zero leases (or all leases stale) — visible in `/stats` and
`/buffer/info`.

## Capacity admission (`internal/watch.Manager`)

- Policy input: number of active DISTINCT torrent/resource keys (NOT live-memory
  guesses; spec Clarification 5).
- Limit: configurable; default guarantees ONE active distinct-title resource set plus
  required background work on the 4 GB reference host (SC-006). Same-title concurrent
  clients share the key's torrent/buffer — bounded only by network bandwidth.
- Admission outcome is deterministic for a given key set + config.
- The manager owns one resource registry. Setup reserves a slot atomically;
  concurrent opens share setup, failed setup frees the reservation, and teardown
  retains the slot until stopping completes. Existing heartbeats do not wait for
  another resource's setup or teardown.
- On denial: reject ONLY the new stream/lease request with
  `503 {error:{code:"capacity_exceeded", message, retryAfterSeconds}}`. NEVER terminate
  or take over an existing healthy stream or lease. Higher-capacity deployments raise
  the limit via configuration with no client-contract change.

## Server-ordered watch progress

Applies to `/v1/session/heartbeat` and the `/stream` auto-save path (both funnel into
`SaveProgressUpdate`).

### Heartbeat request (V1 fields + optional V2 fields)

```json
{
  "subjectId": "…", "seriesId": "…", "season": 1, "episode": 2,
  "position_s": 640.5, "duration_s": 1440.0,
  "sourceUri": "…", "sourceName": "…", "sourceKind": "…", "sourceFileIndex": 0,
  "nextSeason": 1, "nextEpisode": 3,
  "clientId": "uuid-v4", "sessionId": "hex16", "seq": 41
}
```

### Rules (spec Clarification 3, FR-006)

1. **Last-write-wins by successful server commit order.** The server assigns a
   monotonically increasing `progress_revision` per progress row on every successful
   commit. Client timestamps are never trusted for ordering.
2. **Per-session sequence guard.** For a given `sessionId`, an update whose `seq` is
   ≤ the highest accepted `seq` for that session is rejected (`200` with
   `{ok:true, ignored:"stale_seq"}` so naive callers don't break) or dropped — a delayed
   heartbeat retry MUST NOT move progress backward. Migration 006 stores this guard
   per progress item and session in `watch_progress_sessions`, so another client
   writing or a server restart cannot erase it. The checkpoint and session guard
   commit in one transaction, serialized by the progress row lock.
3. **Deliberate rewind is a valid write.** A new write from a currently valid session
   (any position) is accepted; rewinding/replaying an episode works.
4. **Furthest-position-wins is prohibited** — it breaks intentional rewinding and
   episode restarts.
5. **Writer metadata.** Each write records `writer_client_id` and
   `stream_session_id`. `clientId` is metadata only — NEVER the sole progress-ownership
   key; canonical progress is shared under the deployment's default
   household/profile subject.
6. **Fidelity reconciliation.** The `/stream` auto-save path (byte-ratio estimate) is
   low-fidelity; it participates in the same ordering rules so it can never overwrite a
   newer heartbeat with an older estimate. Renderer heartbeats remain the preferred
   high-fidelity source.
7. V1 bodies (no `clientId`/`sessionId`/`seq`) are accepted and behave as a single
   anonymous session with LWW commit order — identical to V1 outcomes.

### Resume/continue responses (unchanged shapes)

- `GET /v1/resume` — 15 s rewind preserved; row selection by `updated_at` ordering
  unchanged.
- `GET /v1/continue` — items ordered as V1; `writer_client_id` MAY be added as an
  additive field in a later task (gated by contract-test update, not silently).

## Reconnect/restart semantics (spec Edge Cases)

- Client disconnects mid-stream: stream/buffer resources reclaimed promptly; progress
  persisted up to the last accepted report.
- Server restart during streaming: clients reconnect and resume via range requests;
  progress/picks/subtitle cache survive (SC-005).
