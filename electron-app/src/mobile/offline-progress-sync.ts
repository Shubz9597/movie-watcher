// Offline watching → server (spec D5/D06): positions saved during local
// playback are uploaded once the server is reachable again, so Continue
// watching and watched marks include what was watched on the plane. The
// server applies an item only when it is newer than its own record or
// completes it, and never un-completes a finished item. Each local save is
// sent once (tracked by its timestamp).
import type { ConnectionConfig } from '../platform/contracts';
import { syncOfflineProgress, type OfflineProgressItem } from '../lib/services/watched-service';
import { getNativeDownloads } from './downloads-adapter';

const SYNCED_KEY = 'torwatch_offline_progress_synced_v1';
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

export function syncOfflineProgressNow(connection: Pick<ConnectionConfig, 'loadOrigin'>): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const native = getNativeDownloads();
    if (!native) return;
    const { items } = await native.list();
    const synced = readSynced();
    const pending = items.filter((item) => item.seriesId
      && (item.positionS ?? 0) > 0
      && (item.durationS ?? 0) > 0
      && (item.progressUpdatedAt ?? 0) > (synced[item.downloadId] ?? 0));
    if (!pending.length) return;
    // Only progress recorded for the currently configured server is sent.
    const origin = await connection.loadOrigin();
    const forServer = pending.filter((item) => !item.origin || item.origin === origin);
    if (!forServer.length) return;
    const payload: OfflineProgressItem[] = forServer.map((item) => ({
      seriesId: item.seriesId,
      season: item.season,
      episode: item.episode,
      position_s: item.positionS ?? 0,
      duration_s: item.durationS ?? 0,
      watchedAt: Math.floor(item.progressUpdatedAt ?? Date.now() / 1000),
    }));
    await syncOfflineProgress(origin, payload);
    const next = { ...synced };
    for (const item of forServer) next[item.downloadId] = item.progressUpdatedAt ?? 0;
    writeSynced(next);
  })().catch((error) => {
    // Offline or server unavailable: retried on the next trigger.
    console.info('[OfflineProgress] sync deferred:', error instanceof Error ? error.message : error);
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
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
