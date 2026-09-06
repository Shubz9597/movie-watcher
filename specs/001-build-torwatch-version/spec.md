# Feature Specification: TorWatch Version 2 — Shared Backend and BFF for Multiple Clients

**Feature Branch**: `001-build-torwatch-version`

**Created**: 2026-09-04

**Status**: Draft

**Input**: User description: "Build TorWatch Version 2 as a shared backend and BFF used by multiple client applications"

## Clarifications

### Session 2026-09-04

- Q: When two clients want to watch the same title or episode at the same time, should the watch lease allow both to stream concurrently or only one? → A: Shared per-title leases (V1 model preserved): multiple clients may concurrently hold leases and stream the same title or episode; torrent and buffer resources are released only after every lease for that key has expired or gone stale. Resource pressure is not modeled as lease takeover; any global capacity or resource admission policy must be specified separately and must return a visible, non-destructive outcome without terminating healthy existing leases.
- Q: Where does the stable client/device identifier come from — client-generated or backend-issued? → A: Client-generated: each client creates a cryptographically random UUID on first run, persists it locally, and sends it as an untrusted opaque client identifier; the backend validates format and length only, never treats it as authentication. It is used for lease ownership, stream-session correlation, last-writer metadata, and diagnostics — not as the sole watch-progress ownership key. Reinstallation generates a new ID without server registration; a future authentication milestone may associate device IDs with accounts or profiles.
- Q: When two clients save watch progress for the same item around the same time, which deterministic rule decides the stored position? → A: Last-write-wins by successful server commit order, never a client-provided timestamp. Each update stores a monotonically increasing progress revision, server updated_at, last-writer client ID, and stream-session ID. Within one stream session, an update whose client sequence number is older than the latest accepted sequence for that session is rejected/ignored (prevents delayed heartbeat retries from moving progress backward). A deliberate rewind or replay from a currently valid session is a valid new write. Furthest-position-wins is prohibited because it breaks intentional rewinding and episode restarts.
- Q: Who enforces the compatibility decision when client and server run different protocol versions — the server or the client? → A: Client-decided: the server publishes application version, protocol version, supported protocol range, and capability flags; each client compares ranges before starting a workflow, uses the highest mutually supported protocol when ranges overlap, and blocks only the incompatible workflow with an actionable upgrade message when they do not (health/readiness/version discovery stay accessible). The server returns machine-readable unsupported_protocol or unsupported_capability errors (including the server-supported range) for requests it cannot serve, and never rejects a client merely because its application version differs. Compatibility comes from protocol ranges and capabilities, not application version numbers.
- Q: On the 4 GB target host, is concurrent streaming of different titles guaranteed or best-effort? → A: The guaranteed envelope is one active title/episode resource set plus required background work; multiple clients streaming the same title/episode are supported through shared torrent and buffer resources subject to available network bandwidth. An additional different-title stream is best-effort: admission is deterministic and configurable, based initially on the number of active distinct torrent/resource keys (not live-memory guesses); when capacity is unavailable only the new stream request is rejected with a machine-readable capacity_exceeded response and retry guidance — never terminating or taking over an existing healthy stream or lease. Higher-capacity homeservers and later cloud deployments may configure and verify larger limits without changing the client contract.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete viewing journey through one backend API (Priority: P1)

A user of any TorWatch client searches for a movie, series, or anime title and completes the entire journey — catalog browsing, title and episode discovery, torrent source resolution, playback, subtitles, and later resume — using only the TorWatch backend. The backend acts as a Backend-for-Frontend (BFF): it aggregates catalog provider data server-side and presents one coherent, client-neutral API, so clients no longer need to call TMDb, AniList, Jikan, Cinemeta, or other providers directly.

**Why this priority**: This is the defining capability of Version 2. Today catalog aggregation lives in the Electron renderer, which makes every non-Electron client incomplete. Moving the aggregation behind one API makes the backend self-sufficient and is the prerequisite for every other client.

**Independent Test**: Can be fully tested by pointing a bare API client (no provider access, no Electron) at the backend and completing search → title detail → episode list → source pick → stream → progress save → resume. Delivers a backend that is the single source of the viewing journey.

