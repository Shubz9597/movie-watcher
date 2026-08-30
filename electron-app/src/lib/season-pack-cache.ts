import type { TorrentRow } from './types';

const STORAGE_PREFIX = 'mw:season-pack:v1:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type SavedSeasonPack = {
  seriesKey: string;
  season: number;
  title: string;
  magnetUri: string;
  infoHash?: string;
  indexer: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  savedAt: number;
};

export function seasonPackSeriesKey(kind: 'tv' | 'anime', tmdbId?: number, anilistId?: number, title?: string): string {
  if (kind === 'anime' && anilistId) return `anilist:${anilistId}`;
  if (kind === 'tv' && tmdbId) return `tmdb:tv:${tmdbId}`;
  return `${kind}:title:${String(title || '').trim().toLocaleLowerCase()}`;
}

function storageKey(seriesKey: string, season: number): string {
  return `${STORAGE_PREFIX}${seriesKey}:s${season}`;
}

export function loadSeasonPack(seriesKey: string, season: number): SavedSeasonPack | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const key = storageKey(seriesKey, season);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedSeasonPack;
    if (
      value?.seriesKey !== seriesKey ||
      value?.season !== season ||
      typeof value?.magnetUri !== 'string' ||
      !value.magnetUri.startsWith('magnet:') ||
      !Number.isFinite(value.savedAt) ||
      Date.now() - value.savedAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function saveSeasonPack(seriesKey: string, season: number, row: TorrentRow, magnetUri: string): void {
  if (typeof localStorage === 'undefined' || !magnetUri.startsWith('magnet:')) return;
  const value: SavedSeasonPack = {
    seriesKey,
    season,
    title: row.title,
    magnetUri,
    infoHash: row.infoHash,
    indexer: row.indexer,
    size: row.size,
    seeders: row.seeders,
    leechers: row.leechers,
    savedAt: Date.now(),
  };
  localStorage.setItem(storageKey(seriesKey, season), JSON.stringify(value));
}

export function clearSeasonPack(seriesKey: string, season: number): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey(seriesKey, season));
}
