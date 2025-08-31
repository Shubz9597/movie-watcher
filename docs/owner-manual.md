# docs/owners-manual.md

> **Repository anchor doc** — commit this at `docs/owners-manual.md` and keep it updated. It defines the boundaries, API, schema, flows, and rollout so anyone (and future me) can pick up where we left off.

*Last updated: 31 Aug 2025 (IST)*

---

## 0) Intent

This project runs as a **single Go service (modular monolith)** that owns: catalog (TMDb/MAL), torrent search, deterministic scoring, source “picks”, HTTP streaming gateway, subtitles, prefetching (next‑episode), and watch progress/resume. Next.js is **UI only** and talks to this Go BFF.

---

## 1) Layout (must‑follow boundaries)

```
cmd/
  vod/            # main() — bootstrap only (config, logger, DB/cache, torrent engine, router, workers)
internal/
  httpapi/        # transport: routing, handlers, DTOs, middleware, CORS, auth (thin)
  catalog/        # TMDb + MAL/Jikan clients; episode normalization (incl. anime absolute ep)
  search/         # Prowlarr clients; normalize candidates; short‑TTL cache
  scoring/        # deterministic ranking + explanations; profile‑aware
  picks/          # persists chosen source per S/E; audit trail
  stream/         # torrent engine adapter; HTTP range; pin/unpin; never evict current/next
  subtitles/      # OS/fansub fetch; srt→vtt; cache
  prefetch/       # compute + warm EP(n+1) (and subs)
  progress/       # heartbeats; watch_progress; resume logic
  torrent/        # thin anacrolix wrapper; janitor policies
  store/          # DB access (pgx/sqlc); migrations
  cache/          # Redis/in‑proc cache helpers
  telemetry/      # logging, metrics, tracing
  config/         # env parsing; secrets
pkg/
  types/          # shared domain structs (Series, Episode, Candidate, Pick, ProfileCaps…)
```

**Rule:** `httpapi` depends on service interfaces; services depend on `store/cache/torrent/telemetry`. No handler touches DB or anacrolix directly.

---

## 2) Minimal DB schema (Postgres)

All tables include `created_at timestamptz default now()`, `updated_at timestamptz` (trigger).

* **series**: `id text PK` (e.g., `tmdb:tv:12345`, `mal:anime:98765`), `title text`, `kind text`, `external jsonb`.
* **episodes**: `id bigserial PK`, `series_id text FK`, `season int`, `episode int`, `absolute_ep int null`, `name text`, `runtime_s int null`, `air_date date null`.
* **picks** *(chosen source)*: `id bigserial PK`, `series_id text`, `season int`, `episode int`, `profile_hash text`, `infohash text`, `magnet text`, `release_group text null`, `resolution text`, `codec text`, `file_index int null`, `source_kind text` (single|season\_pack), `score jsonb`, `picked_at timestamptz`, `replaces_pick_id bigint null`, **UNIQUE** (`series_id`,`season`,`episode`,`profile_hash`).
* **search\_cache**: `key text PK` (`series|SxxExx|profile_hash`), `candidates jsonb`, `fetched_at timestamptz`.
* **watch\_progress**: `id bigserial PK`, `subject_id text` (user/device), `series_id text`, `season int`, `episode int`, `position_s int`, `duration_s int`, `percent numeric`, `updated_at timestamptz`. Index: (`subject_id`,`series_id`), (`updated_at desc`).
* **devices**: `id text PK`, `capabilities jsonb` (h264/hevc/av1,hdr,dv,maxBitrate).
* **group\_preferences** *(optional)*: `series_id text PK`, `preferred_group text`, `confidence int`, `updated_at timestamptz`.

---

## 3) Public HTTP API (BFF)

All paths are prefixed with `/v1`.

* `POST /session/start` — body `{ seriesId, season, episode, deviceCaps, subjectId? }` → `{ sessionId, pick, streamUrl, nextHint }`

  * Ensures **pick** (search→score if missing), pins torrent, resolves fileIndex.
* `POST /session/heartbeat` — `{ sessionId, position_s, buffered_s?, bitrate_estimate? }` → `{ ok: true, nextHint? }`

  * Updates `watch_progress`; drives prefetcher.
* `POST /session/ended` — `{ sessionId }` → `{ nextPick, autoplayIn: 10 }`
* `GET  /session/next?sessionId=…` → `{ candidates: [top1, top2], prepared?: true }`
* `POST /session/override-pick` — `{ sessionId, infohash }` → `{ pick, streamUrl }` (records replacement with `replaces_pick_id`).
* `GET  /resume?seriesId?=…` → `{ seriesId, season, episode, position_s, pick }` (exact source to rehydrate).
* `GET  /episodes?seriesId=…` → ordered list; includes anime absolute mapping.
* `GET  /stream/:sessionId` — range‑capable HTTP stream; resolves active `infohash+fileIndex`.
* `GET  /subtitles/:episodeKey.vtt` — normalized VTT for the selected pick.
* Admin/diag (protected): `GET /picks/:seriesId/:season/:episode`, `GET /healthz`, `GET /readyz`.

### Types (abbrev)

