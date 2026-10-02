import type { ConnectionConfig } from '../platform/contracts.ts';
import type { NativeManifestAsset } from '../platform/native-downloads.ts';
import { getDeviceId } from '../lib/device-id.ts';
import { DOWNLOADS_UI_ENABLED, getNativeDownloads } from './downloads-adapter.ts';

const STORAGE_KEY = 'torwatch_pending_downloads_v1';
const CHANGE_EVENT = 'torwatch:downloads-changed';
const activeJobs = new Map<string, Promise<void>>();
const cancelledJobs = new Set<string>();

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
  /** Requested subtitle languages (lowercase ISO 639-1); empty = none. */
  subtitles?: string[];
  /** Catalog metadata that lets the server find provider subtitles. */
  subtitleHints?: { title?: string; year?: number; imdbId?: string };
};

export type PendingDownload = DownloadSelection & {
  jobId: string;
  origin: string;
  instanceId: string;
  clientId: string;
  state: 'preparing' | 'failed';
  reason?: string;
  /** Server reason for a terminal job failure (contracts.md §3). */
  reasonCode?: string;
  /** The server job itself failed: a retry must create a NEW job. */
  jobFailed?: boolean;
  queuedAt?: number;
};

/** Thrown when the server job reached a terminal failure state. */
class JobFailedError extends Error {
  readonly reasonCode: string | undefined;
  constructor(reasonCode: string | undefined) {
    super(preparationFailure(reasonCode));
    this.reasonCode = reasonCode;
  }
}

// The server rejects malformed hints (contracts.md §3); drop anything that
// does not fit rather than failing the download over advisory metadata.
function safeSubtitleHints(hints: DownloadSelection['subtitleHints']): NonNullable<DownloadSelection['subtitleHints']> {
  const safe: NonNullable<DownloadSelection['subtitleHints']> = {};
  const title = hints?.title?.replace(/[\u0000\r\n]/g, ' ').trim();
  if (title) safe.title = title.slice(0, 300);
  if (hints?.year && hints.year >= 1870 && hints.year <= 2200) safe.year = hints.year;
  if (hints?.imdbId && /^tt\d{1,10}$/.test(hints.imdbId)) safe.imdbId = hints.imdbId;
  return safe;
}

/**
 * Builds the POST /v1/downloads/jobs body (contracts.md §3). Subtitles are
 * sent only to servers advertising downloads.subtitles.v1; requesting them
 * from an older server is an explicit error, never a silent drop.
 */
export function downloadJobRequest(
  selection: DownloadSelection,
  capabilities: readonly string[],
  clientId: string,
  idempotencyKey: string,
): Record<string, unknown> {
  const subtitles = selection.subtitles?.filter(Boolean) ?? [];
  if (subtitles.length && !capabilities.includes('downloads.subtitles.v1')) {
    throw new Error('Subtitles for downloads need a server update.');
  }
  return {
    clientId,
    idempotencyKey,
    seriesId: selection.seriesId,
    season: selection.season,
    episode: selection.episode,
    sourceId: selection.sourceId,
    sourceKind: selection.sourceKind,
    ...(selection.fileIndex == null ? {} : { fileIndex: selection.fileIndex }),
    ...(subtitles.length ? { subtitles, subtitleHints: safeSubtitleHints(selection.subtitleHints) } : {}),
  };
}

export type DownloadOptions = {
  /** Server can attach subtitle sidecars (capability downloads.subtitles.v1). */
  subtitlesSupported: boolean;
  freeBytes?: number;
};

/**
 * What the download sheet may offer: server subtitle support and this
 * device's free space. Failures degrade to "no subtitle choice", never block.
 */
export async function loadDownloadOptions(connection: Pick<ConnectionConfig, 'loadOrigin'>): Promise<DownloadOptions> {
  const native = getNativeDownloads();
  const [version, storage] = await Promise.all([
    connection.loadOrigin()
      .then((origin) => fetch(`${origin}/v1/version`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) }))
      .then((response) => (response.ok ? response.json() as Promise<{ capabilities?: string[] }> : null))
      .catch(() => null),
    native?.storage().catch(() => null) ?? Promise.resolve(null),
  ]);
  return {
    subtitlesSupported: Boolean(version?.capabilities?.includes('downloads.subtitles.v1')),
    ...(storage ? { freeBytes: storage.freeBytes } : {}),
  };
}

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
    case 'subtitles_unavailable':
      return 'Subtitles not found.';
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

