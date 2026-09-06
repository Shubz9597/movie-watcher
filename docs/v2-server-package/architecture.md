# TorWatch Version 2 server-package architecture

## 1. Scope and architectural position

TorWatch Server is a deployable form of the existing Go modular monolith in
`torrent-streamer/`. The package does not introduce a second application
backend and does not split existing business logic into microservices.

The current Go service remains authoritative for:

- Prowlarr-backed torrent discovery and source resolution;
- deterministic scoring and persisted source picks;
- torrent acquisition, cache management, buffering, and HTTP range streaming;
- torrent and external subtitle discovery and delivery;
- IMDb rating storage and scheduled refresh;
- watch progress, continue-watching, resume, and watch leases;
- health, readiness, build information, logging, and graceful shutdown.

Catalog providers currently called by Electron remain outside this package
milestone. The package prepares a stable server boundary but does not complete
the later catalog BFF migration.

## 2. Runtime topology

```text
Trusted LAN or private overlay
              |
              v
      application gateway
       HTTP(S), one port
              |
              v
       TorWatch Go API
        |      |      |
        |      |      +---- downloads/subtitles/logs bind mounts
        |      +----------- PostgreSQL (private network)
        +------------------ Prowlarr (private network)
                                  |
                                  +---- FlareSolverr

Optional embedded-VPN deployment:
TorWatch torrent peer traffic and selected provider traffic -> Gluetun -> VPN
```

The application gateway is the only LAN-facing container. Internal service
names, not host-published ports, are used for inter-container communication.

### 2.1 Services

| Service | Responsibility | Published ports |
| --- | --- | --- |
| `gateway` | HTTP(S) entrypoint; streams without buffering | One configurable LAN port |
| `torwatch-api` | Existing Go modular monolith | None |
| `postgres` | Durable application and IMDb data | None |
| `prowlarr` | Indexer management and Torznab API | None |
| `flaresolverr` | Optional Prowlarr challenge helper | None |
| `gluetun` | Optional embedded VPN and network namespace | None |

Prowlarr administration is performed through an SSH tunnel or a deliberately
temporary loopback-only mapping documented in the operator runbook. It must not
be exposed using `0.0.0.0:9696`.

## 3. Deployment modes

The package must support two network modes without duplicating application
code.

### 3.1 Direct mode

`compose.yaml` runs the Go service on the private Compose network. Torrent peer
traffic uses the Linux host's normal route. This is suitable when the operator
accepts the normal route or has configured a compatible host-wide VPN.

### 3.2 Embedded-VPN mode

`compose.vpn.yaml` is an overlay applied in addition to `compose.yaml`. The Go
service's torrent peer traffic must use Gluetun's network namespace or another
verified full-tunnel mechanism. Merely setting `HTTP_PROXY` is insufficient for
BitTorrent peer traffic.

The implementation must verify these properties rather than infer them:

- the API is reachable from `gateway` while it shares or routes through the VPN;
- PostgreSQL and Prowlarr DNS/service connectivity still works;
- an outbound-IP check from the API network namespace matches Gluetun;
- stopping Gluetun prevents peer traffic instead of leaking to the host route;
- LAN clients can still reach the gateway while the tunnel is active.

If Compose overlay semantics cannot express this safely and clearly, use two
small explicit application service definitions anchored to one shared service
configuration. Do not accept a traffic-leaking fallback for convenience.

## 4. Target repository layout

The implementation should add the following layout. Names may change only when
the replacement is documented and serves the same responsibility.

```text
torrent-streamer/
  Dockerfile
  .dockerignore
  cmd/
    vod/                         # existing server entrypoint
    healthcheck/                 # optional static healthcheck binary
  internal/
    buildinfo/                   # version, revision, build date, protocol
    config/                      # validated server/package configuration
    httpapi/
      system_handlers.go         # health, readiness, version
      system_handlers_test.go
    bootstrap/                   # package-owned Prowlarr initialization
      prowlarr.go
      prowlarr_test.go

deploy/
  torwatch-server/
    compose.yaml                 # direct mode, no floating release tags
    compose.vpn.yaml             # embedded-VPN overlay
    .env.example                 # safe placeholders only
    Caddyfile                    # or equivalent checked-in gateway config
    README.md                    # concise release-bundle entrypoint
    scripts/
      preflight.sh
      backup.sh
      restore.sh
      update.sh
      verify.sh

docs/
  v2-server-package/             # this handoff and final test report template
```

