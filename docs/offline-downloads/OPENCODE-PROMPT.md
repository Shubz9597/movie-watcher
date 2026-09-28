# OpenCode implementation prompt

Implement the iPhone connection recovery and offline downloads feature defined in `docs/offline-downloads/`.

First finish or checkpoint the homeserver task already in progress and inspect the current branch, git status and actual baseline revision. Preserve unrelated changes. Do not assume the design-time SHA or old checklist matches the current code.

Read `.specify/memory/constitution.md`, applicable AGENTS.md files, and the current feature 001/002 contracts. Then read this packet in order: `README.md`, `spec.md`, `wireframes.md` and `wireframes.html`, `plan.md`, `tasks.md`, `acceptance.md`. The initial `experience-brief.md` is historical; spec.md supersedes it.

The user has delegated architecture decisions to Codex. Follow these product decisions:

- First installation asks for the server URL. Preserve failed input. Save only after validation and compatible protocol discovery; optional capability absence has its own message.
- Once a server is configured, launch the shell independently of network probes. Keep gear/Settings and Retry accessible. Do not return to onboarding because a saved server is unavailable.
- Restore Home/last valid tab independently of reachability; users open Downloads through its permanent tab. No outage-triggered redirect or three-second route timer. Notification/deep links take precedence. Mid-session outage/reconnection never changes route or interrupts local playback.
- Follow the 2026-09-28 visual revision and visual-reference.md: extend the existing logo/header/connection screen, preserve Home/Library/Search order, append Downloads, and retain the current Settings2 icon. Home failure shows only Server unavailable, Retry and Go to settings. Downloads has no redundant server banner or instructional paragraphs. Keep implementation explanations in documentation.
- iPhone is the first download platform. Keep the shared React/Capacitor UI and existing VLC player. Add native background URLSession downloads and persistent local inventory. Do not implement JavaScript background polling as the download engine.
- Download preparation on the homeserver is separate from transfer to the phone. Ready means verified local media plus requested required sidecars and durable metadata. Server preparation completing while the app is suspended may require reopening to start transfer; disclose this supported v1 limit.
- Local playback works with no server session, metadata request or successful connection check. Scope offline progress by server instance and reconcile with conditional idempotent updates and explicit conflicts.
- Add contextual completion notifications and one ActivityKit queue Live Activity, including Dynamic Island and Lock Screen layouts, OS/authorization guards, stale content and tap-to-Downloads. Do not claim continuous updates or introduce APNs/public server exposure in this scope.

Execute the tasks in small verified checkpoints. Ship connection milestone C independently, then complete D and N. Keep unfinished downloads paths disabled in production. Finalize and test the proposed server/native contracts at D01 before consumers; use additive versioned capabilities and migrations. Do not silently repurpose existing stream/watch session contracts for durable download retention.

Use the visual wireframes as the layout/action/state contract, with existing design-system tokens and real icons/content. They are static sketches, not production code. Add actual loading, error, empty, keyboard, large-text, permission and stale states described in wireframes.md. Do not copy fixed preview frame heights into the app.

Run appropriate existing tests/builds and all acceptance cases. The signed physical-iPhone experiment, native background behavior, local VLC playback, notifications, Dynamic Island and final airplane-mode travel test require device evidence. Continue safe independent work when hardware is unavailable, but leave those tasks pending and report the exact commands/actions needed; never substitute browser screenshots for a native pass.

Write evidence under `docs/offline-downloads/evidence/`, update task checkboxes honestly, and record behavior-changing test updates against requirement IDs. Avoid unrelated desktop/Android refactors, deployment rewrites, cleanup or legacy removals. Do not merge, push or publish as part of this prompt.

At handoff, report files changed, acceptance IDs passed/failed/pending, real-device versus fixture evidence, known platform limits, required server/client versions, rollback and data-preservation behavior, and an accurately scoped status: Connection milestone complete, iPhone feature ready, or blocked with the remaining requirements.
