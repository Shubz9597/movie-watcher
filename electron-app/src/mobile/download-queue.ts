import type { ConnectionConfig } from '../platform/contracts.ts';
import type { NativeManifestAsset } from '../platform/native-downloads.ts';
import { getDeviceId } from '../lib/device-id.ts';
import { DOWNLOADS_UI_ENABLED, getNativeDownloads } from './downloads-adapter.ts';

const STORAGE_KEY = 'torwatch_pending_downloads_v1';
const CHANGE_EVENT = 'torwatch:downloads-changed';
const activeJobs = new Map<string, Promise<void>>();

export type DownloadSelection = {
  seriesId: string;
  sourceId: string;
  sourceKind: 'movie' | 'tv' | 'anime';
  fileIndex?: number;
  season: number;
  episode: number;
  title: string;
  posterUrl?: string | null;
  subtitleLabel?: string;
  sizeBytes?: number;
};

export type PendingDownload = DownloadSelection & {
  jobId: string;
  origin: string;
  instanceId: string;
  clientId: string;
  state: 'preparing' | 'failed';
  reason?: string;
};

type JobBody = {
  jobId: string;
  state: 'preparing' | 'ready' | 'failed' | 'cancelled' | 'expired';
  reasonCode?: string;
};

function preparationFailure(reasonCode?: string): string {
  switch (reasonCode) {
    case 'source_unavailable':
      return 'Source unavailable. Choose another source.';
    case 'insufficient_server_storage':
      return 'Not enough server storage.';
    case 'retention_expired':
      return 'Download expired. Start it again.';
    default:
      return 'Could not prepare this source.';
  }
}

type ManifestBody = {
  manifestVersion: number;
  video: NativeManifestAsset;
  subtitles?: NativeManifestAsset[];
};

function notify(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function readPending(): PendingDownload[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePending(items: PendingDownload[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  notify();
}

function upsertPending(item: PendingDownload): void {
  const items = readPending().filter((current) => current.jobId !== item.jobId);
  items.push(item);
  writePending(items);
}

export function removePendingDownload(jobId: string): void {
  writePending(readPending().filter((item) => item.jobId !== jobId));
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${getDeviceId()}-${Date.now()}`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(payload?.error?.message || fallback);
}

export function nativeDownloadsSupported(): boolean {
  return DOWNLOADS_UI_ENABLED && getNativeDownloads() !== null;
}

export function pendingDownloads(): PendingDownload[] {
  return readPending();
}

export function subscribePendingDownloads(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export async function queueNativeDownload(
  selection: DownloadSelection,
  connection: Pick<ConnectionConfig, 'loadOrigin'>,
): Promise<PendingDownload> {
  const native = getNativeDownloads();
  if (!DOWNLOADS_UI_ENABLED || !native) throw new Error('Downloads are unavailable on this device.');
  if (!selection.seriesId || !selection.sourceId) throw new Error('Choose this source again, then download it.');

  if (selection.sizeBytes && selection.sizeBytes > 0) {
    const storage = await native.storage();
    if (storage.freeBytes < selection.sizeBytes) throw new Error('Not enough storage for this download.');
  }

  const origin = await connection.loadOrigin();
  const versionResponse = await fetch(`${origin}/v1/version`, { headers: { Accept: 'application/json' } });
  if (!versionResponse.ok) throw new Error('Could not check download support.');
  const version = await versionResponse.json() as { instanceId?: string; capabilities?: string[] };
  if (!version.instanceId || !version.capabilities?.includes('downloads.offline.v1')) {
    throw new Error('Online downloads need a server update.');
  }

  const clientId = getDeviceId();
  const createResponse = await fetch(`${origin}/v1/downloads/jobs`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      idempotencyKey: requestId(),
      seriesId: selection.seriesId,
      season: selection.season,
      episode: selection.episode,
      sourceId: selection.sourceId,
      sourceKind: selection.sourceKind,
      ...(selection.fileIndex == null ? {} : { fileIndex: selection.fileIndex }),
    }),
  });
  if (!createResponse.ok) throw await responseError(createResponse, 'Could not start the download.');
  const job = await createResponse.json() as JobBody;
  const pending: PendingDownload = {
    ...selection,
    jobId: job.jobId,
    origin,
    instanceId: version.instanceId,
    clientId,
    state: 'preparing',
  };
  upsertPending(pending);
  void resumePendingDownload(pending);
  return pending;
}

export function resumePendingDownloads(): void {
  for (const pending of readPending()) {
    if (pending.state === 'preparing') void resumePendingDownload(pending);
  }
}

export function retryPendingDownload(pending: PendingDownload): void {
  const retry = { ...pending, state: 'preparing' as const, reason: undefined };
  upsertPending(retry);
  void resumePendingDownload(retry);
}

async function resumePendingDownload(pending: PendingDownload): Promise<void> {
  const existing = activeJobs.get(pending.jobId);
  if (existing) return existing;
  const task = monitorAndEnqueue(pending).finally(() => activeJobs.delete(pending.jobId));
  activeJobs.set(pending.jobId, task);
  return task;
}

async function monitorAndEnqueue(pending: PendingDownload): Promise<void> {
  const native = getNativeDownloads();
  if (!native) return;
  try {
    for (;;) {
      const response = await fetch(
        `${pending.origin}/v1/downloads/jobs/${encodeURIComponent(pending.jobId)}?clientId=${encodeURIComponent(pending.clientId)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw await responseError(response, 'Could not check the download.');
      const job = await response.json() as JobBody;
      if (job.state === 'preparing') {
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
        continue;
      }
      if (job.state !== 'ready') throw new Error(preparationFailure(job.reasonCode));

      const manifestResponse = await fetch(
        `${pending.origin}/v1/downloads/jobs/${encodeURIComponent(pending.jobId)}/manifest?clientId=${encodeURIComponent(pending.clientId)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!manifestResponse.ok) throw await responseError(manifestResponse, 'Could not read the download package.');
      const manifest = await manifestResponse.json() as ManifestBody;
      if (manifest.manifestVersion !== 1) throw new Error('This download format is not supported.');
      await native.enqueue({
        downloadId: pending.jobId,
        instanceId: pending.instanceId,
        origin: pending.origin,
        clientId: pending.clientId,
        seriesId: pending.seriesId,
        season: pending.season,
        episode: pending.episode,
        title: pending.title,
        posterUrl: pending.posterUrl || undefined,
        subtitleLabel: pending.subtitleLabel,
        video: manifest.video,
        subtitles: manifest.subtitles || [],
      });
      removePendingDownload(pending.jobId);
      return;
    }
  } catch (error) {
    upsertPending({
      ...pending,
      state: 'failed',
      reason: error instanceof Error ? error.message : 'Download failed.',
    });
  }
}
