// Offline watching → server (spec D5/D06): positions saved during local
// playback are uploaded once the server is reachable again, so Continue
// watching and watched marks include what was watched on the plane. The
// server applies an item only when it is newer than its own record or
// completes it, and never un-completes a finished item. Each local save is
// sent once (tracked by its timestamp).
//
// And back: an episode watched further on another device (finished on the
// desktop) moves the download's saved position too, so Downloads doesn't
// show "68% watched" and Play doesn't resume there.
import type { ConnectionConfig } from '../platform/contracts';
import { fetchWatched, syncOfflineProgress, watchedKey, type OfflineProgressItem } from '../lib/services/watched-service';
import { getNativeDownloads } from './downloads-adapter';

const SYNCED_KEY = 'torwatch_offline_progress_synced_v1';
/** Fired after positions from the server were saved on the device. */
export const OFFLINE_PROGRESS_PULLED = 'torwatch:offline-progress-pulled';
let inFlight: Promise<void> | null = null;

function readSynced(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNCED_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function writeSynced(value: Record<string, number>): void {
  try {
    localStorage.setItem(SYNCED_KEY, JSON.stringify(value));
  } catch {
    // Unsaved markers only mean an idempotent resend next time.
  }
}

/** Sends these downloads' progress again (they were refiled under another
 *  episode, refile-downloads.ts). */
export function resendOfflineProgress(downloadIds: string[]): void {
  if (!downloadIds.length) return;
  const synced = readSynced();
  for (const id of downloadIds) delete synced[id];
  writeSynced(synced);
}

export function syncOfflineProgressNow(connection: Pick<ConnectionConfig, 'loadOrigin'>): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const native = getNativeDownloads();
    if (!native) return;
    const { items } = await native.list();
    // Only progress recorded for the currently configured server is sent.
    const origin = await connection.loadOrigin();
    const synced = readSynced();
    const pending = items.filter((item) => item.seriesId
      && (item.positionS ?? 0) > 0
      && (item.durationS ?? 0) > 0
      && (item.progressUpdatedAt ?? 0) > (synced[item.downloadId] ?? 0));
    const forServer = pending.filter((item) => !item.origin || item.origin === origin);
    if (forServer.length) {
      const payload: OfflineProgressItem[] = forServer.map((item) => ({
        seriesId: item.seriesId,
        season: item.season,
        episode: item.episode,
        position_s: item.positionS ?? 0,
        duration_s: item.durationS ?? 0,
        watchedAt: Math.floor(item.progressUpdatedAt ?? Date.now() / 1000),
      }));
      await syncOfflineProgress(origin, payload);
      for (const item of forServer) synced[item.downloadId] = item.progressUpdatedAt ?? 0;
      writeSynced(synced);
    }
    await pullServerProgress(native, items.filter((item) => item.state === 'ready' && item.seriesId
      && (!item.origin || item.origin === origin)), origin, synced);
  })().catch((error) => {
    // Offline or server unavailable: retried on the next trigger.
    console.info('[OfflineProgress] sync deferred:', error instanceof Error ? error.message : error);
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

type NativeList = NonNullable<ReturnType<typeof getNativeDownloads>>;
type NativeItem = Awaited<ReturnType<NativeList['list']>>['items'][number];

/** Positions the server has from later watching elsewhere, saved on the
 *  device. Newer wins; equal positions are left alone. */
async function pullServerProgress(native: NativeList, items: NativeItem[], origin: string, synced: Record<string, number>): Promise<void> {
  const shows = new Map<string, NativeItem[]>();
  for (const item of items) shows.set(item.seriesId!, [...(shows.get(item.seriesId!) ?? []), item]);
  let changed = 0;
  for (const [seriesId, episodes] of shows) {
    const server = await fetchWatched(seriesId, origin).catch(() => null);
    if (!server) continue;
    for (const item of episodes) {
      const remote = server.get(watchedKey(item.season ?? 0, item.episode ?? 0));
      const position = remote?.position_s ?? 0;
      const duration = remote?.duration_s ?? 0;
      if (!remote?.updated_at || duration <= 0) continue;
      if (remote.updated_at <= (item.progressUpdatedAt ?? 0)) continue;
      if (Math.abs(position - (item.positionS ?? 0)) < 5) continue;
      try {
        await native.saveProgress({ downloadId: item.downloadId, positionS: position, durationS: duration, subtitleLang: item.subtitleLang ?? '' });
        // Came from the server: not sent back.
        synced[item.downloadId] = Math.ceil(Date.now() / 1000) + 1;
        changed += 1;
      } catch {
        // The next sync tries again.
      }
    }
  }
  if (changed) {
    writeSynced(synced);
    window.dispatchEvent(new CustomEvent(OFFLINE_PROGRESS_PULLED));
  }
}

/** Sync now and whenever the app regains network or returns to the foreground. */
export function startOfflineProgressSync(connection: Pick<ConnectionConfig, 'loadOrigin'>): void {
  const run = () => void syncOfflineProgressNow(connection);
  run();
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
}
