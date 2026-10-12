// Skip timestamps (intro, recap, credits) for downloads: fetched while
// online when a download is handed to the device, stored per download, and
// used by the offline player (which may not reach /skip-segments). Timings
// are the providers' raw values (no per-file alignment, which needs the
// exact runtime).
export type StoredSkipSegment = { type: string; start: number; end: number; provider: string };

const STORAGE_KEY = 'torwatch_offline_skip_segments_v1';
// Downloads stored before credits were kept are looked up once more.
const CREDITS_CHECKED_KEY = 'torwatch_offline_skip_credits_checked_v1';
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

/** True when a download has no stored credits and was not looked up again. */
export function needsCreditsLookup(downloadId: string): boolean {
  if (offlineSkipSegments(downloadId).some((segment) => segment.type === 'credits')) return false;
  try {
    const checked = JSON.parse(localStorage.getItem(CREDITS_CHECKED_KEY) || '[]');
    return !(Array.isArray(checked) && checked.includes(downloadId));
  } catch {
    return true;
  }
}

/** Records a finished lookup so a title without credits is not refetched. */
export function markCreditsLookedUp(downloadId: string): void {
  try {
    const checked = JSON.parse(localStorage.getItem(CREDITS_CHECKED_KEY) || '[]');
    const list = Array.isArray(checked) ? checked.filter((id) => typeof id === 'string') : [];
    if (!list.includes(downloadId)) localStorage.setItem(CREDITS_CHECKED_KEY, JSON.stringify([...list, downloadId].slice(-500)));
  } catch {
    // Without storage the lookup simply repeats next time.
  }
}
