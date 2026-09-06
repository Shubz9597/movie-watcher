# torWatch Homeserver Package (`deploy/torwatch-server/`)

Standalone deployment package for the private-LAN homeserver (plan P7;
FR-008/FR-009; spec Assumption). This package is **independent of the root
`docker-compose.yml`** (Electron-owned, never repurposed).

## Topology

```
clients (trusted LAN) ──> gateway (Caddy :8080) ──> vod :4001 ──> postgres (internal)
                                                       └──────> prowlarr (internal)
```

- Only the gateway exposes a port (FR-008). `postgres`/`prowlarr`/`vod` sit on
  the `internal` network (no published ports).
- Secrets live exclusively in `.env` (gitignored). They are never baked into
  images, written to logs, or returned in responses (constitution principle VI).
- Images are multi-arch (linux/arm64 + linux/amd64) with **immutable version
  tags** — never `:latest` (FR-009, T061).

## Runbook

1. **Preflight** — copy `.env.example` to `.env`, fill in operator secrets,
   then `scripts/torwatch.sh preflight` (validates inputs + compose config).
2. **Start** — `docker compose -f compose.yaml up -d` (add
   `-f compose.vpn.yaml` only when the optional VPN profile is configured).
   The backend applies embedded migrations (001–005) on boot; 005 is purely
   additive, so pre-005 binaries also run against the migrated schema
   (rollback story — see `evidence/p7-rollback-drill.md`).
3. **Verify** — `scripts/torwatch.sh verify` (healthz byte-exact body,
   readyz, version payload through the gateway; media byte-range 206/1024 and
   SSE first-tick checks when `TORWATCH_VERIFY_STREAM_URL` /
   `TORWATCH_VERIFY_SSE_URL` are provided).
4. **Backup** — `scripts/torwatch.sh backup <backup-dir>` (pg_dump + data
   tarball, timestamped, non-destructive).
5. **Restore** — `scripts/torwatch.sh restore <timestamp>` (restores into this
   package's own volumes only; never touches anything outside the project).
6. **Update** — `scripts/torwatch.sh update <new-immutable-tag>` (pre-update
   backup → swap tag → verify → automatic rollback to the previous tag on
   failure).
7. **Build images** — `scripts/build-images.sh <version>` from the repo root
   (docker buildx, arm64+amd64, immutable tag, pushed once).

## Rollback

- Binary rollback: re-run `update.sh` with the previous immutable tag
  (migration 005 is additive → pre-005 binaries run against the migrated
  schema; drill recorded in `evidence/p7-rollback-drill.md`).
- Data rollback: restore the pre-update backup via `restore.sh`.
- Gateway: Caddy never buffers `/stream` (media byte-ranges) or
  `/buffer/info` SSE (`flush_interval -1`) — verified by `verify.sh`.

## Admission envelope (SC-006)

`WATCH_MAX_ACTIVE_TITLES` defaults to **1** — one guaranteed active
distinct-title resource set on the 4 GB reference host (conservative default
pending the ROCK 3A measurements, T063). Same-title concurrent clients share
the key's torrent/buffer (bounded by bandwidth); a second distinct title is
rejected with `503 capacity_exceeded` + `retryAfterSeconds` while healthy
streams are never terminated. Raise the limit only with measured headroom.
