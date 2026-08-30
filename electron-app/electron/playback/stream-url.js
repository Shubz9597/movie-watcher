export function resolveStreamUrl(vodBase, url, cat = "movie", fileIndex = null) {
  if (url && url.includes("/stream")) {
    const parsed = new URL(url, vodBase);
    if (parsed.origin !== new URL(vodBase).origin || parsed.pathname !== "/stream") {
      throw new Error("Only the local torrent stream endpoint is allowed");
    }
    return parsed.toString();
  }

  if (url?.startsWith("magnet:")) {
    let streamUrl = `${vodBase}/stream?cat=${encodeURIComponent(cat)}&magnet=${encodeURIComponent(url)}`;
    if (Number.isInteger(fileIndex) && fileIndex >= 0) {
      streamUrl += `&fileIndex=${fileIndex}`;
    }
    return streamUrl;
  }

  throw new Error("Playback requires a literal magnet URI");
}
