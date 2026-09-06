<!--
Sync Impact Report
- Version change: 1.1.0 -> 2.0.0
- Modified principles:
  - I. Preserve the Viewing Journey -> I. Preserve Core Product Outcomes
  - II. One Product, Versioned Deployment Evolution -> II. Working Software at Every Checkpoint
  - III. Keep Runtime Ownership Explicit -> III. Shared BFF, Explicit Client Boundaries
  - IV. Evidence Before Change -> IV. Evidence and Migration Maps Before Change
  - V. Verify at Every Affected Boundary -> V. Tests Define the Safe Change Boundary
  - VI. Diagnostics and Secrets Are Product Requirements -> VI. Operability and Secrets Are Product Requirements
- Modified sections:
  - Product and Architecture Constraints
  - Version 2 Compatibility and Release Gates -> Version 2 Safe-Evolution Gates
  - Specification and Change Workflow
- Removed sections: none
- Follow-up TODOs: none
-->
# torWatch Constitution

## Core Principles

### I. Preserve Core Product Outcomes

Version 2 MAY substantially change torWatch architecture, deployment, APIs, and client composition,
but every releasable checkpoint MUST provide a complete, working path through the core product
outcomes that checkpoint claims to support. Those outcomes include discovering a title, selecting
the correct movie or episode, finding a viable source, starting playback, loading available
subtitles, persisting progress, and resuming later. A new feature MUST NOT make an already working
core outcome fail. Incomplete behavior MUST remain isolated, disabled, or unreleased rather than
being connected to the active product path. A feature is not complete merely because its new code
works in isolation; its affected end-to-end journeys MUST also work.

### II. Working Software at Every Checkpoint

Version 2 MUST be built as a sequence of small, working increments, never as a big-bang refactor.
Every task and reviewable checkpoint MUST compile, pass its applicable tests, and leave existing
unrelated behavior operational. Pure refactoring MUST preserve behavior and MUST be separated from
feature changes. When ownership or architecture moves, implementation MUST add and verify the new
path, migrate consumers, and only then remove the old path. Adapters, parallel implementations,
feature flags, or compatibility layers MUST be used when they are necessary to keep intermediate
states working. If a task cannot be completed without leaving the repository broken, it MUST be
split further or stopped for a revised plan.

### III. Shared BFF, Explicit Client Boundaries

Version 2 MUST establish one shared backend-for-frontend and server package as the authoritative
home for reusable catalog aggregation, torrent search, source selection, streaming, subtitles,
IMDb data, progress, resume, and other cross-client domain behavior. Desktop, mobile, web, and
future clients MUST consume explicit, versioned backend contracts and MUST NOT develop divergent
copies of shared business rules. Clients MAY own presentation, platform integration, local device
capabilities, and platform-specific playback controls. Contract changes are allowed when required
by an approved Version 2 specification, but the plan MUST identify every consumer, version or
migrate the contract, update affected clients, and prove the transition before obsolete behavior is
removed.

The first supported Version 2 deployment target MUST be a private homeserver. The backend package
MUST keep host-specific concerns behind configuration and deployment boundaries so that a later
cloud deployment can reuse the same application core. Public-cloud or public-internet operation is
not supported until a separate specification adds and verifies the required authentication,
authorization, session security, abuse controls, and operational hardening.

### IV. Evidence and Migration Maps Before Change

Specifications, plans, diagnoses, and fixes MUST be grounded in checked-in code, tests, and
reproducible runtime evidence. Before modifying an existing subsystem, the plan MUST record its
current responsibilities, callers, contracts, data, tests, and known failure behavior. Any move or
replacement MUST include a migration map showing old owner, new owner, affected consumers,
temporary compatibility mechanism, verification evidence, removal gate, and rollback path.
Contradictions between documents and implementation MUST be resolved explicitly rather than guessed
around. Work MUST remain within approved scope and preserve unrelated user changes in the working
tree.

### V. Tests Define the Safe Change Boundary

Tests MUST be established at the boundary being changed before destructive restructuring begins.
Backend logic requires focused unit tests; BFF endpoints require request, response, error, streaming,
and compatibility contract tests; persistence changes require migration and rollback tests; and
client changes require consumer, integration, build, and relevant end-to-end checks. A regression
test MUST accompany every corrected defect. Applicable narrow tests MUST pass after each task, and
the affected full suites MUST pass at each phase exit. Existing tests MUST NOT be deleted, weakened,
skipped, or rewritten merely to make a refactor pass unless an approved specification intentionally
changes the tested requirement. A required check that cannot run is a reported blocker, not an
implicit pass.

### VI. Operability and Secrets Are Product Requirements

Every deployed path MUST remain diagnosable through structured logs, correlation identifiers,
health and readiness signals, actionable errors, and safe failure behavior. New service and client
boundaries MUST preserve enough context to trace one user action across components. Credentials,
tokens, database passwords, private VPN material, and full magnet links MUST NOT be committed or
written to shareable logs. Configuration MUST fail clearly without echoing secret values. Backup,
restore, update, rollback, restart, persistence, and graceful shutdown are functional requirements
for the homeserver package, not optional operational polish.

## Product and Architecture Constraints

- The `v1.0.0` tag is the recorded Version 1 reference point. It is evidence of previously working
  behavior, not a permanent restriction on Version 2 architecture or contracts.
- Version 2 is allowed to add, replace, or relocate architecture when the change is specified,
  migration-safe, covered by tests, and complete across every affected consumer.
