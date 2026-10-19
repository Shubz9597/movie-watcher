// The subtitle look the phone uses (one look everywhere): white monospace
// text in a single, slightly see-through black box, a little above the seek
// bar while the controls show. mpv draws it; plain-dialogue ASS tracks are
// forced into it, styled ones (signs, karaoke) keep their author's styling.
//
// Option names changed in mpv 0.38 (sub-border-* became sub-outline-*, and
// the background box arrived): newer names are tried first.

export const DEFAULT_SUBTITLE_SIZE = 34; // mpv units: 720 = the window height
const DEFAULT_MARGIN = 22;

function setter(handle) {
  return (key, value) => {
    try {
      handle.setOptionString(key, String(value));
      return true;
    } catch {
      return false;
    }
  };
}

export function applySubtitleLook(handle) {
  if (typeof handle?.setOptionString !== "function") return;
  const set = setter(handle);
  set("sub-font", "Consolas");
  set("sub-bold", "no");
  set("sub-color", "#FFFFFFFF");
  set("sub-shadow-offset", "0");
  set("sub-font-size", String(DEFAULT_SUBTITLE_SIZE));
  set("sub-margin-y", String(DEFAULT_MARGIN));
  // 60% black, one box behind all lines; padding from the outline size.
  set("sub-back-color", "#99000000");
  if (!set("sub-border-style", "background-box")) set("sub-border-style", "opaque-box");
  if (!set("sub-outline-color", "#99000000")) set("sub-border-color", "#99000000");
  if (!set("sub-outline-size", "4")) set("sub-border-size", "4");
}

/** Size (mpv units), the bottom margin (mpv units; above the controls while
 *  they show) and whether the current ASS track takes the box. */
export function applySubtitleLayout(handle, { size, marginY, boxAss } = {}) {
  if (typeof handle?.setOptionString !== "function") return { ok: false };
  const set = setter(handle);
  const clamp = (value, low, high, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.min(high, Math.max(low, number))) : fallback;
  };
  if (size !== undefined) set("sub-font-size", String(clamp(size, 20, 72, DEFAULT_SUBTITLE_SIZE)));
  if (marginY !== undefined) set("sub-margin-y", String(clamp(marginY, 0, 300, DEFAULT_MARGIN)));
  if (boxAss !== undefined) set("sub-ass-override", boxAss ? "force" : "scale");
  return { ok: true };
}
