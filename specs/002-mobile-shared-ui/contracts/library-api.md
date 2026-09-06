# Contract: Household Library API (`/v2/library/*`) — FINALIZED for M3

**Feature**: `002-mobile-shared-ui` | **Owner**: Go library service (M3.2) + HTTP handlers | **Status**: finalized design (M3.1); no handler, storage, migration, or capability advertisement exists yet

Versioned, additive contract over the existing BFF. It depends on the canonical identity resolution in [evidence/m3.1-identity-contracts.md](../evidence/m3.1-identity-contracts.md): membership keys are canonical catalog ids, and TMDb ids MUST be media-qualified (`tmdb:movie:N`, `tmdb:tv:N`) end-to-end before any write is accepted. Do not advertise the capability or ship a client that writes until M3.2 lands.

## Identity used by this contract

- **Canonical id** = the opaque catalog id (`tmdb:movie:123`, `tmdb:tv:123`, `anilist:154587`, `jikan:52991`, …). Anime is a classification: a TMDb-classified anime entry uses its structural `tmdb:movie|tv:N` id with `type: "anime"`, so anime never duplicates under Series (canonical type governs grouping; the id governs identity).
- **Legacy `tmdb:N`** (unqualified) remains a READ alias resolved by the documented movie→tv probe order for old clients. The library API accepts canonical ids only; it never guesses an unqualified mapping (invalid/ambiguous input → 400 `invalid_request`).
- **Watch progress is NOT touched**: progress seriesIds (`tmdb:tv:N`, `tmdb:movie:N`, `anilist:N`, `mal:N`) already use the qualified vocabulary; no rekeying, and progress sequences remain owned by feature 001.

## Scope and trust

- Default scope: the private household — one scope per deployment, matching existing Continue Watching semantics (feature 001). The first deployment target is the private homeserver; there is no account system.
- `clientId` (existing UUID, format-validated) may ride requests for diagnostics/correlation. **It is not authentication** and never scopes or authorizes library data. No new auth surface is introduced.
- Library data is per-household truth: every connected device sees the same memberships (spec FR04).

## Endpoints

### `GET /v2/library?collection={watch-later|favourites}&kind={all|movie|series|anime}&sort={recent|title}&cursor={opaque}&limit={n}`

Cursor-paginated canonical summaries.

- Defaults: `collection` REQUIRED (no implicit collection), `kind=all`, `sort=recent`, `limit=30` (min 1, max 100). Invalid values → `400 {error:{code:"invalid_request"}}` (existing versioned error envelope; no secrets, no magnets).
- Response `200`:
```json
{
  "collection": "watch-later",
  "kind": "movie",
  "sort": "recent",
  "revision": "18446744073709551615",
  "total": 47,
  "items": [
    {
      "canonicalId": "tmdb:tv:209867",
      "type": "anime",
      "title": "Frieren: Beyond Journey's End",
      "year": 2023,
      "artwork": { "poster": "https://…" },
      "addedAt": "2026-09-06T12:00:00Z",
      "metadataAvailable": true
    }
  ],
  "nextCursor": "cmVjZW50fHdhdGNoLWxhdGVyfG1vdmllfHRtZGI6bW92aWU6NjkzMTM0",
  "degraded": false
}
```
- `total` is the full-scope count for collection+kind (beyond page one). `nextCursor` is absent on the last page. `metadataAvailable: false` entries render from the stored snapshot (title fallback + placeholder artwork) — membership is preserved when upstream metadata disappears (data-model).
- **Cursors are scope-bound**: the cursor embeds collection+kind+sort+last tuple. A cursor presented with mismatched scope → `400 invalid_request` (never silently mixed scopes).

### `GET /v2/library/overview?collection={watch-later|favourites}&sort={recent|title}`

Bounded shelf summaries for Movies/Series/Anime with full-scope totals and up to six previews each, one batched read.

