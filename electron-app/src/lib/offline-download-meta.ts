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
const MAX_IMAGE_BYTES = 160_000;

function readAll(): Record<string, DownloadMeta> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, DownloadMeta> : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, DownloadMeta>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage full: Downloads falls back to remote artwork / plain labels.
  }
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
  writeAll({ ...readAll(), [downloadId]: meta });
}
