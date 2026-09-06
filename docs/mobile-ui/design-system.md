# Shared application design system

Scope: torWatch mobile and shared desktop alpha surfaces, accepted for alpha on 2026-09-06. The owner is not satisfied with the final visual quality; later visual refinement remains open. Mode: **Operate**. Job: find something, save it, and watch or resume with one hand on a phone. Keep media and the next useful action prominent; reveal source diagnostics on demand.

This is the application extension to `DESIGN.md`. Current source (`globals.css`, `AppHeader`, title and home pages) supplies visual evidence. Preserve the near-black canvas, white actions, quiet outlines, poster-led browsing, and restrained typography. Marketing-only instructions about 96px heroes, all-uppercase labels, weight 400 everywhere, hamburger navigation, no photography, and tiny outline buttons do not govern these app surfaces. Movie posters/backdrops are product content. Use existing assets and catalog metadata; wireframe titles are explicitly fictional fixtures.

## Shared tokens and platform behavior

| Role | Application rule |
|---|---|
| Canvas / raised surface / text | `#0a0a0a` / `#191919` / `#ffffff`; shared semantic tokens, never new per-screen colors |
| Body / secondary text | `#dadbdf` / `#a6a9af`; test actual foreground/background contrast, including overlays |
| Hairline / control outline | `#212327` for decoration; stronger outline or fill for actionable boundaries and focus |
| Primary action | White fill, near-black text; Play/Resume is primary on title detail |
| Selection | Filled icon plus accessible pressed state, never color alone; bookmark = Watch Later, heart = Favourite. Keep text on collection tabs and on feedback. |
| Typography | System UI stack: Apple system on iOS, Android system on Android, existing Segoe stack on Windows; no proprietary font dependency |
| Phone text roles | Page title 32/38; title detail 28/34; section 22/28; body/input/action 17/25; metadata 14/20; tab label 12/16 at default scale |
| Scaling | Use rem in shared UI, mapped system text scale in wrappers; allow 200% text and increased system font sizes without clipping; validate scaling bridge on device |
| Weight | 400 body, 500 controls, 600 headings where useful; mono only for optional diagnostics |
| Spacing | Shared 4px base: 4, 8, 12, 16, 24, 32, 48; phone gutters 16, expanded gutters 24–32 |
| Touch | Shared controls at least 48×48 CSS px at default scale; native targets at least 44pt iOS / 48dp Android; 8px separation between adjacent small controls |
| Shape | 8px card and action corners; no capsule-shaped Back, Settings, save actions or filters. Back/settings/close/sort are bare icons with unpainted touch targets. |
| Images | Posters 2:3; backdrops/video 16:9 with text scrim only where needed; reserve dimensions; titled fallback when missing |
| Motion | Brief state feedback; no autoplay carousel or parallax; respect reduced motion; do not require motion to understand state |

These are proposed semantic values, not new runtime tokens yet. Extract and reconcile with the existing CSS in M2.1. Do not maintain a second handwritten token set for mobile.

## Adaptive shell

| Available content width | Structure |
|---|---|
| Compact <600 CSS px | One vertical page; bottom destinations Home, Search, Library; Settings reachable from Home; detail uses Back; two-column poster grid except one column at large text |
| Medium 600–1023 | More grid columns by minimum card width; persistent destinations in a rail when space permits; no narrow fixed-width phone centered in an empty screen |
| Expanded ≥1024 | Desktop header/navigation and window chrome in Electron; title artwork beside details/episodes; shared Library destination; pointer/keyboard affordances retained |

Viewport width controls layout; runtime capability controls Electron chrome and playback. A narrow Electron window gets the compact content arrangement with appropriate desktop chrome. A landscape phone remains touch-first. iPad/tablet release support is deferred, but resizing must not crash or clip.

