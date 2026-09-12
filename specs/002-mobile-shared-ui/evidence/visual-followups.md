# Visual follow-ups (recorded, not blocking the shared-browser M2 alpha gate)

From the M2.5 bounded browser pass (see m2.5-visual-qa-report.md). Each item is a visual-refinement task; none is a functional or accessibility failure at the alpha bar.

1. **Hero title scale at 320 px** (low) — `captures/m25/home-320x568.png`. The 4.5rem feature title consumes most of the small-viewport fold; WF01 proportions suggest a smaller compact step. Owner: shared tokens (`--text-feature-title`) — propose a `clamp()` step in globals.css.
2. **IconButton aspect under 200 % text** (low) — `captures/m25/text200-title-390x844.png`. The compact Back button drifts taller-than-wide when rem-scaled text enlarges neighbors. Owner: `IconButton` primitive (explicit aspect-ratio or fixed non-rem target sizing).
3. **Landscape shell destination model** (low) — `captures/m25/home-844x390.png`. Landscape phone widths take the desktop header and hide bottom destinations; pointer-first is usable, but a landscape-compact shell (keep bottom nav below ~500 px height) should be evaluated. Owner: AppShell breakpoint strategy.
4. **Sheet close-button focus ring intensity** (info) — visible programmatic-focus ring at capture time is correct behavior; optionally soften the ring at rest for aesthetics in the later refinement phase.

Later visual-refinement phase may address these together with the owner's outstanding alpha-quality feedback; none blocks M3.

## M3.3 desktop Library consumer (2026-09-09)

- LOW (library-toggle pending visibility): while a write is in flight the LibraryToggle shows aria-busy + a subtle animate-pulse on the glyph, but a static capture reads as near-idle. Add a small spinner overlay or reduced-opacity control in the next visual pass. Owner: shared LibraryToggle.
- Confirmed fixed in this pass: a failed write previously showed the intended target state; the confirmed server state is now restored visually (filled/outline) with a red error ring and retry label (desktop-toggle-failed-retry.png).


- LOW (recommendation card caption spacing, M4.2): on the phone width the seeded card's reason text wraps to two lines and its last line sits close to the card bottom edge (recs-phone-seeded.png). Consider one extra px of bottom padding in the caption block in the next visual pass. Owner: shared RecommendationRow.
