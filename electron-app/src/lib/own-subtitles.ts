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
 *  give it (styled or picture subtitles). */
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
  // The server reads the whole video the first time; for a download whose
  // server copy is gone that means the torrent again, which can outlast one
  // read (it answers "unavailable") or a dropped connection. Keep asking
  // for the whole episode rather than leave the player's style on screen
  // until something else asks again.
  for (let attempt = 0; attempt < 240 && !cancelled(); attempt++) {
    let data: { status?: string; reason?: string; url?: string } = {};
    try {
      const res = await fetch(`${origin}/subtitles/embedded?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
      data = res.ok ? await res.json() as typeof data : {};
    } catch {
      data = {};
    }
    if (data.status === 'pending') {
      await wait(6000);
      continue;
    }
    if (data.status === 'ready' && data.url) {
      try {
        const file = await fetch(`${origin}${data.url}`, { signal: AbortSignal.timeout(15000) });
        if (file.ok) return file.text();
      } catch {
        // Ask again below.
      }
      await wait(6000);
      continue;
    }
    // Styled or picture subtitles, or a video the server does not know:
    // the player keeps drawing them.
    if (data.status === 'none' && data.reason !== 'unavailable') return null;
    await wait(30000); // unreachable, or the read failed: try again shortly
  }
  return null;
}
