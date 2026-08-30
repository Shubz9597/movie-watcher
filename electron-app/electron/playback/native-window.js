export function readNativeWindowId(window) {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    throw new Error("Unable to read native window handle");
  }

  if (handle.length >= 8 && typeof handle.readBigUInt64LE === "function") {
    return handle.readBigUInt64LE(0).toString();
  }
  return BigInt(handle.readUInt32LE(0)).toString();
}

export function attachMpvWindow(handle, windowId) {
  if (!handle) {
    throw new Error("MPV handle is not ready");
  }
  if (typeof handle.attachWindow === "function") {
    handle.attachWindow(windowId);
  } else {
    handle.attachHwnd(windowId);
  }
}