- Response `200`: `{ "collection": "...", "sort": "...", "revision": "…", "sourceRev": "…", "shelves": [ { "kind": "movie", "count": 12, "previews": [ …same item shape… ] }, { "kind": "series", … }, { "kind": "anime", … } ], "degraded": false }` — `count` is the full-scope total (not the preview length); zero-count shelves are present.
- Reads return one consistent snapshot: overview counts, previews and `revision` come from a single read snapshot (M3.2 storage requirement) — never a revision mixed from unrelated unlocked queries.

### `PUT /v2/library/{encodedCanonicalId}/watch-later` and `/favourite`

Body `{ "enabled": true|false }`. The canonical id is percent-encoded ONCE (the id itself contains `:`).

- Response `200`: `{ "canonicalId": "tmdb:tv:209867", "watchLater": false, "favourite": true, "revision": "18446744073709551616", "updatedAt": "…" }` — both flags always returned.
- **Independent fields**: updating one flag never overwrites the other.
- **No-op/retry semantics**: writing the current value returns 200 with unchanged state and does NOT advance the revision or reorder the collection; a retried write after a successful one is the same no-op. Retries after failure are safe (idempotent per field).
- **Concurrent updates**: opposing writes to one flag resolve by server commit order (transactionally serialized through the household revision row) — never by device clocks. The response reflects committed server state; clients reconcile on refresh.
- **Membership ordering**: a false→true change sets that collection's `addedAt`; true→false clears it. No-op writes never reorder.
- Validation: `enabled` must be a boolean (400 otherwise); unknown/unparseable canonical id → `400 invalid_request`; a well-formed id no provider can resolve AND that has no stored membership snapshot → `404 {error:{code:"title_not_found"}}`. An existing membership whose metadata temporarily disappeared remains readable and removable.

### Errors and negotiation

- All errors use the existing envelope `{error:{code,message}}` with the feature 001 machine-readable codes; `providers_unavailable` only where upstream metadata fan-out fails (`degraded` reads may still serve cached snapshots).
- **Capability negotiation**: `library.household.v1` is added to `/v1/version` capabilities ONLY in M3.2, when handlers + storage + migrations actually exist. Until then older servers 404 these routes; clients render the explicit "library unavailable on this server" state (FR10) and must not fall back to local storage or direct provider calls. A client receiving the capability may rely on the routes; a server serving the capability must serve this entire contract.

## Revision rules

- The household revision is a monotonically increasing SQL bigint advanced transactionally per effective membership change. Wire format: **decimal string** (lossless — JavaScript must not compare bigints through Number). Client comparison is per cached resource/title (string bigint compare), never a global single number that can suppress unrelated resources (plan.md).
- A server reset/origin switch invalidates cached revision assumptions (client clears origin-scoped caches — existing connection-service behavior).
- Existing watch-progress `progress_revision`/`last_seq` mechanics are separate and untouched.

## Ordering

- `recent`: collection-specific `addedAt` descending, then canonical id ascending.
- `title`: one documented normalized sort key ascending (server-side; reuse the catalog normalization), then canonical id ascending. Sort is computed server-side; clients never sort library data locally except within an already-fetched page for display.

## Membership changes between pages

Live-list behavior: mutations between page fetches may add/remove entries. Clients dedupe by canonical id within a session and refetch from page one when they observe a `revision` newer than the one a cursor page was issued against (per-resource compare). Cursors never straddle scope/sort changes; a revision change does not invalidate a cursor's scope binding.

## Recommendation proposals (consistency; implementation is M4)

`GET /v2/recommendations?limit=…` (max 20) cards reference seed/candidate canonical ids from THIS identity (qualified tmdb forms), exclude current favourites + Watch Later, and use `type` for kind grouping. Ranking stays the bounded deterministic genre-overlap rules in plan.md; cache keyed by household revision + candidate-cache version. No recommendation endpoint is designed to accept writes.

## Non-goals for M3.1

No migrations, handlers, storage, capability advertisement, or client write paths exist yet. M3.2 prerequisites are listed in [evidence/m3.1-identity-contracts.md](../evidence/m3.1-identity-contracts.md).