If `.env.example` is used under `deploy/`, update `.gitignore` narrowly with an
exception such as `!deploy/**/.env.example`. Do not weaken the repository's
general environment-file exclusions.

## 5. Image contract

### 5.1 Application image

The Go image must:

- build from the `torrent-streamer` module using its declared Go toolchain;
- target both `linux/arm64` and `linux/amd64`;
- use a multi-stage build and a minimal maintained runtime image;
- run as a non-root UID/GID;
- include CA certificates and timezone data required by provider requests;
- write only beneath mounted data, subtitle, and log paths;
- receive `SIGTERM`, finish graceful shutdown, close torrent clients, and stop
  accepting new work within the configured Compose stop grace period;
- expose internal port 4001 without publishing it directly;
- embed semantic version, Git revision, build timestamp, and API protocol using
  linker flags;
- avoid embedding credentials or generated environment files in layers;
- be referenced by immutable semantic tag and recorded digest in a release.

The build must prove that `CGO_ENABLED=0` is valid for the current dependency
graph. If it is not, provide architecture-specific builders and the minimum
runtime libraries; do not silently ship an emulated AMD64 binary on ARM64.

### 5.2 Dependency images

Every release records tested tags and resolved digests for PostgreSQL, Prowlarr,
FlareSolverr, Gluetun, and the gateway. Development may use readable semantic
tags, but the released manifest must not use `latest`.

Image upgrades are their own reviewed change and must rerun the complete Compose
smoke suite. The current root Compose use of floating tags is not precedent for
the Version 2 package.

## 6. Persistent storage contract

Use operator-visible bind mounts rooted at `TORWATCH_DATA_DIR`. This simplifies
Radxa storage placement and recovery.

```text
${TORWATCH_DATA_DIR}/
  postgres/
  prowlarr/
  flaresolverr/
  gluetun/
  downloads/
  subtitles/
  logs/
  backups/
```

Requirements:

- downloads, PostgreSQL, and subtitle cache must survive recreation;
- container UIDs/GIDs must be documented and validated by `preflight.sh`;
- the package must fail with a clear error when required paths are not writable;
- database migrations remain embedded, ordered, transactional, and idempotent;
- restore procedures must start from stopped application writers;
- incomplete backup output must never replace the last known-good backup;
- low disk space must be visible in verification output before streaming fails.

MicroSD is not the recommended data root. The Radxa runbook assumes SSD, NVMe,
or another durable mounted filesystem for database and torrent write load.

## 7. Configuration and secrets

The package maps operator-friendly settings to the current environment contract.
Existing environment names used by Version 1 must remain accepted.

### 7.1 Required settings

- `TORWATCH_SERVER_VERSION` is supplied by the image, not the operator.
- `PG_DSN` points to Compose service `postgres:5432`.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` initialize PostgreSQL.
- `PROWLARR_URL` points to `http://prowlarr:9696` or the verified VPN namespace
  address used by the selected topology.
- `PROWLARR_API_KEY` is either explicitly supplied or discovered by the package
  bootstrap flow after Prowlarr creates its configuration.
- `TORRENT_DATA_ROOT`, `SUB_CACHE_DIR`, `LOG_FILE`, and `ERROR_LOG_FILE` point to
  mounted paths.
- `LISTEN` remains the internal listener, normally `0.0.0.0:4001` in a container.

### 7.2 Optional settings

- OpenSubtitles API key and user token using current supported names;
- IMDb ratings source override;
- cache size and eviction TTL;
- buffer targets and tracker mode;
- VPN provider, type, WireGuard/OpenVPN credentials, and location;
- gateway hostname/port and TLS configuration;
- timezone, PUID, and PGID.

`.env.example` contains placeholders and comments but no working defaults for
passwords or private keys. The preflight script rejects unchanged placeholders,
world-readable secret files, invalid directories, unsupported CPU architecture,
missing `/dev/net/tun` in VPN mode, and insufficient Docker Compose capability.

## 8. Prowlarr bootstrap ownership

Electron currently waits for Prowlarr, reads its generated API key, and installs
starter indexers only when the instance is empty. A headless package cannot rely
on Electron, so this exact responsibility must move into server-owned bootstrap
code or a narrowly scoped init helper.

Required semantics:

