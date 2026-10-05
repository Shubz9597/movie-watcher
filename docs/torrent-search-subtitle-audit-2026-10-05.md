# Torrent search and subtitle audit — 2026-10-05

Scope: Torrentio parsing and anime identity mapping, Prowlarr routing/fallback, release normalization/ranking/deduplication, memory and PostgreSQL caches, source selection and file-index handoff in the client, and online/offline subtitle catalog integration. This is a focused integration audit, not a certification of every app feature.

## What explained the single item

The episode picker skips search when it successfully resolves the season pack previously chosen by the viewer. That is intentional continuity, but it offered no way to look for alternatives. The fix keeps that default and adds **Find other sources**. A fresh alternative search retains the saved pack, removes the duplicate hash, and displays a search failure while keeping the saved pack playable.

Live read-only checks before changes returned **48 sources for Severance S01E01** and **11 for Dragon Ball Kai episode 1 (AniList 6033)**. Both lists contained Torrentio file indices. These samples do not reproduce a universal one-result backend cap; no specific failing title was supplied during the audit.

A separate reproduced backend problem: any nonempty Torrentio answer, even one usable torrent, suppressed Prowlarr. Fewer than five usable choices now trigger supplementation. Both providers seed the same collector and caches, so late indexer completion does not overwrite Torrentio's choices. Abundant Torrentio answers retain the fast path. Valid Torrentio choices survive a Prowlarr outage; slow supplementation returns available choices after the soft deadline and continues in the background.

## Other corrected defects

- The client discarded `fileIndex` in both movie and episode row mappings. The field now survives through source selection, playback and movie M3U export, including index zero. A stronger Prowlarr mirror cannot discard Torrentio's verified file choice. The [Stremio stream contract](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html) specifies this field as the file index within a torrent.
- Matching title and size collapsed different known torrent hashes into one choice. Known hashes now define distinct swarms; identical hashes still deduplicate and keep the stronger swarm. Title/size fallback remains for releases whose hashes are unknown.
- Anime search cache keys omitted AniList identity; TVDB identity was also omitted despite affecting Prowlarr queries. Both are included. Cache version v6 invalidates the old release rows through the existing startup purge.
- ani.zip throttling, server errors and malformed mapping responses were cached as missing for 24 hours. Only successful mapping responses and actual 404 misses are cached. Mapping lookup now falls within Torrentio's overall timeout, runs once per fetch, and has a bounded cache.
- Canceling the first viewer's request could cancel a search shared through singleflight. Each viewer can leave independently; shared work has a bounded service context.
- Anime IMDb season/episode mapping applied only to Stremio subtitles. Both subtitle catalogs now receive the mapped episode, including offline downloads. Desktop subtitle requests now forward AniList/MAL IDs already present in the playback payload.
- OpenSubtitles kept only the first file in each result record. It now lists every distinct valid file, within the existing 50-choice bound.
- OpenSubtitles query caches could cross account credentials. Cache keys now include a credential fingerprint and provider URL; credentials themselves are not stored in cache keys.
- Repeated Stremio subtitle searches bypassed caching. Successful catalogs now use the existing bounded 30-minute cache, separated by title/episode/provider and normalized language, and return independent slices. Provider failures are not cached.
- Configured OpenSubtitles failures disappeared when the free addon supplied tracks. Available tracks remain usable and the desktop/mobile picker displays the provider warning. Offline downloads retry configured-provider failures instead of treating them as permanent subtitle absence.
- The desktop subtitle picker incorrectly described addon tracks as "from the torrent only" when no API key was configured. It now identifies the free addon.

## Provider limitation observed live

The configured OpenSubtitles API returned **HTTP 403** for a movie lookup, and a second direct TV lookup had a transport failure. The live app supplied only free-addon tracks: Inception 5, Severance S01E01 2, Dragon Ball Kai episode 1 4. A configured key therefore does not prove the API is usable. Code fixes cannot override provider authorization or create subtitle variants absent from a provider. Verify an accepted API key/account configuration to access that catalog. The free addon remains available.

## Validation

- Regression cases first failed for sparse Torrentio supplementation, AniList cache identity and transient mapping poisoning, then passed with the fixes.
- Full `go test -race -count=1 ./...` passed using an isolated PostgreSQL 16.9 container with migrations applied; production PostgreSQL was not used for tests.
- `go vet ./...`, Go formatting and `git diff --check` passed.
- Frontend TypeScript checking, characterization tests, player-contract tests (10), and desktop/mobile/browser renderer builds passed.
- `npm run smoke:torrent-search` drives the real episode component with deterministic HTTP fixtures: default pack continuity, finding alternatives, duplicate removal, file-index-zero handoff to playback and movie M3U export, and a visible failure retaining the saved pack. It makes no torrent download. Screenshot: `.tmp/torrent-search-review/source-picker.png`.

The server deployment does not install a new mobile/desktop binary on the user's device. Rebuild/install that client to receive the source-picker and playback-handoff changes.

## Deployment verification

Backend revision `98ef558` was pushed and deployed using `deploy-from-git.sh`, with its pre-update backup. Health, readiness, version and LAN port checks passed. The fixture verified three byte-exact HTTP 206 ranges, an HTTP 416 range rejection, and two SSE data events. This verifies the transport with test data, not playback availability of arbitrary public swarms.

After deployment, live Severance S01E01 returned 49 choices (0.604 s first request, 0.003 s cached), and Dragon Ball Kai episode 1 returned 11 (0.425 s first request, 0.001 s cached). All retained file indices. Inception retained five addon subtitles and displayed the provider warning; listing took 1.435 s first and 0.570 s repeated. The remaining API failure prevents that configured provider from benefiting from a successful catalog cache. Public provider counts may change over time.
