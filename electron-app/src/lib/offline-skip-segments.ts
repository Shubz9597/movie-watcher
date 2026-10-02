// Skip-intro timestamps for downloads: fetched while online when a download
// is handed to the device, stored per download, and used by the offline
// player (which cannot reach /skip-segments). Timings are the providers' raw
// values (no per-file alignment, which needs the exact runtime).
export type StoredSkipSegment = { type: string; start: number; end: number; provider: string };

const STORAGE_KEY = 'torwatch_offline_skip_segments_v1';

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

/** Fetches and stores timestamps for one download (best effort). */
export async function cacheOfflineSkipSegments(origin: string, downloadId: string, query: Record<string, string>): Promise<void> {
  // A runtime far from any real one opts out of server-side alignment, so
  // the providers' raw timings are returned and stay valid for the file.
  const params = new URLSearchParams({ ...query, durationSeconds: '86400' });
  const response = await fetch(`${origin}/skip-segments?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return;
  const body = await response.json() as { segments?: StoredSkipSegment[] };
  const segments = Array.isArray(body.segments) ? body.segments.filter((segment) => segment.type === 'intro' || segment.type === 'recap') : [];
  if (!segments.length) return;
  writeAll({ ...readAll(), [downloadId]: segments });
}
