// DownloadsPage (offline-downloads C04/WF06): the direct route to local
// media, usable with or without a server connection. There is NO global
// server-warning banner here: ready files show ordinary local actions,
// interrupted items show their own short "Waiting for server" state, and a
// failed inventory read surfaces a storage error — never a false "no
// downloads". Ready items play locally; server preparation and native
// transfer states are merged into one concise queue.
import { useEffect, useState } from 'react';
import { Film, Pause, Play, RotateCcw } from 'lucide-react';
import { useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import type { DownloadItemSnapshot, DownloadsInventory } from '../platform/contracts';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import { getNativeDownloads } from '../mobile/downloads-adapter';
import { getDeviceId } from '../lib/device-id';
import {
  pendingDownloads,
  removePendingDownload,
  resumePendingDownloads,
  retryPendingDownload,
  subscribePendingDownloads,
  type PendingDownload,
} from '../mobile/download-queue';
type DownloadsPageProps = {
  navigate: (path: string, params?: Record<string, string>) => void;
};

const EMPTY_INVENTORY: DownloadsInventory = { available: false, unreadable: false, items: [] };

function formatSize(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function progressPercent(received = 0, total = 0): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

function DownloadPoster({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[2/3] w-[76px] shrink-0 overflow-hidden rounded-xl bg-white/[0.06] sm:w-[88px]">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width="176"
          height="264"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full place-items-center text-white/25" aria-hidden="true">
          <Film className="h-6 w-6" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

function DownloadProgress({ value, label }: { value?: number; label: string }) {
  const determinate = typeof value === 'number';
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-white/10"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(determinate ? { 'aria-valuenow': value } : {})}
    >
      <div
        className={`h-full rounded-full bg-white transition-[width] duration-500 ${determinate ? '' : 'motion-safe:animate-pulse'}`}
        style={{ width: determinate ? `${value}%` : '38%' }}
      />
    </div>
  );
}

function transferStatus(item: DownloadItemSnapshot): string {
  switch (item.transferState) {
    case 'queued': return 'Queued';
    case 'downloading': return 'Downloading';
    case 'paused': return 'Paused';
    case 'ready': return 'Downloaded';
    case 'failed': return item.repairReason || 'Download interrupted';
    default: return item.state === 'needs-repair'
      ? item.repairReason || 'Needs repair'
      : item.waitingForServer ? 'Downloading' : 'Downloaded';
  }
}

export default function DownloadsPage({ navigate }: DownloadsPageProps) {
  const { downloads } = usePlatform();
  const onOpenSettings = () => window.dispatchEvent(new CustomEvent('torwatch:open-settings'));
  const compat = useConnectionStatus();
  const [inventory, setInventory] = useState<DownloadsInventory | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingDownload[]>(() => pendingDownloads());
  const [acting, setActing] = useState<Set<string>>(() => new Set());
  const [repairErrors, setRepairErrors] = useState<Record<string, string>>({});
  // D03 device-test hook: explicitly activated with ?downloads=native.
  const nativeHookActive = new URLSearchParams(window.location.search).get('downloads') === 'native'
    && getNativeDownloads() != null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const snapshot = downloads ? await downloads.inventory() : EMPTY_INVENTORY;
        if (active) setInventory(snapshot);
      } catch (error) {
        console.error('[Downloads] Inventory read failed:', error);
        // A failed read must never read as zero downloads (spec C2).
        if (active) setInventory({ ...(downloads ? { available: true } : { available: false }), unreadable: true, items: [] });
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    // Native (D03 test pass): refresh whenever durable download state changes.
    const native = getNativeDownloads();
    let handle: { remove: () => Promise<void> } | null = null;
    if (native) {
      void native.addListener('downloadsChanged', () => {
        void load();
      }).then((listener) => {
        handle = listener;
        if (!active) void listener.remove();
      });
    }
    return () => {
      active = false;
      void handle?.remove();
    };
  }, [downloads, reloadKey]);

  useEffect(() => {
    const refreshPending = () => setPending(pendingDownloads());
    const unsubscribe = subscribePendingDownloads(refreshPending);
    resumePendingDownloads();
    return unsubscribe;
  }, []);

  const playLocal = async (downloadId: string): Promise<void> => {
    const native = getNativeDownloads();
    if (!native) return;
    const { getTorWatchNativePlugin } = await import('../platform/native-player');
    await getTorWatchNativePlugin().playLocal?.({ downloadId, playId: `local-${Date.now()}` });
  };

  const runNativeAction = async (downloadId: string, action: 'pause' | 'resume'): Promise<void> => {
    const native = getNativeDownloads();
    if (!native || acting.has(downloadId)) return;
    setActing((ids) => new Set(ids).add(downloadId));
    setRepairErrors((errors) => {
      const next = { ...errors };
      delete next[downloadId];
      return next;
    });
    try {
      await native[action]({ downloadId });
      setReloadKey((key) => key + 1);
    } catch {
      setRepairErrors((errors) => ({
        ...errors,
        [downloadId]: action === 'pause' ? 'Couldn’t pause this download.' : 'Couldn’t restart. Try again.',
      }));
    } finally {
      setActing((ids) => {
        const next = new Set(ids);
        next.delete(downloadId);
        return next;
      });
    }
  };

  const online = compat.status === 'ready';

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8">
      <h1 className="type-section-title text-white">Downloads</h1>

      {loading ? (
        <div className="mt-6 space-y-3" role="status" aria-label="Loading downloads">
          {[0, 1].map((row) => (
            <div key={row} className="h-16 animate-pulse rounded-xl bg-white/[0.06]" />
          ))}
        </div>
      ) : inventory?.unreadable ? (
        // Storage failure: repair/retry, never an empty state (wireframes
        // "Downloads storage failure").
        <div className="mt-6 rounded-xl border border-white/10 bg-[#151619] p-5">
          <p className="text-sm text-white">Couldn't read your downloads</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className={`min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className={`min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 ${FOCUS_RING_CLASS}`}
            >
              Storage settings
            </button>
          </div>
        </div>
      ) : (!inventory || inventory.items.length === 0) && pending.length === 0 ? (
        // Empty: concise, no travel/setup explanation paragraph. The online
        // action finds something; the offline action goes to settings.
        <div className="mt-6 rounded-xl border border-white/10 bg-[#151619] p-5">
          <p className="text-sm text-white">No downloads yet</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {online ? (
              <button
                type="button"
                onClick={() => navigate('search')}
                className={`min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}
              >
                Find something
              </button>
            ) : null}
            <button
              type="button"
              onClick={onOpenSettings}
              className={`min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 ${FOCUS_RING_CLASS}`}
            >
              Go to settings
            </button>
          </div>
        </div>
      ) : (
        <ul className="mt-6 max-w-4xl space-y-3">
          {pending.map((item) => (
            <li
              key={`pending-${item.jobId}`}
              className="flex gap-4 rounded-xl bg-[#151619] p-3 sm:gap-5 sm:p-4"
            >
              <DownloadPoster src={item.posterUrl} />
              <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium text-white">{item.title}</p>
                    {item.subtitleLabel ? <p className="mt-0.5 truncate text-xs text-white/50">{item.subtitleLabel}</p> : null}
                  </div>
                  {item.state === 'failed' ? (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => retryPendingDownload(item)}
                        aria-label={`Retry ${item.title}`}
                        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 px-3 text-xs text-white ${FOCUS_RING_CLASS}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => removePendingDownload(item.jobId)}
                        className={`min-h-11 rounded-full px-3 text-xs text-white/55 ${FOCUS_RING_CLASS}`}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-4">
                  <div className={`mb-2 flex items-center justify-between gap-3 text-xs ${item.state === 'failed' ? 'text-red-300' : 'text-white/65'}`}>
                    <span>{item.state === 'failed' ? item.reason || 'Preparation failed' : 'Preparing on server'}</span>
                    {item.sizeBytes ? <span className="text-numeric shrink-0 text-white/45">{formatSize(item.sizeBytes)}</span> : null}
                  </div>
                  {item.state !== 'failed' ? <DownloadProgress label={`Preparing ${item.title}`} /> : null}
                </div>
              </div>
            </li>
          ))}
          {(inventory?.items ?? []).map((item) => {
            const size = formatSize(item.sizeBytes);
            const percent = progressPercent(item.receivedBytes, item.sizeBytes);
            const showProgress = item.transferState === 'queued' || item.transferState === 'downloading' || item.transferState === 'paused';
            const needsRepair = item.transferState === 'failed'
              || (item.transferState == null && item.state === 'needs-repair');
            const busy = acting.has(item.downloadId);
            return (
              <li
                key={item.downloadId}
                className="flex gap-4 rounded-xl bg-[#151619] p-3 sm:gap-5 sm:p-4"
              >
                <DownloadPoster src={item.posterUrl} />
                <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium text-white">{item.title}</p>
                      <p className="mt-0.5 truncate text-xs text-white/50">{[item.subtitle, size].filter(Boolean).join(' · ')}</p>
                    </div>
                    {item.transferState === 'downloading' ? (
                      <button
                        type="button"
                        onClick={() => void runNativeAction(item.downloadId, 'pause')}
                        disabled={busy}
                        aria-label={`Pause ${item.title}`}
                        className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/20 px-3 text-xs text-white disabled:text-white/45 ${FOCUS_RING_CLASS}`}
                      >
                        <Pause className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> Pause
                      </button>
                    ) : item.transferState === 'paused' ? (
                      <button
                        type="button"
                        onClick={() => void runNativeAction(item.downloadId, 'resume')}
                        disabled={busy}
                        aria-label={`Resume ${item.title}`}
                        className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/20 px-3 text-xs text-white disabled:text-white/45 ${FOCUS_RING_CLASS}`}
                      >
                        <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> Resume
                      </button>
                    ) : needsRepair ? (
                      <button
                        type="button"
                        onClick={() => void runNativeAction(item.downloadId, 'resume')}
                        disabled={busy}
                        aria-label={`Retry download of ${item.title}`}
                        className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/20 px-3 text-xs text-white disabled:cursor-wait disabled:text-white/45 ${FOCUS_RING_CLASS}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {busy ? 'Retrying…' : 'Retry'}
                      </button>
                    ) : item.transferState !== 'queued' ? (
                      <button
                        type="button"
                        onClick={() => void playLocal(item.downloadId)}
                        className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-white px-4 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}
                      >
                        <Play className="h-4 w-4 fill-current" aria-hidden="true" /> Play
                      </button>
                    ) : null}
                  </div>
                  {repairErrors[item.downloadId] ? (
                    <p className="mt-1 text-xs text-red-300" role="status">{repairErrors[item.downloadId]}</p>
                  ) : null}
                  <div className="mt-4" aria-live="polite">
                    <div className={`mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs ${item.transferState === 'failed' ? 'text-red-300' : 'text-white/65'}`}>
                      <span>{transferStatus(item)}</span>
                      {showProgress ? (
                        <span className="text-numeric shrink-0 text-white/50">
                          {formatSize(item.receivedBytes) || '0 MB'} of {size || '—'} · {percent}%
                        </span>
                      ) : null}
                    </div>
                    {showProgress ? <DownloadProgress value={percent} label={`${item.title} download progress`} /> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {nativeHookActive ? <NativeTestHook onDone={() => setReloadKey((key) => key + 1)} /> : null}
    </section>
  );
}

/**
 * D03 DEVICE-TEST HOOK — explicitly activated with ?downloads=native and
 * labelled. Fetches a prepared job's manifest from the configured server and
 * hands it to the native coordinator, so the whole native pipeline
 * (background transfer → verification → ready → local playback) is
 * exercisable before the D05 enqueue sheet exists. NEVER reachable without
 * the explicit parameter.
 */
function NativeTestHook({ onDone }: { onDone: () => void }) {
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const { connection } = usePlatform();
  const native = getNativeDownloads();

  const enqueue = async (): Promise<void> => {
    if (!native) return;
    const id = jobId.trim();
    if (!id) return;
    setStatus('Fetching job…');
    try {
      const origin = await connection.loadOrigin();
      const clientId = getDeviceId();
      const jobResponse = await fetch(`${origin}/v1/downloads/jobs/${encodeURIComponent(id)}?clientId=${encodeURIComponent(clientId)}`);
      if (!jobResponse.ok) {
        setStatus(`Job fetch failed (HTTP ${jobResponse.status}).`);
        return;
      }
      const job = (await jobResponse.json()) as { seriesId?: string; season?: number; episode?: number };
      const manifestResponse = await fetch(`${origin}/v1/downloads/jobs/${encodeURIComponent(id)}/manifest?clientId=${encodeURIComponent(clientId)}`);
      if (!manifestResponse.ok) {
        setStatus(`Manifest fetch failed (HTTP ${manifestResponse.status}).`);
        return;
      }
      const manifest = (await manifestResponse.json()) as {
        video: { path: string; sizeBytes: number; sha256: string };
        subtitles?: Array<{ lang: string; path: string; sizeBytes: number; sha256: string }>;
      };
      // Instance scope: the version endpoint's instanceId scopes the local
      // progress record (contracts.md §1). Fetched once per enqueue.
      let instanceId = 'unknown';
      try {
        const versionResponse = await fetch(`${origin}/v1/version`);
        if (versionResponse.ok) {
          const version = (await versionResponse.json()) as { instanceId?: string };
          instanceId = version.instanceId || 'unknown';
        }
      } catch {
        // Version discovery is best-effort for the hook.
      }
      await native.enqueue({
        downloadId: id,
        instanceId,
        origin,
        clientId,
        seriesId: job.seriesId || 'unknown',
        season: job.season || 0,
        episode: job.episode || 0,
        title: job.seriesId || id,
        video: manifest.video,
        subtitles: manifest.subtitles || [],
      });
      setStatus('Enqueued — transferring in the background.');
      onDone();
    } catch (error) {
      setStatus(`Enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const playLocal = async (): Promise<void> => {
    if (!native) return;
    const id = jobId.trim();
    if (!id) return;
    try {
      const { getTorWatchNativePlugin } = await import('../platform/native-player');
      await getTorWatchNativePlugin().playLocal?.({ downloadId: id, playId: `local-${Date.now()}` });
      setStatus('Local playback started.');
    } catch (error) {
      setStatus(`Local playback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="mt-8 rounded-xl border border-[#ffc285]/30 bg-[#ffc285]/[0.04] p-4" data-testid="native-test-hook">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#ffc285]">Device test hook (preview)</p>
      <p className="mt-1 text-xs text-white/55">Create a preparation job on the server first (idempotency key + pick id via the API), then paste its job id here.</p>
      <input
        value={jobId}
        onChange={(event) => setJobId(event.target.value)}
        placeholder="job id"
        inputMode="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="mt-3 min-h-12 w-full rounded-xl border border-white/15 bg-white/[0.06] px-3.5 text-base text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={() => void enqueue()} className={`min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}>
          Enqueue download
        </button>
        <button type="button" onClick={() => void playLocal()} className={`min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 ${FOCUS_RING_CLASS}`}>
          Play local
        </button>
      </div>
      {status ? <p className="mt-3 text-xs text-white/70" role="status">{status}</p> : null}
    </div>
  );
}
