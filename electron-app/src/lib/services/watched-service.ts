// Watched state (server /v1/watched): per-title items this device has
// started or finished, manual marking, and offline-progress sync. Episodes
// at or past the server threshold (90%) count as watched; movies use
// season 0 / episode 0. The subject is this device, matching playback
// progress and Continue watching.
import { getVodBase } from '../api-client';
import { getDeviceId } from '../device-id';

export type WatchedItem = {
  season: number;
  episode: number;
  percent: number;
  watched: boolean;
};

export type EpisodeRef = { season: number; episode: number };

export const watchedKey = (season: number, episode: number): string => `${season}:${episode}`;

export async function fetchWatched(seriesId: string): Promise<Map<string, WatchedItem>> {
  const params = new URLSearchParams({ subjectId: getDeviceId(), seriesId });
  const response = await fetch(`${getVodBase()}/v1/watched?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Watched state unavailable (${response.status})`);
  const body = await response.json() as { items?: WatchedItem[] };
  const map = new Map<string, WatchedItem>();
  for (const item of body.items ?? []) map.set(watchedKey(item.season, item.episode), item);
  return map;
}

export async function setWatched(
  seriesId: string,
  items: EpisodeRef[],
  watched: boolean,
  next?: EpisodeRef | null,
): Promise<void> {
  const response = await fetch(`${getVodBase()}/v1/watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectId: getDeviceId(), seriesId, items, watched, ...(next ? { next } : {}) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Couldn’t update watched state (${response.status})`);
}

export type OfflineProgressItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  watchedAt: number; // epoch seconds
};

/** Uploads positions recorded during offline playback; returns how many applied. */
export async function syncOfflineProgress(origin: string, items: OfflineProgressItem[]): Promise<number> {
  const response = await fetch(`${origin}/v1/watched/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectId: getDeviceId(), items }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Offline progress sync failed (${response.status})`);
  const body = await response.json() as { applied?: number };
  return body.applied ?? 0;
}
