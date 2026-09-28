# Specification

## Outcome and scope

Prepare movies and episodes on an iPhone before travel. Reopen torWatch in airplane mode and browse, play, seek, use downloaded subtitles, and resume without a server connection. The first implementation targets the existing Capacitor iOS app. Shared React code remains reusable; desktop and Android downloads follow later.

## C: connection and launch

**C1 — configuration is durable, reachability is temporary.** A verified saved server address establishes configuration. A failed probe never clears it. A default localhost address or a preview query parameter is not evidence of completed phone setup. Migrate existing `mw_server_origin` without asking existing users to set up again. Keep a failed first-run address as a draft, separately from the active address.

**C2 — launch decisions (revised 2026-09-28).** Read local configuration/download inventory independently of network requests. Never await readiness or version discovery before rendering the returning user's shell. Restore the last valid tab, otherwise Home; expired playback routes are not auto-resumed. Reachability never chooses a tab. The Downloads tab is the direct route to local media, whether connected or not.

| Configuration / condition | Initial surface / permitted change |
|---|---|
| No saved server, no local downloads | WF01 setup; preserve draft after failure |
| No saved server, existing completed downloads | Restore Downloads so local files remain accessible; server setup is available in Settings |
| Saved server, check pending | Render shell immediately, last safe destination or Home; Downloads and gear usable |
| Check succeeds | Keep restored destination; load its online content where needed |
| Server unavailable/incompatible, downloads ready | Keep current tab. Home shows WF02 recovery; tapping Downloads opens WF06 |
| Server unavailable/incompatible, no downloads ready | Same route behavior; Downloads has a concise empty state |
| Check remains pending | Keep shell interactive. Bounded probe timeout updates availability only, never navigation |
| Connection fails during use | Stay on current screen; show recovery only for the affected online content |
| Connection returns | Refresh online capabilities/data; preserve route, focus, scroll, settings drafts, and local playback |

Resolve the initial route from configuration, saved tab, and explicit deep-link intent only. Delete the previous three-second routing deadline/interaction-latch proposal: there is no connection-triggered redirect to arbitrate. Returning from background preserves the current route. A notification/deep link to Downloads wins over tab restoration. OS-confirmed lack of connectivity may resolve failure early; internet reachability is not server reachability. Local inventory errors must surface a storage error and repair/retry, never imply there are zero downloads or erase inventory.

**C3 — first-time setup.** Reuse the existing LaunchScreen logo, positioning, URL field and Connect action. WF01 removes descriptive onboarding paragraphs; an error is one short line with preserved input. Validate syntax, reachability and protocol compatibility before activating the address. A reachable compatible server missing optional download/playback capabilities can be saved; show that limitation at the affected action. Do not interpret missing download support as a universal incompatibility. Local-network permission denial is distinct from a bad URL when the OS supplies that information. Never fabricate its cause from a generic timeout.