**Acceptance Scenarios**:

1. **Given** a running TorWatch V2 backend, **When** a client searches for a title by name, **Then** it receives unified catalog results (merged from the integrated providers) without the client contacting any external catalog provider itself.
2. **Given** a selected title with episodes, **When** the client requests title/episode detail, **Then** the backend returns the metadata, images, and identifiers needed to reach a playable source.
3. **Given** a chosen title or episode, **When** the client requests source resolution, **Then** the backend performs torrent discovery and deterministic highly-seeded source selection and returns a playable stream URL.
4. **Given** playback of a resolved source, **When** the client streams with range requests and later reconnects, **Then** byte-range streaming, seeking, subtitle delivery, and saved-progress resume all work through the backend.

---

### User Story 2 - A second client application achieves the same journey (Priority: P2)

A second, non-Electron client application (for example a lightweight remote viewer or a mobile/web client) connects to the same backend and completes the same search-to-resume journey as the Electron desktop app, with no per-client backend changes. The BFF surface is client-neutral: it does not assume Electron, a specific platform, or renderer-side provider calls.

**Why this priority**: "Used by multiple client applications" is the core Version 2 promise; it only becomes real once at least one additional client works against the same API without forking backend behavior.

**Independent Test**: Can be fully tested by standing up a minimal second client that uses only the public backend API and completing the same P1 journey, then confirming the Electron app continues to work unchanged against the same backend.

**Acceptance Scenarios**:

1. **Given** the V2 backend and two different clients, **When** both perform the same search and playback journey, **Then** both succeed using the same endpoints and response contracts.
2. **Given** watch progress saved by one client on a title, **When** the other client opens that title, **Then** it observes the shared saved progress and can resume from it.
3. **Given** both clients stream concurrently from the same backend host, **Then** each stream remains functional and the backend enforces sane watch-lease/stream behavior without corrupting either session.

---

### User Story 3 - Versioned, deployable shared service with protocol compatibility (Priority: P3)

An operator deploys the V2 backend as a centrally running service (the shared server package form) on the trusted LAN, and multiple clients connect over the network. The backend exposes system/version endpoints with a declared API protocol version, so clients can verify compatibility and be upgraded independently of the server.

**Why this priority**: A shared backend used by multiple clients must be operable and upgradable as a standalone deployment; otherwise each client would keep shipping its own backend, defeating the purpose. It ranks below the functional journeys because it enables durability of the above, not the core value itself.

**Independent Test**: Can be fully tested by deploying the release bundle on a clean host, connecting two clients over the LAN, and verifying health/readiness/version reporting and an independent client/server upgrade path.

**Acceptance Scenarios**:

1. **Given** a clean host, **When** the operator installs the V2 server package following the runbook, **Then** the backend starts with persisted data and is reachable by clients through a single gateway entrypoint.
2. **Given** any connected client, **When** it queries the system/version endpoints, **Then** it receives the server version, revision, build time, protocol version, supported protocol range, and capability flags, and can detect a non-overlapping protocol range before starting an incompatible workflow.
3. **Given** a server restart or upgrade, **When** clients reconnect, **Then** watch progress, continue-watching, source picks, and subtitle cache behavior are preserved.

---

### User Story 4 - Version 1 behavior preserved through safe migration (Priority: P4)

During the V2 migration, every previously working behavior — including the existing Electron application's flows — keeps working at each migration checkpoint. Version 2 MAY change architecture and replace V1 contracts, but only through migration-safe transitions: characterization tests are captured before refactoring, new backend/BFF paths are implemented and verified beside the old paths, each affected client is migrated and verified, versioned contracts or compatibility adapters serve old clients while they remain, and obsolete routes are removed only after their documented removal gates pass. The required outcome is zero unexplained regressions, not permanent API identity. The legacy Next.js frontend remains decommissioned and is not a target surface.

**Why this priority**: Working software at every checkpoint is a product principle, but it is a constraint on the other stories rather than standalone user value; it protects working behavior while V2 lands.

**Independent Test**: Can be fully tested by running characterization tests, the existing backend and client suites, and manual search→playback→resume checks at each migration checkpoint, confirming that any behavior difference is an approved, specified contract change and nothing regresses unexplained.