```jsonc
// Pick
{
  "infohash": "…",
  "magnet": "magnet:?xt=urn:btih:…",
  "releaseGroup": "…",
  "resolution": "1080p",
  "codec": "h264",
  "fileIndex": 3,
  "score": {"health":0.82, "quality":0.7, "size":0.5, "consistency":0.2}
}

// NextHint
{ "seriesId":"tmdb:tv:12345", "season":1, "episode":7, "ready": true }
```

---

## 4) Streaming lifecycle

1. **Start**: UI → `/session/start` → ensure pick → pin torrent → compute `nextHint` → return `streamUrl`.
2. **During**: heartbeats update progress; prefetch warms EP(n+1) (and subs). If current buffer under‑fills within Y seconds, fallback to candidate #2.
3. **End**: `/session/ended` returns next pick; UI autoplay countdown.
4. **Resume**: `/resume` returns last unfinished ep + **exact pick** (rehydrate torrent and fileIndex).

---

## 5) Scoring policy (tunable)

* **Health (45%)**: log(seeders) + seed/leech ratio; hard reject low swarms.
* **Quality fit (35%)**: resolution, source (WEB‑DL>WEBRip>HDTV), codec (avoid Hi10P for TVs), audio/subs match, HDR flags.
* **Size sanity (15%)**: MB/min within device budget bands.
* **Consistency (5%)**: prefer same release group as prior episode.
* Hard rejects: CAM/TS/TC, unsupported codec for device, outrageous size.

---

## 6) Background jobs

* **Prefetcher**: compute & cache EP(n+1), fetch subs, optionally pre‑add torrent metadata or map next file from same season pack.
* **Janitor**: age/size‑based eviction; **never evict** `current` or `nextHint`.
* **Episode refresh**: cron to sync TMDb/MAL.
* **Search cache sweeper**: TTL 10–30 min.

---

## 7) Caching

* `search_cache` table + Redis hot cache keyed by `(seriesId,S/E,profile_hash)`.
* CDN only for posters/backdrops; never for signed stream URLs.

---

## 8) Observability

* **Logs** (structured): `sessionId, subjectId, seriesId, S/E, pickId, infohash, fileIndex, score, reason, buffering_ms, fallback_used`.
* **Metrics**: `search_latency_ms`, `score_latency_ms`, `start_to_first_byte_ms`, `buffer_events_total`, `fallback_switch_total`, `prefetch_hit_ratio`, `resume_success_total`.
* **Tracing**: spans across `catalog→search→score→pick→stream`.

---

## 9) Config & secrets

Env via a single `config` package: `PG_DSN, REDIS_URL, TMDB_KEY, OS_KEY, PROWLARR_URL, PROWLARR_KEY, VOD_DATA_DIR, VOD_PUBLIC_BASE, JANITOR_TTL, CACHE_TTL, CORS_ORIGINS`.

---

## 10) Security

CORS locked to UI origins. `deviceId` cookie for anonymous resume. Admin endpoints require API key. Rate‑limit search. Sanitize magnets; avoid logging full magnets in user logs.

---

## 11) Rollout checklist (commit order)

* [ ] Create `cmd/vod` and keep `main.go` <150 lines.
* [ ] Scaffold `internal/httpapi` with `/v1/healthz`, `/v1/readyz`, `/v1/version`.
* [ ] Add `store` + migrations for `series, episodes, picks, watch_progress, search_cache`.
* [ ] Wrap anacrolix in `internal/torrent` (`Pin`, `Unpin`, `OpenFile`, `Stats`).
* [ ] Implement happy‑path `/session/start → picks.ensure → stream.open` with fake search.
* [ ] Move catalog (TMDb/MAL) into `catalog`; switch UI lists to Go BFF.
* [ ] Implement real `search` + `scoring`; start persisting `picks`.
* [ ] Implement `/session/heartbeat`, `/session/ended`, and **prefetcher**.
* [ ] Move streaming fully to `/stream/:sessionId`; deprecate Next.js API.
* [ ] Enable subtitles pipeline and `/subtitles/:episodeKey.vtt`.

---

## 12) Main file headers to add

Add this at top of `cmd/vod/main.go`:

```go
// Architecture: Modular Monolith. Boundaries documented in docs/owners-manual.md.
// main() bootstraps config, logging, DB/cache, torrent engine, router, workers.
// All business logic lives in internal/* packages.
```

---

## 13) Ground truths

* A **Pick** is the canonical decision of which torrent+file serves a specific episode for a specific device profile.
* A **Profile Hash** is a deterministic hash of device capabilities + user prefs affecting scoring.
* **NextHint** is a precomputed pick for the next episode and must be kept warm for instant autoplay.

---

# .arch-context (commit at repo root)

Create a file named `.arch-context` at the project root with the following contents:

```ini
ARCH_MANUAL=docs/owners-manual.md
SERVICE_PATTERN=modular-monolith
CORE_MODULES=httpapi,catalog,search,scoring,picks,stream,prefetch,subtitles,progress,torrent,store,cache,telemetry,config
NEXT_ACTIONS=follow rollout checklist in owners-manual.md
```

---

# README snippet (root README.md)

Append this to your `README.md`:

```md
## Architecture
This repo follows a **Modular Monolith** in Go. The authoritative design is in [docs/owners-manual.md](docs/owners-manual.md). The `cmd/vod/main.go` file only bootstraps wiring; all business logic lives under `internal/*`.
```
