# Wireframe behavior map

Open [the visual board](wireframes.html). Switch between Reference, Connection, Downloads and iOS surfaces. The 2026-09-28 revision follows the [evidence baseline](visual-reference.md) and removes instructional UI copy. The board is a static design artifact; only its board selectors are interactive. Media comes from repository evidence and metrics are illustrative. Native system chrome is schematic and must be implemented with actual iOS APIs.

| ID | Surface | Controls and behavior |
|---|---|---|
| WF01 | First setup | URL field → Connect → inline progress → successful save opens shell. Failed URL remains editable. Error replaces helper text, not the field. Enter submits. No repeated setup for a saved config. If orphaned local files exist, offer Open downloads |
| WF02 | Home, server unavailable | Show Server unavailable, Retry, Go to settings. Keep the existing header and four destinations. Same view whether downloads exist or not; users tap Downloads |
| WF03 | Server settings | Back restores prior screen. Current active address/status is distinct from editable candidate. Test and save validates and persists atomically. Failed edit keeps the previous active address. New server never deletes local downloads |
| WF04 | Download sheet | Source opens existing episode-aware picker. Subtitles selects available sidecars. Start download creates one job; dismissing sheet afterward does not cancel. Unknown sizes stay unknown; insufficient storage disables submission with a reason |
| WF05 | Downloads preparing/transferring | Separate stages and counts. Pause applies to transfer; Cancel available for preparing; overflow supplies Retry/Remove as appropriate. Manage shows local usage and removal controls. Gear remains available |
| WF06 | Downloads offline | Local media and Play/Resume prominent. No global connection notice. Partial files show Waiting for server and no Play. Reconnect never changes tabs |
| WF07 | Mid-session outage | Keep the title and current route. Affected remote content gets Server unavailable, Retry, Go to settings; local media stays playable. No Saved information labels or View downloads instruction |
| WF08 | Resume conflict | Show device and server positions with source labels, not “newer” claims inferred from clocks. Use this iPhone / Use server choice is explicit and conditionally saved. Not now leaves both intact; local playback remains available |
| WF09 | Dynamic Island compact/minimal | Current download icon and measured percent when known; minimal uses simple progress glyph. System controls actual geometry/presentation. Tap opens Downloads |
| WF10 | Expanded/Lock Screen activity | Title, current transfer bytes, progress, waiting count. Preparing/unknown total uses indeterminate state. Stale reads Last reported progress; a completed/ended activity shows final durable state |
| WF11 | Completion notification | Only after verified local finalization. Tap opens Downloads/item; no autoplay. Group related completions; failure notices say action needed and never masquerade as ready |
| WF12 | Existing title plus Download | Keep the existing screenshot's header, content and save/source tools. Add a Download affordance and append the Downloads destination. This is a design overlay, not a new title-page redesign |

## Required variants beyond the main boards

- **Setup errors:** invalid address, cannot reach server, denied local-network access when known, incompatible protocol, persistence failure; retain the draft and specific recovery.
- **Downloads empty:** No downloads yet. Online action: Find something → Search. Offline action: Go to settings. No travel/setup explanation paragraph.
- **Downloads storage failure:** Couldn't read your downloads → Retry / Storage settings. Do not show empty or reset data.
- **Verification failure:** Download needs repair → Retry. Selected subtitle missing → Retry subtitles / Continue without subtitles. Until explicit omission or successful retry, no Ready label.
- **Queue waiting:** Waiting for Wi-Fi / Waiting for server / Ready to download (with Start when applicable). Keep preparation/suspension details in item details/help. Do not conflate these with Paused.
- **Deletion:** Remove download? Removes this device's files and lists reclaimed bytes. It does not remove library membership. A currently playing item explicitly requires stopping playback before deletion.
- **System permissions:** notifications disabled or Live Activities disabled appear as optional Settings information; no download-blocking dialog.
- **Server version:** Online downloads need a server update; existing local media keeps Play. No whole-app incompatible screen for an optional feature.

## Layout and interaction contract

Use `docs/mobile-ui/design-system.md` over the marketing portions of DESIGN.md. Near-black canvas, system typography, white primary actions, quiet separators, artwork reserved to existing media content. Placeholder rectangles on these wireframes represent media and are not production art.

Production destinations: preserve Home, Library, Search and append Downloads on supported native clients. Icons plus labels; 48px shared touch targets. Reuse the existing Settings2/sliders icon with accessible name Open settings. Shared sheets have visible title/Close, focus restoration and scroll clearance above the safe-area footer. Use actual insets, never the board's fixed phone frame. Preserve LaunchScreen's established logo/field/button composition; simplify its copy.

At 200% text increase row height, wrap actions, and let the page scroll. At 320px preserve labels and action reachability. Keyboard does not hide Connect/Test and save. VoiceOver announces phase, bytes, errors and completion without an announcement for every byte event. Reduced motion disables decorative transitions. Respect iOS back navigation, including dismissal of settings/sheets before leaving the underlying route.

Wireframes cover structure, not exact system Dynamic Island geometry. Validate native layouts in their actual presentation modes on device.