export async function cancelPendingDownload(pending: PendingDownload): Promise<void> {
  cancelledJobs.add(pending.jobId);
  removePendingDownload(pending.jobId);
  try {
    await fetch(
      `${pending.origin}/v1/downloads/jobs/${encodeURIComponent(pending.jobId)}/cancel?clientId=${encodeURIComponent(pending.clientId)}`,
      { method: 'POST', headers: { Accept: 'application/json' } },
    );
  } catch {
    // The device-side cancellation is already authoritative. The server's
    // bounded retention cleanup will reclaim a package it could not cancel.
  }
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

  const sameTitle = (item: { seriesId: string; season: number; episode: number }) => (
    item.seriesId === selection.seriesId
      && item.season === selection.season
      && item.episode === selection.episode
  );
  if (readPending().some(sameTitle)) {
    throw new Error('This title is already in Downloads.');
  }
  const local = await native.list();
  if (local.items.some(sameTitle)) {
    throw new Error('This title is already in Downloads. Retry or cancel it there.');
  }

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
    body: JSON.stringify(downloadJobRequest(selection, version.capabilities, clientId, requestId())),
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
    queuedAt: Date.now(),
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

/**
 * Retries a failed download. A terminal server job cannot be revived, so it
 * is replaced by a NEW job (contracts.md §3); a polling/network failure
 * resumes the same job. `subtitles` overrides the requested languages
 * ([] = Download without subtitles).
 */
export async function retryPendingDownload(pending: PendingDownload, overrides: { subtitles?: string[] } = {}): Promise<void> {
  if (!pending.jobFailed && overrides.subtitles === undefined) {
    const retry = { ...pending, state: 'preparing' as const, reason: undefined };
    upsertPending(retry);
    void resumePendingDownload(retry);
    return;
  }
  const {
    jobId: _jobId, origin, instanceId: _instanceId, clientId: _clientId, state: _state, reason: _reason,
    reasonCode: _reasonCode, jobFailed: _jobFailed, queuedAt: _queuedAt, ...selection
  } = pending;
  removePendingDownload(pending.jobId);
  try {
    await queueNativeDownload(
      { ...selection, ...(overrides.subtitles !== undefined ? { subtitles: overrides.subtitles } : {}) },
      { loadOrigin: async () => origin },
    );
  } catch (error) {
    // Keep the item visible with the new reason instead of losing it.
    upsertPending({ ...pending, reason: error instanceof Error ? error.message : 'Download failed.' });
  }
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
      if (cancelledJobs.has(pending.jobId)) return;
      const response = await fetch(
        `${pending.origin}/v1/downloads/jobs/${encodeURIComponent(pending.jobId)}?clientId=${encodeURIComponent(pending.clientId)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (cancelledJobs.has(pending.jobId)) return;
      if (!response.ok) throw await responseError(response, 'Could not check the download.');
      const job = await response.json() as JobBody;
      if (job.state === 'preparing') {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        continue;
      }
      if (job.state !== 'ready') throw new JobFailedError(job.reasonCode);

      const manifestResponse = await fetch(
        `${pending.origin}/v1/downloads/jobs/${encodeURIComponent(pending.jobId)}/manifest?clientId=${encodeURIComponent(pending.clientId)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (cancelledJobs.has(pending.jobId)) return;
      if (!manifestResponse.ok) throw await responseError(manifestResponse, 'Could not read the download package.');
      const manifest = await manifestResponse.json() as ManifestBody;
      if (manifest.manifestVersion !== 1) throw new Error('This download format is not supported.');
      if (cancelledJobs.has(pending.jobId)) return;
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
    if (cancelledJobs.has(pending.jobId)) return;
    upsertPending({
      ...pending,
      state: 'failed',
      reason: error instanceof Error ? error.message : 'Download failed.',
      ...(error instanceof JobFailedError ? { jobFailed: true, reasonCode: error.reasonCode } : {}),
    });
  }
}
