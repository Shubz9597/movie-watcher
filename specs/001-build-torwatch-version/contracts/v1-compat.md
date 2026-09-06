# Contract: Version 1 Compatibility Surface (frozen during migration)

**Feature**: `001-build-torwatch-version` | **Owner**: `torrent-streamer` `internal/httpapi` | **Status**: active

This document is the authoritative inventory of the V1 API surface and each route's
removal gate. Per spec FR-010 and the Constitution's safe-evolution gates: every route
below MUST keep working at every migration checkpoint; changes are allowed only under a
versioned contract or compatibility adapter; removal requires passing the listed gate
AND recorded evidence. Compatibility is determined by protocol ranges/capabilities, not
application version (see [protocol-negotiation.md](./protocol-negotiation.md)).

## Live routes (consumed by Electron today)

| Method | Path | Contract meaning (must not drift silently) | Removal gate |
|---|---|---|---|
| GET | `/healthz` | Liveness; `{"status":"ok"}`; 503 when DB ping fails (2 s) | Never removed while any client health-checks it; body frozen until P0 characterization is superseded by a versioned change |
| GET/HEAD | `/stream` | Byte-range media streaming: 206/416 semantics, `Range`/`Content-Range`/`Accept-Ranges`; `trackProgress=1&subjectId&seriesId&…` enables auto-save | Gated on: all clients use V2 stream path (none planned this milestone) → likely retained |
| GET | `/files` | File list for an added torrent: `[{index,name,length}]`; 504 on metadata timeout | Retained (used by resolve flow) |
| GET | `/subtitles/list` | `{source, tracks[], fallbackUsed, providerConfigured}` as characterized in P0 | Retained; V2 may re-route internal implementation only |
| GET | `/subtitles/torrent` | Embedded subtitle → `text/vtt` conversion | Retained |
| GET | `/subtitles/external` | OpenSubtitles → VTT; 429 + `Retry-After` rate limit | Retained |
| POST | `/v1/torrents/search` | `{query,total,results[]}` with opaque `sourceId` (indexer credentials never leave backend) | Retained (V2 clients reuse it) |
| POST | `/v1/torrents/resolve` | `sourceId` → `{magnetUri, infoHash?}` | Retained |
| GET | `/v1/imdb/ratings/{ttID}` | Rating payload or 404 | Retained |
| POST | `/v1/session/heartbeat` | Progress checkpoint; V2 adds OPTIONAL `clientId`, `sessionId`, `seq` (additive; V1 bodies still accepted and behave identically) | Retained (write path becomes server-ordered, see leases-and-progress.md) |
| GET | `/v1/resume` | `{found,seriesId,season,episode,position_s,duration_s,percent}`; 15 s rewind | Retained; rewind behavior preserved (furthest-position-wins prohibited) |
| GET | `/v1/resume/source` | Persisted source snapshot `{found,sourceUri,sourceName,sourceKind,fileIndex}` | Retained |
| GET | `/v1/continue` | Continue-watching items `{seriesId,season,episode,position_s,…,sourceAvailable}` | Retained |
| POST | `/v1/continue/dismiss` | `{subjectId,seriesId,season,episode}` → 204 | Retained |
| GET | `/buffer/state` | Warmer state `pause\|play\|stop` → `{ok,state}` | Retained |
| GET | `/subtitles/configure` | POST `{apiKey}` → `{ok:true}`; sets the in-memory OpenSubtitles key | Retained — **live, not dormant** (P0 D-1 correction: `electron-app/electron/ipc/setup-ipc.js:166` consumes it); V2 may re-route internal implementation only |
| GET/SSE | `/buffer/info` | Buffer telemetry JSON or SSE (`sse=1`); gateway must not buffer | Retained; SSE promoted as recommended V2 client pattern (polling stays working) |
| any | `/watch/open` `/watch/ping` `/watch/close` | Lease lifecycle → `{leaseId}` / 204 / 404; V2 adds OPTIONAL `clientId` on open | **Revived** in P7 as the multi-client primitive (no gate — becomes live) |

## Dormant routes (no current in-repo consumer; verified in P0)

| Path | Removal gate |
|---|---|
| `/add`, `/prefetch` | No remaining consumer (grep + test evidence), contract tests exist documenting current shape, owner approval recorded |
| `/stats` | Same gate — **note**: P7 adds admission observability here, so it becomes live; gate closes |
| `/v1/session/start`, `/v1/session/ended` | Same gate; re-evaluate during P7 (autoplay flow may be revived for V2 clients) |
| `/v1/resume/source/probe` | Same gate; candidate for revival as V2 "will it play here?" check |
| `/v1/resume.m3u` | Same gate; external-player integration kept unless gate passes with evidence |

## Client launch contract (Windows/local V1 flow)

- Electron spawns the backend with `PG_DSN`, `PROWLARR_URL`, `PROWLARR_API_KEY`,
  `TORRENT_DATA_ROOT`, `SUB_CACHE_DIR`, `LOG_FILE`, `ERROR_LOG_FILE`,
  `TORWATCH_APP_VERSION`, `LISTEN=127.0.0.1:4001` and waits on `/healthz`.
- These environment names MUST remain accepted for the whole migration (handoff §7);
  the Windows build-and-launch flow keeps working until its own removal gate passes.
- Root `docker-compose.yml` remains Electron-owned; never repurposed.

## Change procedure

Any change to a route above requires: (1) a task in `tasks.md` naming the route; (2)
contract-test updates in the SAME task; (3) migration-map fields (old owner, new owner,
consumers, compatibility mechanism, verification, removal gate, rollback); (4) client
migration evidence before any old-path deletion.
