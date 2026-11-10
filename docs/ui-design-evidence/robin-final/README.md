# TorWatch UI refinement — final evidence

2026-11-05. Scoped refinement of the established charcoal, gold, and Manrope application UI. The incumbent identity, runtime tokens, and existing design documentation remain in place; this report does not introduce a replacement design system.

## Result

The independent `gpt-6.1-sol` reviewer, using high reasoning effort, reviewed all 21 final captures and returned **Ship, 9.5/10 overall**, with no material findings at screenshot scope. The initial review scored 8.9/10 and identified dominant source filenames, insufficient phone metadata scrims, three-column phone Library density, an orphan Downloads heading, and a detached media-type pill. All five findings and the subsequently identified low vote-text contrast were resolved before final review. This is a subjective visual assessment, not human Robin approval.

- Desktop navigation is 76px high. The desktop hero has more room for artwork and title hierarchy; the phone hero is shorter so browsing begins sooner.
- Desktop and phone share landscape Continue Watching cards, preferring the BFF background image with poster fallback. Cards show remaining minutes calculated from duration and position, or an Up next state. Resume and title-detail targets stay separate; desktop resume without a callback opens the source-aware title route.
- Desktop Library groups Movies, Series, and Anime into a three-column wall, with two poster columns within each group. Phone Library and Search use two poster columns.
- Wide browser title pages put sources or episodes in a right sidebar. Media type now sits with title metadata. Phone detail pages use a stronger artwork scrim, and vote counts use opaque muted text.
- Source filenames occupy at most two lines in list rows; Details preserves the complete filename. The Downloads heading appears together with the Wi-Fi preference, so an unavailable setting leaves no orphan heading.
- Controls retain visible gold focus and selection states, quieter outlines, and reduced-motion treatments. Source and episode panels use tonal separation without a panel shadow.

## Retained visual conventions

The runtime authority for these rendered surfaces is [cinema.css](../../../electron-app/src/cinema.css), layered over [globals.css](../../../electron-app/src/globals.css) and [shared component tokens](../../../electron-app/src/lib/design-tokens.ts).

| Convention | Existing implementation retained |
| --- | --- |
| Palette | `--cinema-canvas: #101112`, `--cinema-panel: #191b1d`, `--cinema-ink: #f2f0eb`, `--cinema-muted: #b0b1b0`, `--cinema-accent: #e7bd82` |
| Typography | Bundled Manrope regular, semibold, and bold; `Manrope, 'Segoe UI', sans-serif`; restrained metadata and tighter heading tracking |
| Shape | Existing `--radius: 0.5rem` base and mixed component radii: 8px navigation, 9px primary actions, 10px inputs/search, 12px poster artwork, 16px source/episode panels |
| Content | Portrait posters, landscape Continue artwork, artwork fading into charcoal, familiar Lucide icons, and gold reserved for primary action/selection/focus |
| Layout | Existing responsive shell and spacing vocabulary; the final refinement changes surface hierarchy and density within that system |

Pre-existing documentation drift remains: [the mobile design-system document](../../mobile-ui/design-system.md) references an absent root `DESIGN.md` and includes earlier proposed system-font, white-action, near-black, and uniform 8px guidance that differs from the already-established cinema overrides. It explicitly describes its semantic values as proposed. That document and the runtime token sources were retained; no root `PRODUCT.md`, `DESIGN.md`, or sidecar was created or migrated.

## Reference principles

[Netflix's TV experience update](https://about.netflix.com/en/news/unveiling-our-innovative-new-tv-experience) informed the emphasis on visible navigation and decision-useful title information. [Apple's redesigned TV app](https://www.apple.com/newsroom/2023/12/redesigned-apple-tv-app-elevates-the-viewing-experience/) informed content-first hierarchy, clear collection grouping, and quick access to familiar destinations. These are inspiration principles applied within TorWatch's existing visual language; neither interface was copied.

## Final captures

Browser captures use the production browser build at 1440×1100 and 390×844. Mobile-shell captures use the production mobile entry at 390×844, 2× device scale, with touch and Chrome safe-area emulation (47px top, 34px bottom).

| Surface | Desktop browser | Phone browser | Mobile shell |
| --- | --- | --- | --- |
| Home | [Desktop](home-desktop.png) | [Phone](home-phone.png) | [Mobile](../robin-mobile-final/home.png) |
| Shelves | [Desktop](shelves-desktop.png) | [Phone](shelves-phone.png) | [Mobile](../robin-mobile-final/shelves.png) |
| Browse | [Desktop](browse-desktop.png) | [Phone](browse-phone.png) | — |
| Movie title | [Desktop](title-desktop.png) | [Phone](title-phone.png) | [Summary](../robin-mobile-final/title-movie.png), [sources](../robin-mobile-final/title-movie-sources.png) |
| Series title | — | — | [Summary](../robin-mobile-final/title-series.png), [episodes](../robin-mobile-final/title-series-episodes.png) |
| Library | [Desktop](library-desktop.png) | [Phone](library-phone.png) | [Mobile](../robin-mobile-final/library.png) |
| Search | — | [Phone](search-phone.png) | [Mobile](../robin-mobile-final/search.png) |
| Downloads | — | — | [Mobile](../robin-mobile-final/downloads.png) |
| Settings | — | — | [Mobile](../robin-mobile-final/settings.png) |

## Verification and reproduction

[Browser checks](checks.json) and [mobile-shell checks](../robin-mobile-final/checks.json) record zero runtime errors, zero broken visible images, and no horizontal page overflow in all final captures. Browser checks also cover Home, movie detail, series detail, Library, and Browse at 320, 768, 1024, and 1920px; full source-name disclosure on both capture sizes; and phone Search → Title navigation.

Mobile vote-count contrast was measured against actual composited background pixels with the text temporarily hidden: minimum **6.65:1** for the movie and **6.87:1** for the series, exceeding the 4.5:1 threshold. The final run also passed `npm test` (**281 tests**), `npx tsc --noEmit`, and browser, mobile, and renderer builds. The Impeccable detector returned `[]` in its single run.

From `electron-app/`, reproduce verification and deterministic capture generation with:

```sh
npm test
npx tsc --noEmit
npm run build:browser
npm run build:mobile
npm run build:renderer
node scripts/capture-design.mjs robin-final
node scripts/capture-mobile.mjs robin-mobile-final
```

The scripts serve the built assets locally and use explicit synthetic fixtures; they need no live account or saved user data. Capture commands overwrite their evidence files. Fixture layout and browser safe-area checks do not assert native-device behavior, real catalog coverage, or successful media playback. Visual review covers the captured states, not every interaction or accessibility scenario.
