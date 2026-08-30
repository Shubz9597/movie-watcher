export function applyAspectModeTo(handle, mode) {
  if (!handle) throw new Error("MPV not ready");

  if (typeof handle.setAspectMode === "function") {
    handle.setAspectMode(mode.aspect, mode.panscan, mode.zoom);
  } else if (typeof handle.setOptionString === "function") {
    handle.setOptionString("video-aspect-override", mode.aspect);
    handle.setOptionString("panscan", String(mode.panscan));
    handle.setOptionString("video-zoom", String(mode.zoom));
  } else {
    throw new Error("This MPV module does not support aspect controls");
  }
  return mode;
}
