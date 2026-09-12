import type { PlayerRequest } from './contracts.ts';

export type BrowserProgressContext = {
  subjectId: string;
  seriesId: string;
  season: number;
  episode: number;
  sourceUri: string;
  sourceName: string;
  sourceKind: string;
  sourceFileIndex: number | null;
  nextSeason: number | null;
  nextEpisode: number | null;
};

export function buildBrowserStreamUrl(origin: string, request: PlayerRequest): string {
  const base = String(origin || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Connect TorWatch to a server before starting playback.');

  const magnet = String(request.magnet || request.url || '').trim();
  if (!magnet) throw new Error('The selected source does not include a playable torrent.');

  const params = new URLSearchParams({
    cat: request.cat || 'movie',
    magnet,
  });
  if (Number.isInteger(request.fileIndex) && Number(request.fileIndex) >= 0) {
    params.set('fileIndex', String(request.fileIndex));
  }
  return `${base}/stream?${params.toString()}`;
}

export function browserProgressContext(request: PlayerRequest): BrowserProgressContext | null {
  const subjectId = String(request.subjectId || '').trim();
  const seriesId = String(request.seriesId || '').trim();
  const season = Number(request.season ?? 0);
  const episode = Number(request.episode ?? 0);
  if (!subjectId || !seriesId || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
    return null;
  }

  const fileIndex = Number(request.fileIndex);
  const nextSeason = Number(request.nextSeason);
  const nextEpisode = Number(request.nextEpisode);
  const hasNextEpisode = Number.isInteger(nextSeason)
    && Number.isInteger(nextEpisode)
    && nextSeason >= 0
    && nextEpisode > 0
    && (nextSeason !== season || nextEpisode !== episode);

  return {
    subjectId,
    seriesId,
    season,
    episode,
    sourceUri: String(request.magnet || request.url || '').trim(),
    sourceName: String(request.sourceName || '').trim(),
    sourceKind: String(request.cat || '').trim(),
    sourceFileIndex: Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : null,
    nextSeason: hasNextEpisode ? nextSeason : null,
    nextEpisode: hasNextEpisode ? nextEpisode : null,
  };
}
