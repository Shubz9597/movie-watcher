// Skip timestamps (intro, recap, credits) for downloads: fetched while
// online when a download is handed to the device, stored per download, and
// used by the offline player (which may not reach /skip-segments). Timings
// are the providers' raw values (no per-file alignment, which needs the
// exact runtime).
export type StoredSkipSegment = { type: string; start: number; end: number; provider: string };

const STORAGE_KEY = 'torwatch_offline_skip_segments_v1';
// Lookups made for a download while it still lacks an intro or credits.
// The server finds them in the episode's own file, which can take longer
// than one request waits the first time: an empty answer is retried later.
const LOOKUPS_KEY = 'torwatch_offline_skip_lookups_v2';
const MAX_LOOKUPS = 5;
const STORED_TYPES = new Set(['intro', 'recap', 'credits']);

function readAll(): Record<string, StoredSkipSegment[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, StoredSkipSegment[]> : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, StoredSkipSegment[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Without storage the offline player simply shows no skip chip.
  }
}

export function offlineSkipSegments(downloadId: string): StoredSkipSegment[] {
  return readAll()[downloadId] ?? [];
}

export function forgetOfflineSkipSegments(downloadId: string): void {
  const all = readAll();
  if (!(downloadId in all)) return;
  delete all[downloadId];
  writeAll(all);
}

/** Fetches and stores timestamps for one download (best effort); true when
 *  the server answered (with or without timestamps). */
export async function cacheOfflineSkipSegments(origin: string, downloadId: string, query: Record<string, string>): Promise<boolean> {
  // A runtime far from any real one opts out of server-side alignment, so
  // the providers' raw timings are returned and stay valid for the file.
  const params = new URLSearchParams({ ...query, durationSeconds: '86400' });
  const response = await fetch(`${origin}/skip-segments?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const body = await response.json() as { segments?: StoredSkipSegment[] };
  const segments = Array.isArray(body.segments) ? body.segments.filter((segment) => STORED_TYPES.has(segment.type)) : [];
  if (segments.length) writeAll({ ...readAll(), [downloadId]: segments });
  return true;
}

function lookups(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOOKUPS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

/** True while a download lacks an intro or credits and lookups remain. */
export function needsSkipLookup(downloadId: string): boolean {
  const stored = offlineSkipSegments(downloadId);
  const complete = stored.some((segment) => segment.type === 'intro') && stored.some((segment) => segment.type === 'credits');
  return !complete && (lookups()[downloadId] ?? 0) < MAX_LOOKUPS;
}

/** Counts a lookup the server answered (with or without timestamps). */
export function recordSkipLookup(downloadId: string): void {
  try {
    const all = lookups();
    all[downloadId] = (all[downloadId] ?? 0) + 1;
    const kept = Object.entries(all).slice(-500);
    localStorage.setItem(LOOKUPS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Without storage the lookup simply repeats next time.
  }
}
