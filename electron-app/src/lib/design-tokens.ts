// Shared design tokens (feature 002 M2.1): the numeric values live ONLY in
// the CSS custom properties in globals.css (the single authoritative source,
// consumed via var(--…) and collapsed for reduced motion there). This module
// exports only the shared class fragments used by accessible controls; no
// numeric mirrors are kept here so tokens cannot drift.
// globals.css authoritative tokens: --touch-target (48px), --motion-fast,
// --motion-route, --motion-sheet, --ease-standard.

// Class fragments shared by accessible controls (kept here so the focus
// treatment is identical across primitives and pages).
export const FOCUS_RING_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black';
export const TOUCH_TARGET_CLASS = 'min-h-[var(--touch-target)] min-w-[var(--touch-target)]';

// Rectangular text actions (design-system.md: 8px action corners, white
// primary fill, quiet outline secondary, 48px touch target). Bare icon
// controls use IconButton instead.
export const ACTION_PRIMARY_CLASS =
  `inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING_CLASS}`;
export const ACTION_SECONDARY_CLASS =
  `inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-white/20 px-5 text-sm font-medium text-white transition hover:border-white/40 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING_CLASS}`;
