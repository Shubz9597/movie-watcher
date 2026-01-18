// Torrent resolve service - resolves file index for season packs
import { pickFileIndexForEpisode, type TorrentFileEntry } from '../anime-matching';

const VOD_BASE = 'http://localhost:4001';

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function normalizeFiles(raw: unknown): TorrentFileEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (typeof f !== 'object' || f === null) return { index: -1, name: '' };
      const entry = f as Record<string, unknown>;
      const index =
        typeof entry.index === 'number'
          ? entry.index
          : typeof entry.Index === 'number'
            ? entry.Index
            : -1;
      const name =
        typeof entry.name === 'string'
          ? entry.name
          : typeof entry.Name === 'string'
            ? entry.Name
            : '';
      const length =
        typeof entry.length === 'number'
          ? entry.length
          : typeof entry.Length === 'number'
            ? entry.Length
            : undefined;
      return { index, name, length };
    })
    .filter((f) => Number.isFinite(f.index) && f.index >= 0 && f.name.length > 0);
}

export async function resolveTorrentFile(params: {
  magnetUri?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  cat?: string;
  season?: number;
  episode?: number;
  absolute?: number;
}): Promise<{ fileIndex: number; fileName: string; fileLength?: number | null; matched?: boolean; score?: number | null }> {
  const { magnetUri, torrentUrl, downloadUrl, infoHash, cat = 'anime', season, episode, absolute } = params;

  if (episode == null && absolute == null) {
    throw new Error('episode or absolute number is required');
  }

  // Normalize source
  let normalizedSrc: string | undefined;
  if (magnetUri) {
    normalizedSrc = magnetUri;
  } else if (torrentUrl || downloadUrl) {
    normalizedSrc = torrentUrl || downloadUrl;
  } else if (infoHash) {
    normalizedSrc = `magnet:?xt=urn:btih:${infoHash}`;
  }

  if (!normalizedSrc) {
    throw new Error('Unable to determine torrent source');
  }

  // Fetch file list from Go backend
  const urlParams = new URLSearchParams();
  urlParams.set('cat', cat);
  if (normalizedSrc.startsWith('magnet:')) {
    urlParams.set('magnet', normalizedSrc);
  } else if (/^https?:\/\//i.test(normalizedSrc)) {
    urlParams.set('src', normalizedSrc);
  } else if (infoHash) {
    urlParams.set('infoHash', infoHash);
  } else {
    throw new Error('Unsupported source format');
  }

  const target = `${VOD_BASE}/files?${urlParams.toString()}`;
  const filesRes = await fetch(target, { method: 'GET', cache: 'no-store' });
  if (!filesRes.ok) {
    throw new Error(`File listing failed (${filesRes.status})`);
  }

  const filesJson = await filesRes.json();
  const files = normalizeFiles(filesJson);
  if (!files.length) {
    throw new Error('No files returned for torrent');
  }

  const pick = pickFileIndexForEpisode(files, { season, episode, absolute });
  if (!pick) {
    throw new Error('No matching file for requested episode');
  }

  return {
    fileIndex: pick.index,
    fileName: pick.name,
    fileLength: pick.length ?? null,
    matched: pick.matched ?? false,
    score: pick.score ?? null,
  };
}



