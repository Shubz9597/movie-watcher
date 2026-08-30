import { getVodBase } from '../api-client';

export type TorrentSearchResult = {
  title: string;
  indexer: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  infoHash?: string;
  sourceId?: string;
  publishDate?: string;
  episodeMatch?: boolean;
  seasonPack?: {
    season?: number | null;
    reason?: string | null;
    keywords?: string[];
  } | null;
};

type SearchResponse = {
  query: Record<string, unknown>;
  total: number;
  results: TorrentSearchResult[];
};

type ResolveResponse = {
  magnetUri: string;
  infoHash?: string;
};

type BackendError = {
  error?: string;
};

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${getVodBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & BackendError;
  if (!response.ok) {
    throw new Error(payload.error || `Torrent backend request failed (${response.status})`);
  }
  return payload;
}

async function search(body: Record<string, unknown>): Promise<SearchResponse> {
  const response = await postJSON<SearchResponse>('/v1/torrents/search', body);
  return {
    ...response,
    results: Array.isArray(response.results) ? response.results : [],
  };
}

export async function searchMovieTorrents(params: {
  imdbId?: string;
  title?: string;
  year?: number;
  originalLanguage?: string;
}): Promise<SearchResponse> {
  if (!params.title?.trim()) throw new Error('A movie title is required.');
  return search({ kind: 'movie', ...params, title: params.title.trim() });
}

export async function searchTvTorrents(params: {
  imdbId?: string;
  title?: string;
  season?: number;
  episode?: number;
  year?: number;
  tvdbId?: number;
  aliases?: string[];
  originalLanguage?: string;
}): Promise<SearchResponse> {
  if (!params.title?.trim()) throw new Error('A TV title is required.');
  return search({ kind: 'tv', ...params, title: params.title.trim() });
}

export async function searchAnimeTorrents(params: {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absolute?: number;
  aliases?: string[];
  tvdbId?: number;
  originalLanguage?: string;
}): Promise<SearchResponse> {
  if (!params.title.trim()) throw new Error('An anime title is required.');
  return search({ kind: 'anime', ...params, title: params.title.trim() });
}

export async function resolveTorrentSource(source: {
  sourceId?: string;
  magnetUri?: string;
  infoHash?: string;
}): Promise<string> {
  if (source.magnetUri?.toLowerCase().startsWith('magnet:?')) return source.magnetUri;
  const response = await postJSON<ResolveResponse>('/v1/torrents/resolve', {
    sourceId: source.sourceId,
    magnetUri: source.magnetUri,
    infoHash: source.infoHash,
  });
  if (!response.magnetUri?.toLowerCase().startsWith('magnet:?')) {
    throw new Error('Torrent backend did not return a magnet URI.');
  }
  return response.magnetUri;
}
