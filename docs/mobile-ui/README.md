# torWatch mobile UI handoff

**Current checkpoint (2026-09-06):** M3.1 design/contract work is reported complete; M3.1.1 qualified-identity implementation is next and blocks persistence. Use [Resume on another PC](RESUME-ON-ANOTHER-PC.md) for transfer instructions and the current OpenCode prompt. The planning status and older continuation instructions below are historical; use the feature task ledger and dated evidence for implementation status.

Status: alpha design accepted by the owner on 2026-09-06; architecture and implementation handoff prepared. The owner considers the visuals below the desired final standard, so visual refinement remains open after alpha. No application code changed or runtime verified in this planning pass. The current checkout has substantial pre-existing work; do not treat checked task boxes or the older server handoff's status text as release evidence.

**For the current next step, give OpenCode [OPENCODE-CONTINUE.md](OPENCODE-CONTINUE.md).** The [prerequisite audit](PREREQUISITE-STATUS.md) found open server-phase verification and BFF migration work; the continuation prompt handles that before dependent mobile work. [OPENCODE-PROMPT.md](OPENCODE-PROMPT.md) remains the detailed mobile-only assignment. Start with [architecture.md](architecture.md) and [the file-level change map](change-map.md), then read [the spec](../../specs/002-mobile-shared-ui/spec.md), [implementation plan](../../specs/002-mobile-shared-ui/plan.md), [data model](../../specs/002-mobile-shared-ui/data-model.md), and [tasks](../../specs/002-mobile-shared-ui/tasks.md). Presentation and verification live in [the wireframe guide](wireframes.md), [design system](design-system.md), and [visual QA](visual-qa.md). [HANDOFF-PROMPT.md](HANDOFF-PROMPT.md) remains the shorter generic agent prompt.

The proposal is one React UI consumed by Electron and thin Capacitor iOS/Android shells. Shared component changes reach all clients when each client is rebuilt and released. Installed apps do not change merely because the Electron app was edited. Library changes sync through the BFF independently of app releases.

This extends the existing dark visual identity. It does not revive the legacy Next.js client. The mobile feature has its own specification and task IDs; it does not renumber or mark complete any Version 2 server tasks. The constitution and existing Version 2 contracts remain prerequisites. Alpha presentation is accepted; technical choices explicitly marked as experiments, including Capacitor/player choice and canonical identity verification, remain implementation gates.

Repository portability: root `PRODUCT.md` and `DESIGN.md` are currently ignored by `.gitignore`. They were updated locally, but this handoff carries the essential product assumptions and complete mobile design extension in ordinary documentation so another checkout can use them. If the root files are absent, use this README and `design-system.md` with current source as evidence; do not invent a new visual identity. No ignore rules were changed by this planning pass.

Planning revision: five boards now cover icon controls without capsule chrome, a Continue Watching carousel, collection/media Library hierarchy, torrent rows and expanded details, search filters and failure states. They replace the initial four-board draft. SVGs were rendered to PNG and opened for visual inspection; all 22 task IDs remain unstarted. Application suites, native builds, playback, performance, and Radxa behavior were not tested. Generate vectors with `node docs/mobile-ui/wireframes/generate.mjs`; PNGs are rasterized copies, not application screenshots.

## Skills and tools for the coding agent

In the authoring Codex session, **Impeccable**, Spec Kit and Gophers skills are available. Availability is not assumed in OpenCode: its prompt is self-contained, and optional missing skills do not block implementation. Repository `.opencode/commands/speckit.*.md` files are available for supported OpenCode workflows. If used, analyze first, implement tasks, then converge on missing work. Explicitly set `SPECIFY_FEATURE_DIRECTORY=specs/002-mobile-shared-ui`; the resolver also reads saved feature state and must not silently target feature 001.

A multimodal model must have screenshot-reading tools and browser automation for shared web surfaces, plus simulator/device capture for native checks. A skill alone does not provide a Mac, Xcode, simulator, signing identity, or Radxa. No extra plugin or image-generation skill is required to implement these vector wireframes. If the next agent lacks these tools, it must report the missing evidence, not certify mobile support.

## Defaults and decisions

- Reuse Electron React components; avoid a separate native UI rewrite. User confirmed reuse, smooth animation, and fast interaction. Thin installable shells remain the proposed delivery choice; Capacitor is a technical candidate subject to M1.
- One private household library initially, consistent with existing household-scoped Continue Watching. Favourites influence the household's suggestions. Device IDs identify clients; they are not users or authentication.
- Phone viewing is a core outcome, not just remote control of desktop playback.
- No public hosting, app-store publication, separate profiles, downloads, social features, or trained ML in this feature.
- Dark appearance remains the product direction. System font scaling, increased contrast, screen readers, and reduced motion still apply.

## Evidence and references

Code reviewed: `electron-app/src/App.tsx`, `globals.css`, `components/AppHeader.tsx`, `pages/PlayerPage.tsx`, `pages/WatchPage.tsx`, `lib/api-client.ts`, `lib/device-id.ts`, `lib/services/catalog-bff.ts`, plus the Version 2 API contracts. App startup currently asks `window.electronAPI` for catalog state; playback uses Electron MPV methods. The shared browser entry therefore needs real adapters, not a viewport-only CSS change.

Primary guidance checked on 2026-09-05: [Capacitor runtime](https://capacitorjs.com/docs), [Capacitor iOS and Xcode workflow](https://capacitorjs.com/docs/ios), [Apple safe areas](https://developer.apple.com/design/human-interface-guidelines/layout), [Android accessibility](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility), [Apple HLS](https://developer.apple.com/streaming/). Recheck supported toolchain versions when pinning dependencies. These sources establish platform capabilities and guidance; the architecture and feature behavior here are project proposals.
