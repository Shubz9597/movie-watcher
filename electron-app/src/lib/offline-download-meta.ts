// Offline artwork and episode names for Downloads: captured while online
// when a download is queued, kept on the device so the Downloads screens
// (and their posters/stills) render on a plane. Images are stored as small
// data URLs when the image host allows it, otherwise as their URL.
export type DownloadMeta = {
  episodeTitle?: string;
  still?: string;
  poster?: string;
};

const STORAGE_KEY = 'torwatch_download_meta_v1';
// WebView storage is about 5 MB in all: a whole season of 160 KB stills
// filled it, and every later download lost its still (Kai Season 2).
const MAX_IMAGE_BYTES = 40_000;

function readAll(): Record<string, DownloadMeta> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, DownloadMeta> : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, DownloadMeta>): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full
  }
}

/** Frees WebView storage: stored images become their links (or go), the
 *  episode names stay. Called when another write found storage full. */
export function shrinkDownloadMeta(): void {
  const all = readAll();
  for (const meta of Object.values(all)) {
    if (meta.still?.startsWith('data:')) delete meta.still;
    if (meta.poster?.startsWith('data:')) delete meta.poster;
  }
  writeAll(all);
}

/** Forgets artwork of downloads that no longer exist (removed, cancelled,
 *  replaced): only ids in keep stay. */
export function pruneDownloadMeta(keep: Iterable<string>): void {
  const wanted = new Set(keep);
  const all = readAll();
  const ids = Object.keys(all);
  const kept = ids.filter((id) => wanted.has(id));
  if (kept.length === ids.length) return;
  writeAll(Object.fromEntries(kept.map((id) => [id, all[id]])));
}

export function downloadMeta(downloadId: string): DownloadMeta {
  return readAll()[downloadId] ?? {};
}

export function forgetDownloadMeta(downloadId: string): void {
  const all = readAll();
  if (!(downloadId in all)) return;
  delete all[downloadId];
  writeAll(all);
}

/** Smaller TMDb sizes keep stored images light (w300 still, w185 poster). */
function lighter(url: string, size: 'w300' | 'w185'): string {
  return url.replace(/(image\.tmdb\.org\/t\/p\/)(w\d+|original)\//, `$1${size}/`);
}

async function inlineImage(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return url;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_IMAGE_BYTES) return url;
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : url);
      reader.onerror = () => resolve(url);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url; // host without CORS or offline: keep the URL
  }
}

export async function cacheDownloadMeta(
  downloadId: string,
  input: { episodeTitle?: string; stillUrl?: string | null; posterUrl?: string | null },
): Promise<void> {
  const meta: DownloadMeta = {};
  if (input.episodeTitle) meta.episodeTitle = input.episodeTitle;
  const [still, poster] = await Promise.all([
    input.stillUrl ? inlineImage(lighter(input.stillUrl, 'w300')) : Promise.resolve(undefined),
    input.posterUrl ? inlineImage(lighter(input.posterUrl, 'w185')) : Promise.resolve(undefined),
  ]);
  if (still) meta.still = still;
  if (poster) meta.poster = poster;
  if (writeAll({ ...readAll(), [downloadId]: meta })) return;
  // Storage full: the image links (they show while online), not nothing.
  const linked: DownloadMeta = { ...meta };
  if (input.stillUrl) linked.still = lighter(input.stillUrl, 'w300');
  if (input.posterUrl) linked.poster = lighter(input.posterUrl, 'w185');
  writeAll({ ...readAll(), [downloadId]: linked });
}
