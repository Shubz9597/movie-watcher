# TorWatch Version 2 server package handoff

Status: architecture and implementation instructions only. No Version 2 server
package has been implemented yet.

This directory is the authoritative handoff for creating a portable TorWatch
Server package that can run on a Radxa ROCK 3A or another Linux host. It is
deliberately limited to the server package. Desktop and mobile client changes,
catalog-provider migration, HLS/transcoding, and public-internet product work
are not part of this implementation.

## Read order

1. [architecture.md](architecture.md) defines boundaries, topology, deployment
   modes, compatibility rules, and the target repository layout.
2. [implementation-plan.md](implementation-plan.md) gives the ordered code and
   packaging work, down to planned files and commit-sized checkpoints.
3. [acceptance-tests.md](acceptance-tests.md) defines mandatory automated and
   manual verification. Existing tests are release gates, not suggestions.
4. [radxa-runbook.md](radxa-runbook.md) is the operator procedure the finished
   package must support.

For a new implementation chat, copy
[HANDOFF-PROMPT.md](HANDOFF-PROMPT.md) or give the agent that file as its task.

## Objective

Produce one versioned, multi-architecture deployment bundle containing the Go
backend and its infrastructure dependencies. A release must be installable with
Docker Compose, persist its state outside containers, survive host and container
restarts, expose only one application gateway to the home network, and retain
the current torrent search, source selection, byte-range streaming, subtitles,
IMDb ratings, progress, resume, buffering, and diagnostics behavior.

The first required target is a 64-bit ARM Radxa ROCK 3A with 4 GB RAM and SSD or
NVMe storage. The same artifacts must also support Linux AMD64.

## Non-negotiable constraints

- Do not modify Version 1's installed behavior as part of packaging work.
- Do not replace or repurpose the root `docker-compose.yml`; Electron currently
  owns its lifecycle. Add the new stack under `deploy/torwatch-server/`.
- Do not change or remove existing HTTP routes or response fields. Additive
  system endpoints are allowed.
- Do not move TMDb, AniList, Jikan, Cinemeta, or other renderer catalog logic in
  this workstream. That is a later BFF milestone.
- Do not add mobile, desktop remote-mode, HLS, remuxing, or transcoding code.
- Do not expose PostgreSQL, Prowlarr, FlareSolverr, or Gluetun control/proxy
  ports to the LAN.
- Do not publish release manifests using floating image tags such as `latest`.
- Do not commit credentials, generated Prowlarr API keys, VPN material, logs,
  databases, downloads, subtitle caches, or generated environment files.
- Do not claim public-internet safety. The initial package is supported only on
  a trusted LAN or behind a private overlay/VPN. Cloud placement is acceptable
  only when the gateway is private until application authentication and opaque
  stream sessions are delivered in a later milestone.
- Preserve direct HTTP byte-range streaming. A reverse proxy must not buffer or
  transform media and Server-Sent Events.

## Definition of complete

The package is complete only when all of the following are true:

- The files described in `architecture.md` exist and contain no secret values.
- A release build produces Linux ARM64 and AMD64 server images from the same
  source revision and embeds a visible server version.
- Base and embedded-VPN Compose configurations pass `docker compose config`.
- A clean Radxa installation follows `radxa-runbook.md` without repository
  source builds or Electron.
- Restart, persistence, range-streaming, backup, restore, update, and rollback
  checks pass.
- Every mandatory test in `acceptance-tests.md` passes.
- `go test ./...` and `npm test` still pass in their existing projects.
- A test report records commands, results, image digests, host architecture,
  and any intentionally skipped credential-dependent live checks.

## Instructions to the implementing agent

Begin by capturing the baseline commands and results described in the
implementation plan. Work in the listed order and keep changes small enough to
review. If a packaging change requires altering playback behavior or an existing
API contract, stop and document the conflict instead of silently expanding the
scope.