**Acceptance Scenarios**:

1. **Given** any migration checkpoint, **When** the existing Electron client runs its normal flows (search, source selection, playback, subtitles, progress, resume, diagnostics), **Then** all previously working behavior works, and any difference is an explicitly specified, approved contract change rather than a regression.
2. **Given** catalog aggregation being moved behind the BFF, **When** the Electron renderer stops calling catalog providers directly, **Then** characterization tests captured the prior behavior first, the new backend path was implemented and verified before the old path was removed, and the user-visible catalog experience is equivalent to Version 1.
3. **Given** a V1 route replaced by a versioned V2 contract, **When** old clients are still deployed, **Then** a compatibility adapter or versioned path serves those clients until each affected client has been migrated and verified and the route's removal gate passes; obsolete routes are not removed earlier.

---

### Edge Cases

- What happens when a catalog provider is down, rate-limited, or returns partial data? The BFF must degrade gracefully (serve remaining providers, stale-but-valid cached metadata, or a clear error) rather than failing the whole search.
- What happens when torrent discovery finds no viable, well-seeded source? The backend must return an explicit "no viable source" outcome the client can present, not an opaque error or hang.
- What happens when two clients watch the same title or episode concurrently? Both may hold leases and stream concurrently (shared per-title lease model); torrent/buffer resources are released only when every lease for that key has expired or gone stale, and lease state changes are visible to affected clients.
- What happens when a new stream request arrives while capacity is unavailable? Only the new request is rejected with a machine-readable `capacity_exceeded` response and retry guidance; existing healthy streams and leases are never terminated or taken over.
- What happens when clients run different protocol versions than the server (older client, newer server or vice versa)? The client detects the non-overlapping protocol range and blocks only the incompatible workflow with an actionable upgrade message; the server returns a machine-readable `unsupported_protocol`/`unsupported_capability` error for requests it cannot serve, and never rejects a client merely for a different application version.
- What happens when a client disconnects mid-stream? The backend must reclaim the stream/buffer resources promptly and persist progress up to the last reported position.
- What happens when the server restarts during active streaming? Clients must be able to reconnect and resume via range requests without corrupted downloads or progress.
- How does the system handle provider data conflicts (differing titles, artwork, episode numbering across providers)? Resolution/merge rules must be deterministic for a given query.

## Requirements *(mandatory)*

### Compatibility and Contract Evolution

This specification distinguishes four separate commitments, and no requirement
may blur them:

- **Preserved core product outcomes (permanent)**: discovery, source resolution,
  playback, subtitles, progress, and resume MUST remain available as a complete,
  working path through the backend at every releasable checkpoint. This is a
  durable obligation.
- **Temporary Version 1 compatibility (migration-scoped)**: existing V1 routes,
  fields, and client flows are kept working during migration so no checkpoint
  breaks a working product. They are not frozen forever; they MAY be replaced
  once their documented removal gates pass.
- **Intentional Version 2 contract evolution (explicit, planned)**: V2
  introduces versioned backend contracts (new BFF endpoints, protocol version)
  and MAY change or retire legacy contracts through migration-safe transitions
  that are specified, tested, and verified per affected client.
- **Permanent compatibility (only where explicitly specified)**: only
  commitments explicitly marked permanent in this specification (core product
  outcomes; preservation of persisted user data such as watch progress, source
  picks, and subtitle caches across restart/upgrade) are durable obligations. No
  legacy API shape is permanent by default.

### Functional Requirements

**Backend-as-single-source (BFF)**

- **FR-001**: The backend MUST aggregate catalog provider data (the providers currently integrated, e.g., TMDb and AniList/Jikan) server-side and expose unified search, catalog sections, title detail, and episode detail endpoints so clients complete discovery without direct provider access.
- **FR-002**: The backend MUST deliver the V1 core responsibilities — Prowlarr-backed torrent discovery, deterministic source selection with persisted picks, torrent acquisition/cache/buffering, HTTP range streaming, subtitle discovery/delivery, IMDb ratings, watch progress/continue-watching/resume, and watch leases — as working behavior at every migration checkpoint. Where V2 moves or replaces one of these responsibilities, the transition MUST follow the safe-evolution sequence: capture characterization tests of the current behavior before refactoring, implement and verify the new backend/BFF path beside the old one, migrate and verify each affected client, and remove the old path only after its documented removal gate passes.
- **FR-003**: The BFF API MUST be client-neutral: no endpoint, field, or behavior may require the Electron renderer, a specific platform, or renderer-resident credentials.
- **FR-004**: The backend MUST expose the system endpoints for liveness, readiness, and version/protocol information, and the version payload MUST include server version, revision, build time, protocol version, supported protocol range, and relevant capability flags.

