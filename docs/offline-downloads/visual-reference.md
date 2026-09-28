# Visual baseline and revision — 2026-09-28

The owner rejected the first wireframe draft's explanatory copy and generic shell. Build the feature into the existing app. This revision supersedes earlier text about automatically routing to Downloads during a connection failure.

## Evidence inspected

| Reference | Keep / interpretation |
|---|---|
| [Library](../../specs/002-mobile-shared-ui/evidence/captures/m25/library-390x844.png) | Existing TV logo, connection indicator, search and Settings2 icons, dark header, title scale, separators, bottom destinations |
| [Title](../../specs/002-mobile-shared-ui/evidence/captures/m25/title-390x844.png) | Existing title backdrop, metadata, saved-item/source controls and content hierarchy; add Download locally rather than replace title design |
| [Search](../../specs/002-mobile-shared-ui/evidence/captures/m25/search-sheet-390x844.png) | Existing poster/content styling; reference imagery for the download mockup only |
| [Home](../../specs/002-mobile-shared-ui/evidence/captures/m25/home-390x844.png) | Home/Library/Search navigation and media hierarchy; this capture does not prove current connected content or header behavior |
| [Connection failure](../../specs/002-mobile-shared-ui/evidence/captures/live-switch-unreachable-gate-phone.png) | Existing centered URL form and Connect treatment; do not preserve raw TypeError diagnostics or use this gate for returning-user outages |
| [Earlier title](../../specs/002-mobile-shared-ui/evidence/captures/fixture-title-phone.png) and [source selection](../../specs/002-mobile-shared-ui/evidence/captures/fixture-source-selected-phone.png) | Existing feature organization; earlier logo differs, so use current source asset rather than copying obsolete branding |

Source cross-check: `electron-app/src/components/shared/AppShell.tsx` currently imports `torwatch-app-icon.png`, Search and Settings2, and orders Home, Library, Search. `LaunchScreen.tsx` now includes the centered logo/splash, URL field and Connect button. This newer source wins over an older capture's missing logo or raw exception text. The mockup uses the actual current logo asset. Evidence screenshots remain untouched.

## Decisions

- Keep the header, logo, icon language, existing destinations and first-setup composition. Append Downloads after Search.
- Home failure: Server unavailable, Retry, Go to settings. Keep navigation visible. No tips or explanations below it.
- Downloads is reached through its tab. No network-driven navigation, including on cold launch. Restore last valid tab, otherwise Home. Local-files-with-missing-configuration recovery remains the narrow exception.
- Downloads is an ordinary media page. No Your downloads are ready to play banner, Saved information labels, or repeated on this iPhone qualifiers.
- Item states are concise: Preparing, Downloading, Paused, Waiting for server, Ready, Needs repair. Show only relevant actions and measured metrics.
- Preserve Settings' ability to change URL and show errors; omit prose about retention or safe server switching. Those guarantees remain implementation requirements.
- Retain essential warnings at the moment of an actual decision: remove a file, insufficient space, unavailable selected subtitles, or resume conflict. Concision must not hide an action's consequences.
- Platform limitations belong in help/release notes/job details. System notifications are similarly short: Download complete + title/episode. Developer annotations appear outside phone frames only.

The new Reference board displays the original captures beside the proposed boards for implementation comparison. WF12 demonstrates one additive Download affordance over the existing title screenshot; it is a labelled design overlay, not a claim of changed application code. Small poster crops reuse the existing local evidence image as CSS layout; no new downloaded media is introduced.
