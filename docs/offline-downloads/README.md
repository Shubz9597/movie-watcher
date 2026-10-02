# iPhone offline downloads and connection recovery

Implementation handoff · revised 2026-09-28 · design baseline `e6bb8fa` (recheck before implementation).

This packet defines the requested changes, architecture, wireframes, tasks, and definition of done. It authorizes implementation planning against these decisions; it is not evidence that downloads or native background behavior already work.

## Start here

1. [Specification](spec.md): product rules and the launch decision table.
2. [Visual wireframes](wireframes.html) and [evidence baseline](visual-reference.md): inspect Reference, Connection, Downloads, and iOS surfaces. The controls switch boards; phone controls are labelled static sketches.
3. [Wireframe behavior map](wireframes.md): actions, error variants, accessibility, and screen IDs.
4. [Architecture and change map](plan.md): current owners, changes, interfaces, migration, and native feasibility gate.
5. [Implementation tasks](tasks.md): ordered milestones, checks, and rollback.
6. [Definition of done](acceptance.md): individual pass/fail cases and evidence requirements.

Static previews: [Existing app references](captures/reference.png), [Connection](captures/connection.png), [Downloads](captures/downloads.png), [iOS surfaces](captures/system.png). The HTML board also adapts to a narrow viewport. Recreate the captures from the repository root with `node docs/offline-downloads/render-wireframes.mjs` (uses the existing Electron project's Puppeteer dependency).

The earlier experience brief was removed as superseded; `spec.md` incorporates its still-relevant product decisions, including showing server setup on first installation while keeping it out of subsequent outage recovery.

The 2026-09-28 owner revision removes automatic offline redirects and excess copy. Restore Home/last tab; Downloads remains one tap away. Preserve the actual app shell and setup screen, as shown by evidence and current source. Home failure is only Server unavailable, Retry, Go to settings.

## Release boundaries

- **C — connection behavior:** independently releasable; setup once, open the shell for returning users, Settings recovery, no disruptive redirects. This milestone must not pretend local downloads exist.
- **D — iPhone downloads:** persistent server preparation, native device transfers, complete local packages, local VLC playback and safe progress reconciliation.
- **N — iOS presentation:** local completion notifications and an ActivityKit Live Activity with stale-state handling.
- The full feature is done only after C, D, N and the physical-iPhone travel test pass. A Windows preview does not satisfy the native gates.
- Desktop/Android downloads, browser offline/PWA support, automatic season downloads, transcoding, public access, and APNs infrastructure are out of scope. Keep existing clients working.

OpenCode must finish or checkpoint its homeserver work before editing overlapping backend files. This packet does not change the active feature 001 checklist or claim its pending deployment gates passed.

## Handoff status

Documentation and wireframes prepared. Application code unchanged. Source/contract shapes in the plan are implementation targets; actual signatures must be finalized with tests at task D01 after inspecting the completed homeserver code. Native feasibility is mandatory evidence, not an unresolved product choice the agent may silently waive.
