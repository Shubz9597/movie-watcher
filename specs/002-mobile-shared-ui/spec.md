# Feature 002: shared mobile UI and household library

Status: implementation in progress as of 2026-09-12. The shared responsive UI, qualified catalog identity, household Library and sync, recommendations, desktop staging, and the server-side playback compatibility foundation are implemented with evidence; native Capacitor shells and physical-device playback remain open. Visual refinement also remains open because the owner considers the current design below the final quality target. User priority: iPhone first, Android second, with shared behavior and UI across mobile and Electron. See [plan](plan.md), [tasks](tasks.md), [architecture](../../docs/mobile-ui/architecture.md), and [change map](../../docs/mobile-ui/change-map.md).

## User stories and acceptance

| ID | Story | Observable acceptance |
|---|---|---|
| US1 | Browse and watch on iPhone | Connect to private server; search; open movie or series; choose episode/source; play, seek, select subtitles, stop and resume. Real iPhone evidence required for playback. |
| US2 | Save something for later | Add/remove a canonical title from Watch Later on either client; refresh another active client and observe the same membership; survives server/client restart. |
| US3 | Keep favourites | Favourite/unfavourite independently of Watch Later; dedicated Library tab; no duplicate entries or loss of the other flag. |
| US4 | Find a useful next title | Home suggestions use household favourites when available, have a truthful reason, exclude seed titles, and fall back to clearly labelled Popular picks without personal signals. |
| US5 | Keep platforms consistent | Change one shared TitleActions component; desktop, iOS, and Android builds show the same action labels and behavior with appropriate layouts. No duplicated screen implementations. |

## Requirements

- FR01: Shared React presentation, UI tokens, routing intent, and client contract layer. Platform-specific chrome, playback, storage, permissions, and lifecycle live behind adapters. Provider credentials and catalog assembly remain server-owned.
- FR02: Home, Search, Library (Watch Later/Favourites), title/episodes, source selection, player, and server settings cover the full journey. Continue Watching is a snap-scrolling carousel: artwork/play resumes, title opens detail, and dragging never plays. Library uses underlined collection tabs with Movies/Series/Anime shelves, full-scope counts and category grids; preserve canonical identity without duplicating anime under Series. Search media filters use a sheet. Torrents exposes release name, quality, size, seeders and known compatibility, with separate selection, details and Play actions. Preserve existing continuation and source-choice rules.
- FR03: Watch Later and Favourite are independent, idempotent booleans attached to a canonical catalog title, never a torrent hash, label, or device. Series entries represent the show, not each episode. Starting/completing playback does not automatically remove Watch Later or clear Favourite.
- FR04: Default scope is the private household, matching existing Continue Watching. Every connected device sees the same library and suggestions. Profiles and individual recommendations require a later feature. Do not reuse clientId as an identity or auth token.
- FR05: Pending changes are visible and serialized per title/field. Success is confirmed by server state; failure rolls back the pending display and provides Retry. Offline cached reads are labelled; offline writes are not queued in this milestone. Resume/refocus/reconnect refetches state. While active, poll at most every 15 seconds, pausing when hidden; healthy-server cross-client visibility target ≤20 seconds.
- FR06: Retried writes cannot duplicate membership; updating one flag cannot overwrite the other. Concurrent opposing writes to one flag resolve by server commit order, not unsynchronized device clocks. Server state wins on subsequent refresh.
- FR07: Recommendations are deterministic, bounded, server-side and explainable. Favourite genre overlap is the initial signal; no trained model, external AI call, or embeddings. Missing data and upstream failure never block Home or playback. Detailed algorithm and cache rules are in plan.md.
- FR08: Use the revised mobile design extension and wireframe screen IDs; support small phones, safe areas, keyboard, rotation, font scaling, accessible names, and screen reader navigation. Familiar toolbar actions use bare icons with 48px touch targets; no pill-shaped Back/Settings or search-like full-width Resume beneath cards. Bottom destinations keep icons and small labels; error/recovery copy stays readable. Desktop keyboard and MPV behavior stay intact.
- FR09: Capability-negotiated playback must distinguish supported media from unsupported container/video/audio/subtitle combinations. Provide a useful retry/choose-another-source path. Do not claim iPhone support based on desktop MPV or a browser screenshot.
- FR11 (OWNER DECISION 2026-09-12): The final mobile product is installed native iOS and Android applications; the shared React UI is packaged later with Capacitor. iOS playback uses a Swift AVPlayer adapter, Android a Kotlin Media3 adapter; both implement the shared TypeScript PlayerPort and consume ONE homeserver playback compatibility service (HLS/fMP4 + WebVTT; compatible sources direct-play). The browser/PWA player stays a development/staging tool. No separate mobile catalog/library/recommendation implementations are permitted.
- FR10: All builds use compatible versioned BFF contracts. An older server without Library capability yields an explicit unavailable state; it must not cause a renderer to store a divergent local library or contact providers directly.

## State and data ranges

Test first-run/no server, connecting, incompatible server, unreachable server, denied local-network permission, empty/populated library, pending/failed save, missing artwork, long title, mixed movies/series/anime, 0/1/100+ library entries with cursor pagination, empty search, failed provider, no recommendation candidates, and player buffering/unsupported/ended states. Episode lists must cover zero episodes, specials, unavailable next episode, and 100+ entries.

## Release gates and exclusions

UI work and fixture-driven review can proceed without the Radxa. iPhone playback and final homeserver verification cannot be waived because hardware is pending. M1 records the supported format/transport matrix and any necessary additional scoped work before promising universal playback. A browse-only preview is acceptable as an explicitly labelled intermediate checkpoint, not completion of US1.

No public-internet deployment, account system, background downloads, push notifications, casting, social features, guaranteed background/PiP playback, app-store submission, tablet release, or new recommendation infrastructure. Existing progress/session rules remain owned by feature 001.