1. Wait for Prowlarr configuration and HTTP readiness with bounded retries.
2. Obtain the API key from an explicit secret when provided. Otherwise read the
   generated configuration from a read-only mount; never log the key.
3. If the Prowlarr indexer list is non-empty, preserve it without mutation.
4. If it is empty, add the same supported starter indexers as Version 1.
5. Record per-indexer success/failure without preventing the API from starting
   when optional starter indexers fail.
6. Make repeated startup idempotent and concurrency-safe.
7. Redact authorization headers, API keys, magnets, and VPN values in logs.

The implementation should extract the starter-indexer definitions into a form
shared by Electron and package bootstrap if that can be done without changing
Version 1 behavior. Otherwise duplicate only the declarative data temporarily
and add a parity test that prevents drift.

## 9. Gateway behavior

The gateway must preserve streaming semantics:

- forward `GET`, `HEAD`, `OPTIONS`, and `POST` as used by the current API;
- forward `Range`, `Content-Type`, and current client headers;
- return `206`, `Content-Range`, `Content-Length`, and `Accept-Ranges` unchanged;
- disable response buffering and compression for `/stream` and SSE routes;
- allow long-lived streaming and `/buffer/info` SSE connections;
- not cache application JSON, subtitles, manifests, or media;
- apply sane header/read timeouts without imposing a short total stream timeout;
- retain client cancellation so the Go request context closes promptly;
- provide a simple LAN HTTP mode and a documented hostname/TLS mode;
- publish no upstream administration UI.

The package's cloud use is private-network-only at this milestone. Do not add a
weak shared Basic Auth wrapper and call it public-internet security: current
stream URLs contain sensitive source material, and full device/session security
belongs to a subsequent API/client milestone.

## 10. System endpoints and version compatibility

Additive system endpoints are required:

- `GET /healthz`: liveness only; returns quickly while the process can serve.
- `GET /readyz`: verifies PostgreSQL and required initialized services; returns
  503 with non-secret component status when unavailable.
- `GET /v1/version`: returns application version, revision, build time, protocol,
  Go version, and architecture.

Example version response:

```json
{
  "serverVersion": "2.0.0-alpha.1",
  "revision": "0123456789ab",
  "builtAt": "2026-08-31T00:00:00Z",
  "protocolVersion": 1,
  "goVersion": "go1.24.2",
  "os": "linux",
  "arch": "arm64"
}
```

Do not change the meaning of the existing `/healthz` response until tests and
consumers are checked. A compatibility alias may be retained while the handler
is moved out of `main.go`.

## 11. Observability and resource behavior

- Preserve `backend.log` and `errors.log` redaction and rotation semantics.
- Emit startup configuration using safe booleans and paths, never secret values.
- Include build version, deployment mode, architecture, and diagnostic session.
- Add component readiness state for PostgreSQL and Prowlarr.
- Configure container log rotation so stdout cannot fill the disk.
- Set conservative Compose memory reservations/limits only after measurements;
  do not hide memory leaks with arbitrary restarts.
- Record Radxa idle, search, and one-stream memory/CPU measurements in the final
  test report. No release may exhibit OOM termination on the 4 GB target.
- Keep FlareSolverr optional when no configured indexer needs it if practical;
  its browser process is expected to be one of the larger memory consumers.

## 12. Compatibility boundary

Packaging is additive. These must continue to work unchanged:

- root Compose used by Electron;
- Windows backend build and installer flow;
- all current Go API routes and fields;
- direct byte-range playback and seeking;
- subtitle URLs and persistent cache;
- IMDb background refresh retaining last successful data;
- watch-progress source snapshots and resume rewind behavior;
- torrent cache safety and path-traversal protections;
- diagnostics redaction and error indexing.

New server configuration code must accept the existing Electron-provided names
and defaults. Container-specific defaults may be supplied by Compose, not by
changing behavior for a locally launched Version 1 backend.

## 13. Release artifacts

Each release must contain:

- multi-architecture `torwatch-server:<semver>` image manifest;
- resolved image digests for every service;
- the `deploy/torwatch-server/` bundle with no secrets;
- checksums for the downloadable bundle;
- release notes with supported architectures, migration notes, known issues,
  backup requirement, and rollback compatibility;
- a completed acceptance-test report.

The bundle and image version must match. A dirty or unknown revision may be used
for local development but must be rejected by the release workflow.

