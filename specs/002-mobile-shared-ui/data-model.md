# Household library persistence design

Status: finalized for M3.2 (M3.1). The canonical identity gate has PASSED — see [evidence/m3.1-identity-contracts.md](../evidence/m3.1-identity-contracts.md) and [contracts/library-api.md](contracts/library-api.md). **Stable title key = the canonical catalog id with TMDb ids media-qualified (`tmdb:movie:N` / `tmdb:tv:N`)**; legacy unqualified `tmdb:N` remains a read alias resolved by the documented movie→tv probe and is never stored as a membership key. Existing watch-progress storage and ordering remain unchanged (progress seriesIds already use the qualified vocabulary — no rekeying).

## Entities

| Entity | Fields / purpose |
|---|---|
| Household revision | One row for the alpha household; monotonically increasing bigint revision and server update time. No device ownership. |
| Library membership | Unique `(household_id, stable_title_key)`; watch_later boolean, favourite boolean, separate membership-added timestamps, created/updated timestamps, last mutation revision. |
| Metadata snapshot | Stable title key, display title, canonical media kind, artwork reference, normalized sort key and provider identity needed for lookup; enough to render a preserved entry when metadata is unavailable. Use the catalog's existing cache/store where appropriate; do not duplicate all catalog data. |
| Recommendation cache | Bounded derived result keyed by household revision and candidate-cache version; expiry 15 minutes. May be in memory; loss on restart is harmless. |

Wire revision values should be decimal strings (or another explicit lossless representation); JavaScript must not compare arbitrary SQL bigint values through lossy floating-point conversion. A server reset/origin switch invalidates cached revision assumptions. Title IDs are opaque; source hashes and release names are not membership keys. Canonical media kind is metadata for segregation, not a substitute for stable identity.

## Transactions and consistency

1. Validate the requested title and explicit boolean field. Unknown malformed title input produces a documented client error; an existing membership whose upstream metadata temporarily disappears is still readable/removable.
2. Begin transaction. Serialize writes through the household revision row, then get/create the unique membership row. Keep a consistent lock order. This deliberate small-household design prioritizes correctness over high write throughput.
3. Update only the requested flag. If it already has the requested value, do not advance revision or reorder it. A false→true change sets that collection's added timestamp; true→false clears that collection's active timestamp. The other collection's timestamp/value stays unchanged.
4. For an effective change, increment the household revision transactionally and store the committed mutation revision. Return both flags and revision after commit. A failed transaction must not leak a new revision or successful UI result.
5. Keep a row with both flags false so later refreshes can explain removals; omit it from active collections. Bound storage maintenance separately if needed; do not delete progress or title metadata as a side effect of un-saving.

Overview, full count and page queries must read a consistent snapshot with their returned revision. A global revision read after unrelated unlocked queries is not sufficient. Use an appropriate read transaction/snapshot strategy and cover a write between count and page reads in tests. Opposing writes to one flag resolve by server commit order. Do not trust device timestamps.

The client serializes same-title writes and rebases on returned canonical state; repeated identical requests do not duplicate membership. It must reject a stale response for the same resource/title and refetch when different resource caches lag. Do not let a high revision on one screen permanently suppress loading another screen's data.

## Reads, sorting and cursors

`watch-later` reads require watch_later=true; `favourites` requires favourite=true. Overview contains the same three mutually exclusive media groups as the catalog classification, including totals of zero. Return bounded previews; do not count only the preview items. Collection plus media-kind grids use server-side filters.

Recently added order: collection-specific added time descending, then stable key. Title order: one documented normalized sort key ascending, then stable key. Pagination cursors bind collection, media kind, sort and last tuple. Define live-list behavior: new mutations may change a list between pages, so deduplicate by stable key and refresh from page one after an observed revision change. Reset a cursor when sort/filter changes. Invalid or mismatched cursor returns a documented error; do not silently mix scopes.

Choose indexes for household/active-flag/kind/sort queries based on the finalized schema and query plan. Bulk metadata loading must avoid N+1 provider requests. Unavailable metadata preserves the entry and its category where known; title display falls back to a stored snapshot and status. Do not reclassify missing data by guessing from its name.

## Migration and verification

Use additive tables/indexes and the next unused migration. Do not automatically import device-local flags: no verified local library migration source is established. Existing progress rows are not library memberships. Old server binaries should ignore new tables; binary rollback preserves the newly saved library.

Required tests: empty/first insert; duplicate insert/retry; repeated no-op; independent flags/timestamps; remove and re-add ordering; competing same-field writes; parallel different-field writes; transaction rollback; snapshot count/page consistency; restart; same-number movie/TV identity; anime segregation; metadata unavailable; more than one page; scope-bound cursor; sort switch; lossless revision serialization; old-database upgrade/restart and old-binary compatibility. Implement focused tests in M3 rather than checking these off as documentation work.
