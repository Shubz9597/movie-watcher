# Copy-ready implementation handoff

Implement the standalone TorWatch Version 2 server package described in
`docs/v2-server-package/`.

Before editing, read these files completely and follow them in order:

1. `docs/v2-server-package/README.md`
2. `docs/v2-server-package/architecture.md`
3. `docs/v2-server-package/implementation-plan.md`
4. `docs/v2-server-package/acceptance-tests.md`
5. `docs/v2-server-package/radxa-runbook.md`

Scope this work strictly to the deployable server package. Do not implement or
modify desktop remote mode, mobile clients, renderer catalog migration, HLS,
remuxing, or transcoding. Treat the root `docker-compose.yml` and current
Electron-managed flow as Version 1 compatibility surfaces. Add the standalone
stack under `deploy/torwatch-server/` and containerize the existing Go backend
for native Linux ARM64 and AMD64.

Execute the implementation plan phase by phase. Preserve every existing HTTP
route and response contract, move the required Prowlarr bootstrap responsibility
out of Electron into headless server-owned code, add health/readiness/version
support, create direct and verified embedded-VPN Compose modes, expose only the
gateway, use persistent bind mounts, pin release images, and implement safe
preflight/verify/backup/restore/update scripts.

Start by recording the baseline test results and inspecting the dirty worktree.
Do not overwrite unrelated changes. Keep `go test ./...` passing after every
checkpoint; run `go vet ./...`, the applicable race tests, `npm test`, Compose
configuration checks, image tests, disposable-stack integration tests, and the
Radxa acceptance matrix before declaring completion. Credential-dependent live
tests may be skipped only as documented; mandatory tests may not be skipped.

Do not expose the initial package to the public internet. Its supported access
boundary is a trusted LAN or private overlay until later application-level
authentication and opaque playback sessions exist.

At completion, provide:

- the implemented package and multi-architecture build path;
- a concise summary of behavior and files changed;
- exact deployment commands for the Radxa;
- a completed versioned test report under
  `docs/v2-server-package/test-reports/`;
- image and bundle versions/digests/checksums;
- any remaining limitations and exact rollback procedure.

Do not mark the task complete until the definition of complete in
`docs/v2-server-package/README.md` and every applicable mandatory acceptance
test are satisfied.

