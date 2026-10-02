# torWatch Homeserver Package (`deploy/torwatch-server/`)

Standalone deployment package for the private-LAN homeserver (plan P7;
FR-008/FR-009). This package is **independent of the root
`docker-compose.yml`** (Electron-owned, never repurposed).

Status: **release candidate 2.0.0-rc.1**, live-verified on a disposable
stack (Linux AMD64, Docker Desktop) for startup, ports, streaming contract,
persistence, backup/restore, and update/rollback. See
`specs/001-build-torwatch-version/evidence/p8-release.md` for the evidence
index. Not yet verified on the Fedora/ARM64 targets (runbooks below).

## Topology and modes

```
clients (trusted LAN) ──> gateway (Caddy, only LAN port) ──> vod :4001
                                   vod ──> postgres (internal network)
                                   vod ──> prowlarr + flaresolverr (app bridge)
```

- **Direct mode** (`compose.yaml`): no Gluetun, no VPN credentials. Prowlarr
  and FlareSolverr use the host's normal outbound route; torrent peer traffic
  uses the host's normal route.
- **Embedded-VPN mode** (`compose.vpn.yaml` overlay): adds Gluetun
  (WireGuard/OpenVPN); Prowlarr and FlareSolverr join its network namespace
  so indexer/challenge traffic is tunnelled and fails closed if the tunnel
  stops. The vod service intentionally stays on the host route in BOTH modes
  (as-implemented boundary documented in `docs/v2-server-package/architecture.md`
  §3.2): sharing Gluetun's namespace would kill the whole app with the
  tunnel, and torrent peer traffic does not require the VPN. Operators who
  need peer traffic tunnelled must use a host-level VPN.
- **Shared-database mode** (`compose.shared-db.yaml` overlay): disables this
  project's bundled database and connects `vod` to the independently managed
  `deploy/homelab-postgres` stack. Set `TORWATCH_DB_MODE=shared`; the operator
  scripts select the overlay automatically. Start the database stack first.

- Only the Caddy gateway publishes a LAN port (FR-008). Prowlarr's admin UI
  is **loopback-only** (`127.0.0.1:${PROWLARR_ADMIN_PORT}`); reach it with
  `ssh -L 9696:127.0.0.1:9696 <user>@<host>`. PostgreSQL, FlareSolverr, and
  vod publish nothing.
- Application state lives beneath `TORWATCH_DATA_DIR` (`prowlarr/
  flaresolverr/ downloads/ subtitles/ logs/ backups/`). In bundled database
  mode, `postgres/` is there too. Shared database mode uses the named volume
  owned by `deploy/homelab-postgres`.
- Images are pinned (no `:latest`): `postgres:16.9-alpine`,
  `lscr.io/linuxserver/prowlarr:2.6.5`,
  `ghcr.io/flaresolverr/flaresolverr:v3.5.0`, `caddy:2.10.0-alpine`,
  `qmcgaw/gluetun:v3.40.0` (VPN overlay only).
- Secrets live exclusively in `.env` (gitignored); preflight rejects
  placeholders and world-readable files.

## Runbook

1. **Preflight** — copy `.env.example` to `.env` (mode 600), set
   `TORWATCH_DATA_DIR` + `TORWATCH_IMAGE` + `POSTGRES_PASSWORD`, select
   `TORWATCH_DB_MODE`, then
   `scripts/preflight.sh --mode direct` (or `--mode embedded-vpn`).
2. **Start** —
   `docker compose --env-file .env -f compose.yaml up -d`
   (add `-f compose.shared-db.yaml` for shared database mode and start
   `deploy/homelab-postgres` first)
   (add `-f compose.vpn.yaml` for VPN mode). The backend applies embedded
   migrations on boot; migration 005 is additive, so pre-005 binaries run
   against the migrated schema (see
   `specs/001-build-torwatch-version/evidence/p7-rollback-drill.md`).
3. **Prowlarr bootstrap** — on an empty instance the backend reads the
   generated API key from the read-only config mount and installs the V1
   starter indexers (no circular key setup). Bootstrap lines appear
   unfiltered in `docker compose logs vod`.
4. **Verify** — `TORWATCH_VERIFY_STREAM_URL=<range-capable url>
   TORWATCH_VERIFY_SSE_URL=<sse url> scripts/verify.sh` checks
   `/healthz` (byte-exact), `/readyz`, `/v1/version`, the published-port
   audit (loopback-or-gateway only), disk usage, a byte-range `206` with
   exactly 1024 bytes, and the immediate SSE first tick. The disposable
   fixture stack (`tests/compose.fixture.yaml` + `tests/Caddyfile.fixture`,
   fixture via `tests/make-fixture.sh`) supplies both URLs for testing.
5. **Backup** — `scripts/backup.sh <backup-dir>`: locked, staged, checksummed
   (sha256 manifest), atomic. Database via consistent `pg_dump`; Prowlarr
   config and subtitle cache from the data tree; torrent payloads excluded
   by default (`TORWATCH_BACKUP_INCLUDE_DOWNLOADS=1` opts in — a downloads
   restore recovers resumable partial state, not a crash-consistent
   snapshot).
6. **Restore** — `scripts/restore.sh <backup-dir-or-timestamp> [--yes]`:
   validates checksums BEFORE stopping writers, restores the database,
   Prowlarr config, and subtitle cache, recreates the containers (required
   so replaced directories re-resolve), retains the pre-restore state at
   `<backup>/.pre-restore-state/`, and fails closed if the stack does not
   become healthy.
7. **Update** — `scripts/update.sh <repo:tag>`: pre-update backup under
   `$TORWATCH_DATA_DIR/backups/`, pull (or fall back to a locally present
   image), recreate, verify, automatic rollback to the previous tag on
   failed verification.
8. **Build images** — `scripts/build-images.sh <version>` builds the native
   platform locally and loads it (safe Windows PC / laptop path, no push).
   Release path: `scripts/build-images.sh <version> --push --platforms
   linux/amd64,linux/arm64` (records digests). Build context is
   `torrent-streamer/`; the version/revision/build-time are embedded and
   visible at `/v1/version`.

## Automatic deployment from Git

The Fedora deployment can poll one pushed branch every two minutes without a
public webhook or GitHub deployment secret. Install it once from the normal
deployment account:

```bash
./deploy/torwatch-server/scripts/install-git-deploy-service.sh 001-build-torwatch-version
```

Each new fast-forward commit is fetched into the clean checkout. Changes under
`torrent-streamer/` build an immutable `torwatch-server:git-<commit>` image,
then use the normal backup, update, health verification, and rollback path.
Compose or Caddy changes reconcile the application stack. Shared PostgreSQL is
owned by `deploy/homelab-postgres` and is not restarted by this service.

`electron-app/` is client code. A Git push can record those changes, but Docker
cannot update an installed iOS, Android, or desktop app; produce and install a
new client build separately.

```bash
sudo systemctl status torwatch-git-deploy.timer
sudo journalctl -u torwatch-git-deploy.service -n 100 --no-pager
sudo systemctl start torwatch-git-deploy.service  # run immediately
```

## Rollback

- Update failure: automatic (tag reverts, containers recreated, re-verified;
  recovery instructions printed).
- Manual: re-run `scripts/update.sh <previous-tag>`, or restore the
  pre-update backup with `scripts/restore.sh <backup-dir> --yes`.
- Data rollback: `scripts/restore.sh <backup-dir-or-timestamp> --yes`.

## Platform runbooks

- Fedora (AMD64, first live target): `docs/v2-server-package/fedora-runbook.md`
- Radxa ROCK 3A (ARM64): `docs/v2-server-package/radxa-runbook.md`