**Multi-client support**

- **FR-005**: The backend MUST support at least two concurrently connected client applications performing search, playback, and progress updates against one deployment.
- **FR-006**: Watch progress MUST be stored per title/episode under the deployment's default household/profile subject (shared across clients). Conflict handling MUST be last-write-wins by successful server commit order, never by a client-provided timestamp; furthest-position-wins MUST NOT be used (it would break intentional rewinding and episode restarts). Each progress update MUST store a monotonically increasing progress revision, server updated_at, last-writer client ID, and stream-session ID. Within the same stream session, an update whose client sequence number is older than the latest accepted sequence for that session MUST be rejected or ignored so a delayed heartbeat retry cannot move progress backward; a deliberate rewind or replay from a currently valid session remains a valid new write. The client identifier MUST be recorded as last-writer metadata but MUST NOT serve as the sole progress-ownership key.
- **FR-007**: The backend MUST preserve the V1 shared per-title watch-lease model: multiple clients MAY concurrently hold leases and stream the same title or episode, and torrent/buffer resources for a key MUST be released only after every lease for that key has expired or gone stale. Lease state changes MUST be observable to affected clients. Concurrent-stream capacity MUST be governed by a deterministic, configurable admission policy based initially on the number of active distinct torrent/resource keys (not unreliable live-memory guesses). When capacity is unavailable, the backend MUST reject only the new stream request with a machine-readable `capacity_exceeded` response and retry guidance, and MUST NOT terminate or take over an existing healthy stream or lease. Resource pressure MUST NOT be modeled as lease takeover.

**Deployment & compatibility**

- **FR-008**: The backend MUST be deployable as a shared network service reachable by all clients through a single gateway entrypoint, with internal dependencies (database, Prowlarr, optional VPN/challenge helper) not exposed to the client network.
- **FR-009**: The backend MUST support deployment on the target small ARM host and on AMD64 Linux from the same release artifacts, with persisted state surviving restarts.
- **FR-010**: Existing V1 routes, fields, and behaviors MUST keep working at every migration checkpoint, but their exact API identity is NOT permanently frozen: Version 2 MAY replace, move, or redesign them under versioned contracts or compatibility adapters. For each affected route the plan MUST: capture characterization tests before refactoring; implement and verify the new backend/BFF path before the old path is removed; migrate and verify each affected client; keep versioned contracts or compatibility adapters in place while old clients remain supported; and remove obsolete routes only after their documented removal gates pass (no remaining consumer, contract tests green, rollback path recorded). The required outcome is zero unexplained regressions, not permanent API identity. The Windows/local V1 build-and-launch flow MUST continue to work until its own documented removal gate passes.
- **FR-011**: Client/server compatibility MUST be determined from protocol ranges and capability flags, never from application version numbers. The server MUST publish its application version, protocol version, supported protocol range, and relevant capability flags. Each client compares the advertised range with its own supported range before starting a workflow: on overlap it uses the highest mutually supported protocol; on non-overlap it blocks only the incompatible workflow with an actionable upgrade message, while health, readiness, and version discovery remain accessible. The server MUST return a machine-readable `unsupported_protocol` or `unsupported_capability` error, including the server-supported range, when a request asks for a protocol or feature it cannot serve, and MUST NOT reject a client merely because its application version differs. This enables independent upgrade of clients and server.
- **FR-012**: Secrets, API keys, magnets, and VPN material MUST be redacted from logs and diagnostics in all new backend/BFF code paths.

**Deferred to later milestones (explicit non-goals here)**