- The Version 2 BFF and backend package MUST be the common service used by all Version 2 clients.
  Shared domain behavior MUST live behind backend contracts rather than inside one preferred client.
- The first deployment milestone is a private Linux homeserver, including ARM64 and AMD64 where
  specified. Cloud portability MUST influence clean configuration and storage boundaries, but cloud
  support MUST NOT be claimed or expanded into the homeserver milestone.
- Version 1 and incomplete Version 2 paths MAY coexist during migration. Their ownership, ports,
  storage, processes, and Compose resources MUST be unambiguous and collision-free.
- The root Version 1 `docker-compose.yml` MUST NOT be silently repurposed. A standalone Version 2
  deployment MUST use its own explicit package and deployment path.
- Generated output directories MUST NOT be edited as source or committed as implementation.
- Product naming MUST use `torWatch`. Client experiences MAY differ by platform, but shared product
  terminology and backend semantics MUST remain deliberate and documented.
- Visual changes MUST follow `DESIGN.md` or an explicitly approved successor design specification.

## Version 2 Safe-Evolution Gates

- Before the first implementation change, the Version 2 feature MUST record the selected baseline
  commit, baseline test results, and a capability inventory of behavior that currently works.
- Every architectural phase MUST define a vertical slice with an observable user or operator
  outcome. A phase containing only disconnected scaffolding MUST identify how it remains safely
  inactive until its first working slice is complete.
- Moving behavior into the BFF MUST follow this order: characterize the current behavior with tests;
  define the new contract; implement the backend path; verify the backend path; migrate one consumer;
  verify that consumer end to end; migrate remaining consumers; then remove obsolete code.
- A shared contract MUST have one documented owner and tests for every in-scope consumer. A contract
  MUST NOT be renamed, removed, or semantically changed until those consumers are migrated or an
  explicitly versioned compatibility path exists.
- Structural refactoring and functional expansion MUST be separate tasks and SHOULD be separate
  commits so reviewers can distinguish preserved behavior from new behavior. When they cannot be
  separated, the plan MUST explain why and add verification for both the preserved and new behavior.
- Database evolution MUST use expand-migrate-contract sequencing where applicable. Migrations MUST
  be restart-safe and tested with representative prior data; destructive cleanup occurs only after
  the new code and rollback path have been proven.
- Partial implementations MUST be protected by an inactive route, feature flag, separate package,
  or other isolation boundary. Half-migrated code MUST NOT become the default runtime path.
- Each task MUST name its expected behavior, files or boundaries changed, focused verification, and
  rollback action. Each phase MUST end with full affected-suite verification and a recorded result.
- Refactor work MUST stop when an unexplained baseline regression appears. The regression MUST be
  diagnosed and either fixed within the approved scope or recorded for an owner decision before
  further restructuring continues.
- Version 2 releases MUST use immutable semantic versions and identify the exact source revision.
  A release candidate MUST pass its specification acceptance criteria, client-contract tests,
  homeserver deployment verification, and operational recovery tests.

## Specification and Change Workflow

1. Inspect repository status and identify the baseline commit, active branch, existing failures,
   affected components, and unrelated user work.
2. Write `spec.md` in terms of users, clients, operator outcomes, functional requirements, edge
   cases, exclusions, and measurable acceptance criteria. Do not let implementation convenience
   silently redefine the intended product.
3. Write `plan.md` with the target BFF boundary, client responsibilities, deployment boundary,
   contracts, data ownership, migration map, compatibility strategy, observability, security,
   rollout, and rollback.
4. Write `tasks.md` as small dependency-ordered vertical increments. Each task MUST leave the
   repository working, list its verification command or evidence, and have an unambiguous done state.
5. Capture missing characterization and contract tests before moving or deleting existing code.
6. Implement the new path beside the old path when required for continuity. Migrate and verify one
   consumer at a time; remove obsolete code only after its removal gate is satisfied.
7. Run focused checks after every task and full affected suites at every phase exit. Mark a task
   complete only after its behavior and verification evidence are both complete.
8. Review each diff for accidental deletions, mixed refactor and feature scope, broken callers,
   secret exposure, unhandled migration states, and undocumented contract changes.
9. Update the specification or plan when implementation evidence reveals a genuine requirement gap;
   do not silently diverge from approved artifacts.

For defects, begin with reproduction and diagnostics, add a failing regression test, repair the
smallest causal surface, and verify the complete affected journey. For Version 2 server-package
work, `docs/v2-server-package/` supplies initial architecture and acceptance context, but the active
approved Spec Kit feature artifacts govern the implementation and MUST incorporate later BFF and
multi-client requirements before those are built.

## Governance

This constitution governs all Spec Kit artifacts and implementation work in this repository. When
artifacts disagree, this constitution has precedence for engineering safety; the approved feature
specification defines intended behavior and scope; the approved plan defines current technical
direction; tasks define execution order; and code plus tests provide implementation evidence.

Amendments MUST be explicit changes to this file, include a Sync Impact Report, and identify any
specifications, plans, tasks, tests, or runtime behavior that require migration. Constitution
versions follow semantic versioning: MAJOR for incompatible principle removals or redefinitions,
MINOR for new or materially expanded governance, and PATCH for non-semantic clarification. Every
plan, phase exit, and implementation review MUST perform a constitution check. Exceptions require
an explicit rationale, affected scope, owner approval, expiry or removal condition, and follow-up
task; convenience or refactor speed alone is insufficient.

**Version**: 2.0.0 | **Ratified**: 2026-08-31 | **Last Amended**: 2026-09-03
