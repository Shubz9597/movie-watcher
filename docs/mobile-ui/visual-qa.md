# Visual and performance verification for a multimodal agent

Reading images is mandatory. A successful build, browser DOM assertions, CSS inspection, or a generated mockup is not evidence of a working mobile interface.

## Evidence setup

Create an ignored/local `artifacts/mobile-ui/<revision>/` evidence directory (review ignore rules before changing them); commit a concise report with reproducible fixture IDs and links that another reviewer can access. Do not include credentials, real household history, magnets, or private server addresses. Use synthetic catalog content, fixed time, cached placeholder artwork, and deterministic flags/recommendations. Screens must render real application components with dependency-injected fixtures, never a parallel mock page that only resembles them.

Capture filenames: `<platform>-<viewport>-<screen>-<state>-<before|after>.png`. Report each platform's app revision, build command/result, runtime/OS, fixture, device or emulator, dimensions, font scale, appearance, network state, and output paths. Do not invent paths for captures that do not exist. Native builds may run on another host; preserve source revision and report those results separately.

## Capture matrix

| Surface | Required cases |
|---|---|
| Shared browser UI | 320×568 stress, 375×667 small phone, 390×844 primary, 430×932 large phone; 360×800 Android-sized layout; 844×390 landscape; 768×1024 resize sanity; 1440×900 desktop |
| Default-size phone flows | WF01/02/03/04/05/06/08 normal; film/show/anime detail; WF07 supported/unsupported/buffering |
| Stress states | 390×844 search keyboard; empty/failure/pending; long text and missing art; 200% text; 100-title grid and long episode list; reduced motion |
| iOS wrapper | Small and notched simulator profiles; real iPhone supported media, safe areas, permissions, keyboard, back, VoiceOver, system text scaling, lifecycle |
| Android wrapper | Emulator plus real Android device; keyboard/Back/predictive Back where supported, insets, TalkBack, large font, playback and interruptions |
| Electron | Actual Electron captures of Home/detail/Library and player; compact resize and desktop size; titlebar, search shortcut, focus, MPV regression |

Revision-specific evidence: Continue carousel at first/middle/end scroll position; dragging versus artwork-resume and title-detail taps; bare icon target bounds and accessible labels; Library collection plus media shelf/grid, full counts beyond page one, sort and Back restoration; torrent selected/unselected/unsupported rows, expanded release details, unknown metadata, source disappearance after refresh, and list scrolling clear of the fixed Play footer. Include WF02a/04b/06a from the organization board. Verify icon actions are actual controls rather than glyph-only click handlers without keyboard semantics.

Capture the main screens at primary phone and desktop sizes; cover small/large widths using Home, title, Library and an open sheet. Cover stress states at least once on each affected device class. Use browser/WebKit emulation for shared layout feedback only. It does not establish WKWebView/native playback support. iOS simulator captures come from the built app; Android captures from the installed emulator/device app. On Windows, preserve PNG bytes when capturing Android output (use a binary-safe capture method; do not rely on legacy PowerShell `>` redirection for PNG data).

## Bounded review pass

1. Build fully, execute the target flow, and capture a batch covering phone and desktop together. Open every relevant screenshot with image tools. Compare to the wireframe's hierarchy, not placeholder pixel identity.
2. Record concrete defects with screen/state, image location, severity, component owner, and expected fix. Check clipped text, overlap, unsafe touch areas, unreachable controls, focus order, confusing action emphasis, keyboard occlusion, false saved state, inconsistent tabs, image shift, and unnecessary scrolling.
3. Fix the material defects in one batch, preferring a shared token/component when the issue repeats. Add focused behavior regression tests where warranted. Run the Impeccable detector once over changed shared web UI when its workflow requires it; this does not replace image review.
4. Recapture the same cases and inspect them again. Score each issue resolved/partial/unresolved. Stop polishing after this confirmation round. Unresolved functional/accessibility defects remain open tasks and block the affected release gate; do not silently call the feature complete. Further work uses an explicit follow-up scope rather than an endless aesthetic loop.

Screenshots cannot prove interaction or smoothness. Also test actual taps, two-client sync, keyboard navigation, back restoration, sheets, save failures, playback and resume. Capture a performance trace/video for scroll and route transitions; inspect long tasks, frames, layout shifts, image decoding and input feedback against plan.md targets. Record numeric results and remaining limitations.

## Review report template

```text
Phase / source revision / dirty changes included:
Build and test commands, exit codes, baseline failures:
Fixture IDs, device/OS/build type, viewport/text scale/network:
Capture index (screen/state -> actual image path):
Visual findings (ID, severity, screenshot location, owner):
Fixes and recapture verdict (resolved / partial / unresolved):
Interaction evidence (steps, observed result):
Performance (device + trace path + measured target/result):
Native playback format/transport matrix:
Blocked checks and required hardware/tooling:
Applicable US/FR coverage:
Release gate: passed / failed / blocked, with reasons:
Rollback verified:
Next task:
```

The planning wireframes have their own layout inspection; they are not application test results. Never copy their preview images into an implementation report as if captured from the app.