- **FR-013**: Client pairing and authentication are strictly deferred from the initial homeserver milestone. The initial deployment is supported only on a trusted LAN or private overlay. Each client generates a cryptographically random UUID on first run, persists it locally, and sends it as an untrusted opaque client identifier; the backend validates its format and length but does not treat it as authentication or a security boundary. The identifier is used for lease ownership, stream-session correlation, last-writer metadata, and diagnostics — never as the sole watch-progress ownership key. If a client is reinstalled and loses its local ID, it generates a new one without server registration; a future authentication milestone MAY associate device IDs with accounts or profiles. Public-internet or cloud exposure is out of scope for this milestone and MUST NOT be enabled until a later security specification adds and verifies authentication, authorization, opaque stream sessions, and abuse controls.
- **FR-014**: HLS/transcoding/remuxing and mobile-specific playback adaptations are out of scope for this milestone.

### Key Entities *(include if feature involves data)*

- **Title**: A movie, series, or anime work with provider-sourced metadata, artwork, and identifiers; merged deterministically across providers.
- **Episode**: A playable unit of a series/anime title with ordering and provider identifiers.
- **CatalogSection**: A curated or computed collection of titles (e.g., trending, continue watching) served by the BFF.
- **SourcePick**: The deterministic, persisted torrent source chosen for a title/episode, with its scoring inputs.
- **StreamSession**: An active playback stream served to a client, tied to a source and one of possibly several concurrent watch leases for that key.
- **WatchProgress**: Per title/episode saved position and completion state, shared across clients under the deployment's default household/profile subject, carrying a monotonically increasing revision, server updated_at, last-writer client ID, and stream-session ID; source snapshot retained for resume rewind.
- **Client/Deployment**: A connecting client application identified by a client-generated, locally persisted cryptographically random UUID sent as an untrusted opaque identifier; used for lease ownership, stream-session correlation, last-writer metadata, and diagnostics — never as a credential, security boundary, or sole progress-ownership key; reinstallation generates a new one without server registration (see FR-013).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client with no direct access to any external catalog provider can complete search → title/episode detail → source resolution → playback → resume using only backend endpoints.
- **SC-002**: Two different client applications can concurrently perform the full journey against one backend deployment, including shared resume of the same title, with zero per-client backend code changes.
- **SC-003**: Every migration checkpoint leaves pre-existing client flows working, verified by characterization tests, existing test suites, and the compatibility checklist. Each moved or replaced route has its new path implemented and verified before removal, each affected client migrated and verified before removal, and the V1 Electron flow has zero unexplained behavior breaks (behavior differences exist only as approved, specified versioned contract evolution).
- **SC-004**: The backend deploys on a clean target host from release artifacts alone (no repository builds, no Electron) and reports health, readiness, and version/protocol to clients.
- **SC-005**: A server restart or client upgrade preserves watch progress, continue-watching, source picks, and subtitle cache with no data loss attributable to the V2 migration.
- **SC-006**: The deployed backend stays within the resource envelope of the 4 GB target host — one guaranteed active title/episode resource set plus required background work — with no out-of-memory termination. Multiple clients streaming the same title/episode are supported through shared torrent and buffer resources subject to available bandwidth; an additional different-title stream is best-effort and, when capacity is unavailable, rejected with a machine-readable `capacity_exceeded` response and retry guidance (never by terminating or taking over existing healthy streams or leases). Higher-capacity deployments may configure larger concurrent-stream limits without changing the client contract.

## Assumptions

- The trusted-LAN/private-overlay security posture from the Version 2 server-package handoff carries over; public-internet exposure and full application authentication remain a later milestone.
- The Go backend in `torrent-streamer/` remains the single modular backend; V2 does not split it into microservices — it extends its boundary into a client-neutral BFF.
- Catalog provider integrations (TMDb, AniList/Jikan, Cinemeta) move from the Electron renderer into the backend; their existing behavior and coverage are preserved.
- The legacy Next.js frontend stays decommissioned and is not a V2 client target.
- The second client (P2) is initially exercised via a minimal test/reference client; a polished third client product is not part of this milestone.
- Deployment follows the server-package direction already documented under `docs/v2-server-package/` (single gateway, bind-mounted persisted state, optional embedded VPN), extended to serve multiple clients.
