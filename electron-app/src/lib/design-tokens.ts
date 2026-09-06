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