- Bottom bar content height 64px plus bottom inset; page scroll padding includes both. Insets come from the runtime, not model-name or notch-height constants. Never double-apply native and CSS insets.
- Use dynamic viewport height and keyboard/visual-viewport handling. Search results resize above the keyboard. Keep back, clear, and cancel reachable. No keyboard-triggered jumps to another route.
- Phone Home starts with a Continue Watching carousel when available, then an open Browse category rail and recommendations. Continue cards use landscape artwork, an overlaid play glyph, progress along the artwork edge, title, episode and time remaining. The next card peeks into view. No separate full-width Resume field/button beneath the carousel.
- Tapping Continue artwork or its play glyph resumes the saved episode/time; tapping its title opens detail. Implement these as separate sibling controls with accessible names, not a link wrapped around a button. A horizontal drag must not trigger playback on release. The carousel uses native scrolling and scroll snap, no autoplay; retain keyboard/pointer navigation and an accessible section-chevron action to open the complete list.
- Browse Movies, Series and Anime uses an open icon-and-label rail with subtle separators, not rounded pills. These entries open their browse views. Search uses a sliders control opening a single-select media-type sheet rather than a row of pills; preserve the query when applying or dismissing it.
- Library has two persistent icon-and-label, underlined tabs: Watch Later and Favourites. Within either collection, group titles into Movies, Series, and Anime shelves with counts and heading chevrons. Each shelf opens a fully paginated grid scoped to that collection and media kind. Counts cover the entire server-side collection, not just fetched cards. A title belongs to one media-kind shelf under the existing canonical classification; anime series do not also appear under Series. Empty shelves show a concise inline empty state; a completely empty collection gets the full empty-state action. Keep collection, category, sort and scroll position on Back.
- Library sort is one bare sort icon opening a labelled selection sheet: Recently added (default) or Title A–Z. Apply sort consistently to shelf previews and scoped grids; do not download the entire library to filter or count on the phone.
- Use one page scroll on phones. Episode lists paginate or expand in the page; only a presented sheet has its own scroll. This overrides desktop bounded-panel guidance for phone detail pages.
- Source, subtitle, season, and sort selection use a dismissible sheet on phones and a popover/panel on desktop. Sheet heading and Close remain visible; restore focus to the opener. Destructive actions require deliberate controls; a drag gesture is never the only way out.
- Title detail uses a compact rectangular Play/Resume action with a play icon, followed by bare bookmark, heart and source-sliders controls. The tappable title or poster opens detail from a collection; do not repeat “Open title” links beneath every card. Episode rows have a play glyph. A labelled Torrents row with a source icon and chevron makes source discovery clear even when the toolbar icon is unfamiliar. Both source entry points open the same episode-aware sheet.
- Torrent list: header contains title/episode context and a bare Close icon, then count, labelled sort state, sort and refresh icons. Each row exposes resolution, size, seeders, a two-line release name, codec/audio/language when known, and compatibility/previously-used state. Do not infer support from a filename or infer health solely from seed count. Selection is separate from playback; show selected state and a fixed rectangular Play selected torrent action above the safe area. Rows scroll above that footer. A distinct details disclosure opens the full release name, indexer, date, peers and probe/subtitle state. Unknown fields stay “Unknown”; never manufacture technical metadata. Unsupported rows remain inspectable but cannot start playback. Refresh must not silently switch a selected source.
- Keep iOS back affordance and interactive back working; bridge Android Back so it closes keyboard, then sheet, then detail stack, then yields to the system at root. Preserve search query, selected Library tab, and scroll position across back navigation.
- Use platform adapters for native pickers, permission prompts, system bars, and navigation lifecycle. Shared web controls may retain the brand, but must honor each platform's accessibility and navigation behavior.

## Shared component inventory

| Component | Reused responsibilities | Adaptation |
|---|---|---|
| AppShell / Navigation | Destination IDs, current route, restoring tab state | Desktop chrome versus bottom nav/rail |
| PosterCard / MediaRow | Artwork, title, accessible label, open detail | Grid and touch dimensions; visible action menu without hover |
| ContinueCard / ContinueCarousel | Episode label, progress, separate resume/detail intents | Landscape snap-scrolling cards with next-card peek; desktop arrows |
| TitleSummary / TitleActions | Metadata, Play/Resume, save flags | Stacked mobile versus desktop columns |
| LibraryToggle | Independent membership, pending/error semantics | Bare bookmark/heart, accessible names and `aria-pressed`; no nested interactive controls |
| LibraryShelves / ScopedLibraryGrid | Collection, canonical media kind, total counts, sort, pagination | Underlined collection tabs; media shelves lead to full grids |
| EpisodeList | Season selection, aired/available state, resume | Inline phone rows versus desktop bounded panel |
| SelectionSurface / TorrentRow | Options, source metadata, selection, details, error, dismissal | Phone sheet/list versus desktop panel; scroll clear of footer |
| RecommendationRow | Reason text, source/title identity | Carousel on touch with See all; keyboard navigation on desktop |
| ConnectionState | Checking, ready, unreachable, incompatible | Phone setup versus existing desktop setup shell |
| PlayerControls | Intent and progress contracts, accessible labels | MPV adapter versus validated mobile player; platform presentation may differ |

All interactive components need default, focus, pressed/selected, pending, disabled-with-reason, error/retry, and reduced-motion behavior where applicable. Do not show unavailable playback as an unexplained disabled Play button.

## Icon language (user revision)

Use one consistent outline family already available in the shared renderer (`lucide-react` is installed); the documentation vectors illustrate the intended glyphs. Map Home→house, Search→magnifier, Library→library, Back→chevron-left, Settings→settings, Close/Clear→x, Watch Later→bookmark, Favourite→heart, Torrents/filters→sliders-horizontal, sort→list-filter/arrow-down-wide-narrow, refresh→rotate-cw, media categories→film/tv/sparkles, playback→play/pause and captions/volume. Do not use emoji or text characters as production icons. Keep bottom navigation icon plus small label; icons alone are appropriate for familiar toolbar tools, not ambiguous destinations or recovery messages. Selected save icons fill in; pending and failure are also announced in text. Each icon-only control has a specific accessible name, a visible focus state, and an actual 48×48 touch target even though the glyph is 20–24px. Desktop hover/focus tooltips are supplementary. At large text or narrow widths, wrap title actions rather than shrinking targets.

## Accessibility acceptance

Normal text contrast ≥4.5:1; large text and meaningful non-text boundaries ≥3:1. Focus stays visible above sheets/bars. VoiceOver/TalkBack announce title, action, selection, and save failure. No hover-only or swipe-only essential actions. Full title stays accessible if a poster caption uses two-line truncation. At 200% text, increase row height, wrap controls, and reduce grid columns. At 320px width the application must not hide overflow to conceal layout bugs. The wireframes show default-size composition, not a fixed-height production layout.
