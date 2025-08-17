// lib/torrent-src.ts
import type { Torrent } from "webtorrent";

/** Resolve Prowlarr /download -> magnet (no follow) */
export async function resolveProwlarrDownload(url: string, timeoutMs = 6000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { redirect: "manual", cache: "no-store", signal: ctrl.signal });
    clearTimeout(to);
    const loc = res.headers.get("location");
    return loc && loc.startsWith("magnet:") ? loc : null;
  } catch { return null; }
}

function isHttp(s?: string | null) { return !!s && /^https?:\/\//i.test(s); }
function isProwlarrDownload(s?: string | null) {
  if (!s) return false;
  try { return /\/download\b/i.test(new URL(s).pathname); } catch { return false; }
}

/** Accepts magnet/src/infoHash. Converts /download -> magnet; infoHash -> magnet. */
export async function normalizeSrc(input: { magnet?: string | null; src?: string | null; infoHash?: string | null }): Promise<string | null> {
  let { magnet, src, infoHash } = input;

  // Some callers pass Prowlarr /download under *magnet* by mistake -> fix it
  if (isHttp(magnet) && isProwlarrDownload(magnet)) magnet = await resolveProwlarrDownload(magnet!) || magnet!;
  if (isHttp(src)    && isProwlarrDownload(src))    src    = await resolveProwlarrDownload(src!)    || src!;

  if (magnet && magnet.length) return magnet;
  if (src && src.length) return src; // magnet or .torrent URL
  if (infoHash && infoHash.length) return `magnet:?xt=urn:btih:${infoHash.toUpperCase()}`;
  return null;
}

/** Wait until metadata/files appear, with timeout; throw on timeout */
export async function waitForMetadata(t: Torrent, timeoutMs = 15000): Promise<void> {
  if ((t as any).metadata || (Array.isArray(t.files) && t.files)) return;
  await new Promise<void>((resolve, reject) => {
    const onMeta = () => { cleanup(); resolve(); };
    const onErr  = (e: any) => { cleanup(); reject(e); };
    const onTO   = () => { cleanup(); reject(new Error("metadata timeout")); };
    const to = setTimeout(onTO, timeoutMs);
    const cleanup = () => { clearTimeout(to); t.off("metadata", onMeta); t.off("error", onErr); };
    t.once("metadata", onMeta);
    t.once("error", onErr);
  });
}