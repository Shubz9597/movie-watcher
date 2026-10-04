// Torrent resolve service - resolves file index for season packs
import { pickFileIndexForEpisode, type TorrentFileEntry } from '../anime-matching';
import { getVodBase } from '../api-client';

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

type TorrentSourceParams = {
  magnetUri?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  cat?: string;
};

// titles name the show so franchise collections skip its siblings' files;
// anime packs number episodes absolutely, so their season folders are ignored.
type EpisodeTarget = { season?: number; episode?: number; absolute?: number; titles?: string[]; anime?: boolean };

export type ResolvedEpisodeFile = {
  fileIndex: number;
  fileName: string;
  fileLength?: number | null;
  matched?: boolean;
  score?: number | null;
};

/** Lists a torrent's files once, so a batch can pick many episodes from it. */
export async function listTorrentFiles(params: TorrentSourceParams): Promise<TorrentFileEntry[]> {
  const { magnetUri, torrentUrl, downloadUrl, infoHash, cat = 'anime' } = params;

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

  const target = `${getVodBase()}/files?${urlParams.toString()}`;
  const filesRes = await fetch(target, { method: 'GET', cache: 'no-store' });
  if (!filesRes.ok) {
    throw new Error(`File listing failed (${filesRes.status})`);
  }

  const files = normalizeFiles(await filesRes.json());
  if (!files.length) {
    throw new Error('No files returned for torrent');
  }
  return files;
}

/** The file for one episode, or null when the torrent does not carry it. */
export function pickEpisodeFile(files: TorrentFileEntry[], target: EpisodeTarget): ResolvedEpisodeFile | null {
  const pick = pickFileIndexForEpisode(files, target);
  if (!pick || !pick.matched) return null;
  return {
    fileIndex: pick.index,
    fileName: pick.name,
    fileLength: pick.length ?? null,
    matched: pick.matched ?? false,
    score: pick.score ?? null,
  };
}

export async function resolveTorrentFile(params: TorrentSourceParams & EpisodeTarget): Promise<ResolvedEpisodeFile> {
  const { season, episode, absolute, titles, anime } = params;
  if (episode == null && absolute == null) {
    throw new Error('episode or absolute number is required');
  }
  const pick = pickEpisodeFile(await listTorrentFiles(params), { season, episode, absolute, titles, anime });
  if (!pick) {
    throw new Error('No matching file for requested episode');
  }
  return pick;
}



