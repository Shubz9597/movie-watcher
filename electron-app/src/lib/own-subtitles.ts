// A torrent's own subtitles, drawn by the app like every other subtitle (one
// look everywhere). The video player would draw them itself, and VLC cannot
// draw the box streaming apps use; so the app reads the track's text and
// shows it in its own overlay. The text comes from:
//   - a download's subtitle files on the phone ("Dub - [English]" and the
//     like, attached after the video's own tracks), read directly;
//   - otherwise the server, which reads the track out of the video
//     (/subtitles/embedded; the first time takes a while, so it answers
//     "pending"). A download keeps the result for offline playback.
// Styled anime subtitles (ASS: positioned signs, karaoke) stay with the
// player, and so does any track whose text cannot be had yet.

export type OwnTrackSource =
  | { kind: 'file'; language: string }
  | { kind: 'video'; ordinal: number };

const SIDECAR = /^(dub|downloaded)\s*-\s*\[([^\]]+)\]\s*$/i;

/** Where a reported subtitle track's text lives: a download's file (by its
 *  language) or the video's own Nth subtitle stream. */
export function ownTrackSource(tracks: ReadonlyArray<{ id: number; label?: string }>, trackId: number): OwnTrackSource | null {
  let ordinal = 0;
  for (const track of tracks) {
    const sidecar = SIDECAR.exec((track.label ?? '').trim());
    if (track.id === trackId) {
      return sidecar ? { kind: 'file', language: sidecar[2].trim() } : { kind: 'video', ordinal };
    }
    if (!sidecar) ordinal++;
  }
  return null;
}

const CACHE_KEY = 'torwatch_own_subtitles_v1';
const CACHE_LIMIT = 30;

type CacheEntry = { text: string; at: number };

function readCache(): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, CacheEntry> : {};
  } catch {
    return {};
  }
}

export function cachedOwnSubtitle(key: string): string | null {
  const entry = readCache()[key];
  return entry && typeof entry.text === 'string' ? entry.text : null;
}

export function cacheOwnSubtitle(key: string, text: string): void {
  const all = readCache();
  all[key] = { text, at: Date.now() };
  const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_LIMIT);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage full: the server is asked again next time.
  }
}

export type OwnTrackQuery =
  | { downloadId: string; clientId: string }
  | { magnet: string; fileIndex: number; cat: string };

/** The video's ordinal-th subtitle stream as WebVTT from the server, asked
 *  again while it is still reading the video; null when the server cannot
 *  give it (styled or picture subtitles, unreachable). */
export async function fetchOwnTrack(
  origin: string,
  query: OwnTrackQuery,
  ordinal: number,
  cancelled: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
  const params = new URLSearchParams({ track: String(ordinal) });
  if ('downloadId' in query) {
    params.set('downloadId', query.downloadId);
    params.set('clientId', query.clientId);
  } else {
    params.set('magnet', query.magnet);
    params.set('fileIndex', String(query.fileIndex));
    params.set('cat', query.cat);
  }
  // The server reads the whole video the first time: up to ~8 minutes.
  for (let attempt = 0; attempt < 90 && !cancelled(); attempt++) {
    const res = await fetch(`${origin}/subtitles/embedded?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
    const data = res.ok ? await res.json() as { status?: string; url?: string } : {};
    if (data.status === 'pending') {
      await wait(6000);
      continue;
    }
    if (data.status !== 'ready' || !data.url) return null;
    const file = await fetch(`${origin}${data.url}`, { signal: AbortSignal.timeout(15000) });
    return file.ok ? file.text() : null;
  }
  return null;
}