**C4 — Settings/retry.** Preserve the existing Settings2/sliders icon in the header (the app's settings control); do not replace the shell's icon language. Home recovery shows Server unavailable, Retry, and Go to settings, without explanatory paragraphs. WF03 reuses the current server editor with a short status, URL field, Test and save, and Back; detailed diagnostics stay behind disclosure. Failed candidates do not overwrite the active server. Retry checks the existing address without resetting history or config. Back preserves the previous page. Real server changes cancel old network work and scope caches/progress correctly; they do not delete downloads. Setup, Settings, and normal probes share the same validation and protocol logic.

**C5 — contextual availability.** Internally distinguish checking, unreachable, incompatible, and provider-degraded; expose only the status/recovery needed for the current action. An unavailable catalog provider affects catalog actions, not local playback. Local Downloads has no global server-warning banner: ready files show ordinary Play/Resume; interrupted items show their own short Waiting for server status. Library membership still comes from the existing server-owned library. Keep cached metadata visible without adding Saved information labels to every title. Building a complete offline catalog cache is not required. Collapse whole-page online failure into one recovery block rather than repeating errors per rail.

**C6 — copy and visual preservation.** Screenshots in `visual-reference.md` plus current AppShell/LaunchScreen source define the incumbent app. Extend those components. Keep implementation explanations in developer docs, not product screens. Do not add copy about where files stay, safe server changes, offline guarantees, future trips, or how to use the gear/tab bar. Retain necessary specific errors, meaningful size/state labels, and destructive confirmation. Preserve Home, Library, Search in their current order and append Downloads on supported clients.

## D: download behavior

**D1 — entry.** A labelled Download action on movie detail or a selected episode opens WF04. Reuse source selection, retain episode/file identity, disclose estimated/unknown bytes, selected external subtitles, included audio tracks, and free device space. No silent source replacement. Only validated playable originals are accepted; conversion and quality presets implying conversion are excluded. Ask for notification permission in context without blocking the download if declined.

**D2 — queue.** WF05 exposes preparing, ready to transfer, queued, transferring, paused, waiting for Wi-Fi/server, verifying, ready, failed, cancelled, and removing states. Download one video at a time initially; metadata/sidecars may use bounded concurrency. Preparing measures server acquisition; transferring measures bytes received by this device. Unknown totals stay indeterminate. Wi-Fi only defaults on; cellular is explicit. Show queue count, local usage, and Edit/Remove. Pause/resume/retry/cancel are persistent and recover after relaunch. Resume may restart from zero if the server or iOS cannot resume; explain that state rather than claiming retained progress.

**D3 — ready guarantee.** Ready requires a complete verified video, durable minimum metadata, and every selected required subtitle. Artwork failure uses a local placeholder. Subtitle failure offers Retry or an explicit Continue without subtitles choice; never silently mark the requested package complete. Move from staging to ready atomically. Phone files are independent of subsequent server cache cleanup. Missing/corrupt local files become Needs repair and cannot retain a misleading Play action.

**D4 — offline playback.** Use local file/track metadata in existing native VLC controls. Play must not create a server playback session, negotiate versions, fetch metadata, or wait for a heartbeat. Persist local progress and track selection on pause, seek completion, periodic playback checkpoints, and exit. A local playback error never silently starts network playback. No automatic eviction of ready files in v1; Remove confirms what is removed and never changes favourites/watch-later state.

**D5 — reconnect.** Synchronize local progress only to its original server identity. Retries are idempotent; preserve deliberate rewind and completion. If the server record changed since the offline base revision, retain both and show WF08's explicit position choice. Do not use client wall-clock time or furthest-position-wins to guess intent. Choosing a position produces a new conditional update; another concurrent change returns a new conflict, never a blind overwrite.

**D6 — preparation while suspended.** Use the supported v1 behavior: server preparation persists, but starting the phone transfer may require reopening torWatch if preparation finishes while iOS suspends the app. Keep this platform limitation in help/release notes and job details, not a permanent queue paragraph. Use Preparing and Ready to download as concise actionable states. Once a stable file is handed to background URLSession, test locked/suspended continuation. Fully unattended server-preparation-to-phone-transfer is not promised without a separately verified design.

## N: iOS system surfaces

**N1 — completion.** Native local notification after verified persistence, grouped per download batch, opening Downloads/item details. Failures needing action notify once; transient waiting does not spam. No completion notification based only on server readiness. Denied permission leaves all in-app behavior usable.

**N2 — Live Activity.** One per active device queue. Compact/minimal, expanded Dynamic Island, and Lock Screen views in WF09–WF11. Show current title, measured bytes/percentage and waiting count when space allows. Preparing and unknown-size states are indeterminate. Set stale content handling, end on completion/cancel, and reconcile on relaunch. Tapping opens Downloads. Native pause/resume buttons in the activity are deferred. Local updates are best effort under OS scheduling, not continuous execution. Notification authorization and Live Activity authorization are separate.

**N3 — compatibility.** Use availability guards and an appropriate extension deployment target; keep the host app's supported OS floor unless dependency evidence requires a separately documented change. Phones without Dynamic Island still have in-app progress, notifications when allowed, and Lock Screen activities where supported. No APNs service in this scope.

## Visual and accessibility contract

Follow `docs/mobile-ui/design-system.md`: near-black surface, white primary action, readable secondary labels, 48px shared touch targets and 44pt native targets, real safe-area insets, VoiceOver, 200% text, reduced motion, and accessible sheets. Add four-tab navigation only where the native downloads capability exists; fixture previews may explicitly simulate it. A normal browser or desktop must not imply it can save files offline. Preserve current existing navigation order for unaffected clients.
