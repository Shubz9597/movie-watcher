// DownloadsPage (offline-downloads C04/WF06): the direct route to local
// media, usable with or without a server connection. There is NO global
// server-warning banner here: ready files show ordinary local actions,
// interrupted items show their own short "Waiting for server" state, and a
// failed inventory read surfaces a storage error — never a false "no
// downloads". Ready items play locally; server preparation and native
// transfer states are merged into one concise queue.
import { useEffect, useState } from 'react';
import { ChevronRight, Film, LoaderCircle, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import type { DownloadItemSnapshot, DownloadsInventory, DownloadsStorage } from '../platform/contracts';
import { SelectionSurface } from '../components/primitives';
import { ACTION_PRIMARY_CLASS, ACTION_SECONDARY_CLASS, FOCUS_RING_CLASS } from '../lib/design-tokens';
import { getNativeDownloads } from '../mobile/downloads-adapter';
import { getDeviceId } from '../lib/device-id';
import { SUBTITLE_LANGUAGES } from '../lib/subtitle-languages';
import { forgetOfflineSkipSegments } from '../lib/offline-skip-segments';
import { downloadMeta, forgetDownloadMeta } from '../lib/offline-download-meta';
import { describePreparing, preparingFraction } from '../lib/preparing-status';
import {
  cancelPendingDownload,
  pendingDownloads,
  preparingProgressFor,
  resumePendingDownloads,
  retryPendingDownload,
  subscribePendingDownloads,
  type PendingDownload,
} from '../mobile/download-queue';
type DownloadsPageProps = {
  navigate: (path: string, params?: Record<string, string>) => void;
  /** downloads-series route: show one show's episodes by season. */
  seriesId?: string | null;
};

const EMPTY_INVENTORY: DownloadsInventory = { available: false, unreadable: false, items: [] };

function formatSize(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatRate(bytesPerSecond?: number): string | null {
  const size = formatSize(bytesPerSecond);
  return size ? `${size}/s` : null;
}

function formatEta(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return '<1m';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

// How far this download has been watched on the device (2..100%), or
// undefined when it has not been started.
function watchedPercent(item: { positionS?: number; durationS?: number }): number | undefined {
  const position = item.positionS ?? 0;
  const duration = item.durationS ?? 0;
  if (position <= 0 || duration <= 0) return undefined;
  return Math.max(2, Math.min(100, Math.round((position / duration) * 100)));
}

function progressPercent(received = 0, total = 0): number | undefined {
  if (total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

function DownloadPoster({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[2/3] w-[72px] shrink-0 overflow-hidden rounded-lg bg-white/[0.06] sm:w-[88px]">
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

/** "4 · Good News About Hell", or "Episode 4" without a stored name. */
function episodeLabel(episode: number | undefined, name: string | undefined): string {
  if (episode == null) return name ?? 'Episode';
  return name ? `${episode} · ${name}` : `Episode ${episode}`;
}

// Episode rows lead with the episode still (16:9), stored on the device so
// it also shows offline.
function EpisodeStill({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-video w-[112px] shrink-0 self-start overflow-hidden rounded-lg bg-white/[0.06] sm:w-[144px]">
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full place-items-center text-white/25" aria-hidden="true">
          <Film className="h-5 w-5" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

// Unknown totals stay indeterminate (spec D2): no invented percentage.
function DownloadProgress({ value, label }: { value?: number; label: string }) {
  const determinate = typeof value === 'number';
  return (
    <div
      className="h-1 overflow-hidden rounded-full bg-white/10"
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

function subtitleSummary(langs?: string[]): string | null {
  const lang = langs?.[0];
  if (!lang) return null;
  const name = SUBTITLE_LANGUAGES.find((language) => language.code === lang)?.name ?? lang.toUpperCase();
  return `${name} subtitles`;
}

function transferStatus(item: DownloadItemSnapshot): string {
  switch (item.transferState) {
    case 'queued': return 'Queued';
    case 'downloading': return 'Downloading';
    case 'paused': return 'Paused';
    case 'verifying': return 'Checking file';
    case 'ready': return 'Ready';
    case 'failed': return item.repairReason || 'Needs repair';
    default: return item.state === 'needs-repair'
      ? item.repairReason || 'Needs repair'
      : item.waitingForServer ? 'Waiting for server' : 'Ready';
  }
}

type EpisodeLike = { seriesId?: string; season?: number; episode?: number };

function isEpisode(item: EpisodeLike): boolean {
  return Boolean(item.seriesId) && ((item.season ?? 0) > 0 || (item.episode ?? 0) > 0);
}

function byEpisode(left: EpisodeLike, right: EpisodeLike): number {
  return (left.episode ?? 0) - (right.episode ?? 0);
}

type DownloadGroup =
  | { kind: 'pending'; item: PendingDownload }
  | { kind: 'item'; item: DownloadItemSnapshot }
  | {
    kind: 'show';
    seriesId: string;
    title: string;
    posterUrl?: string | null;
    count: number;
    bytes: number;
    summary: string | null;
    needsAttention: boolean;
  };

// Episodes collapse into one entry per show (first-seen order); movies and
// anything without series identity stay individual rows.
function groupDownloads(pending: PendingDownload[], items: DownloadItemSnapshot[]): DownloadGroup[] {
  const groups: DownloadGroup[] = [];
  const shows = new Map<string, Extract<DownloadGroup, { kind: 'show' }> & { downloading: number; preparing: number; failed: number }>();
  const showFor = (seriesId: string, title: string, posterUrl?: string | null) => {
    let show = shows.get(seriesId);
    if (!show) {
      show = { kind: 'show', seriesId, title, posterUrl, count: 0, bytes: 0, summary: null, needsAttention: false, downloading: 0, preparing: 0, failed: 0 };
      shows.set(seriesId, show);
      groups.push(show);
    }
    if (!show.posterUrl && posterUrl) show.posterUrl = posterUrl;
    return show;
  };
  for (const item of pending) {
    if (!isEpisode(item)) {
      groups.push({ kind: 'pending', item });
      continue;
    }
    const show = showFor(item.seriesId, item.title, downloadMeta(item.jobId).poster ?? item.posterUrl);
    show.count += 1;
    if (item.state === 'failed') show.failed += 1;
    else show.preparing += 1;
  }
  for (const item of items) {
    if (!isEpisode(item) || !item.seriesId) {
      groups.push({ kind: 'item', item });
      continue;
    }
    const show = showFor(item.seriesId, item.title, downloadMeta(item.downloadId).poster ?? item.posterUrl);
    show.count += 1;
    show.bytes += item.sizeBytes ?? 0;
    if (item.transferState === 'failed' || (item.transferState == null && item.state === 'needs-repair')) show.failed += 1;
    else if (item.transferState && item.transferState !== 'ready') show.downloading += 1;
  }
  for (const show of shows.values()) {
    const parts = [
      show.downloading ? `${show.downloading} downloading` : null,
      show.preparing ? `${show.preparing} preparing` : null,
      show.failed ? `${show.failed} need${show.failed === 1 ? 's' : ''} repair` : null,
    ].filter(Boolean);
    show.summary = parts.length ? parts.join(' · ') : null;
    show.needsAttention = show.failed > 0;
  }
  return groups;
}

const ROW_CLASS = 'flex gap-4 rounded-lg bg-[var(--surface-raised)] p-3 sm:p-4';
const CANCEL_CLASS = `inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:text-white/35 ${FOCUS_RING_CLASS}`;
const ROW_ACTION_CLASS = `${ACTION_SECONDARY_CLASS} px-4`;

export default function DownloadsPage({ navigate, seriesId }: DownloadsPageProps) {
  const { downloads } = usePlatform();
  const onOpenSettings = () => window.dispatchEvent(new CustomEvent('torwatch:open-settings'));
  const compat = useConnectionStatus();
  const [inventory, setInventory] = useState<DownloadsInventory | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingDownload[]>(() => pendingDownloads());
  const [acting, setActing] = useState<Set<string>>(() => new Set());
  const [repairErrors, setRepairErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<DownloadsStorage | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<DownloadItemSnapshot | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
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
        // Local usage is supplementary: a failed read hides the line only.
        const usage = await downloads?.storage?.().catch(() => null);
        if (active) setStorage(usage ?? null);
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
    // A new array each time: live progress changes without the stored
    // pending items changing.
    const refreshPending = () => setPending([...pendingDownloads()]);
    const unsubscribe = subscribePendingDownloads(refreshPending);
    resumePendingDownloads();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!pending.some((item) => item.state === 'preparing')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const playLocal = (item: DownloadItemSnapshot): void => {
    navigate('player', {
      downloadId: item.downloadId,
      title: item.title,
      ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      // Show identity lets offline playback continue with the next
      // downloaded episode.
      ...(item.seriesId ? { localSeriesId: item.seriesId, season: String(item.season ?? 0), episode: String(item.episode ?? 0) } : {}),
    });
  };

  const runNativeAction = async (downloadId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
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
        [downloadId]: action === 'pause'
          ? 'Couldn’t pause. Try again.'
          : action === 'cancel' ? 'Couldn’t cancel. Try again.' : 'Couldn’t resume. Try again.',
      }));
    } finally {
      setActing((ids) => {
        const next = new Set(ids);
        next.delete(downloadId);
        return next;
      });
    }
  };

  const confirmRemoval = async (item: DownloadItemSnapshot): Promise<void> => {
    if (!downloads?.remove || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await downloads.remove(item.downloadId);
      forgetOfflineSkipSegments(item.downloadId);
      forgetDownloadMeta(item.downloadId);
      setPendingRemoval(null);
      setReloadKey((key) => key + 1);
    } catch {
      setRemoveError('Couldn’t remove this download. Try again.');
    } finally {
      setRemoving(false);
    }
  };

  const online = compat.status === 'ready';
  const seriesTitle = seriesId
    ? ((inventory?.items ?? []).find((item) => item.seriesId === seriesId)?.title
      ?? pending.find((item) => item.seriesId === seriesId)?.title
      ?? 'Downloads')
    : 'Downloads';

  // Rows are shared by the overview and a show's episode screen; the
  // episode view drops the repeated poster and leads with "Episode N".
  const renderPending = (item: PendingDownload, episodeView = false) => {
    const failed = item.state === 'failed';
    const elapsed = formatElapsed(item.queuedAt, now);
    const progress = failed ? undefined : preparingProgressFor(item.jobId);
    const fraction = preparingFraction(progress);
    return (
      <li key={`pending-${item.jobId}`} className={ROW_CLASS}>
        {episodeView ? <EpisodeStill src={downloadMeta(item.jobId).still} /> : <DownloadPoster src={downloadMeta(item.jobId).poster ?? item.posterUrl} />}
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 pt-1">
              <p className="truncate text-base font-medium text-white">{episodeView ? episodeLabel(item.episode, downloadMeta(item.jobId).episodeTitle) : item.title}</p>
              <p className="type-secondary text-numeric mt-0.5 truncate text-white/60">
                {[episodeView ? null : item.subtitleLabel, formatSize(item.sizeBytes), subtitleSummary(item.subtitles)].filter(Boolean).join(' · ')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void cancelPendingDownload(item)}
              aria-label={`Cancel download of ${item.title}`}
              title="Cancel download"
              className={CANCEL_CLASS}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" aria-live="polite">
            <span className={`type-secondary inline-flex min-w-0 items-center gap-2 ${failed ? 'text-red-300' : 'text-white/70'}`}>
              {!failed ? <LoaderCircle className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : null}
              <span>{failed ? item.reason || 'Couldn’t prepare this source.' : `${describePreparing(progress)}${elapsed ? ` · ${elapsed}` : ''}`}</span>
            </span>
            {fraction != null ? (
              <div className="h-1 w-full overflow-hidden rounded-full bg-white/15" role="progressbar" aria-label="Server download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(fraction * 100)}>
                <div className="h-full rounded-full bg-white/80" style={{ width: `${fraction * 100}%` }} />
              </div>
            ) : null}
            {failed ? (
              <div className="flex flex-wrap gap-2">
                {item.reasonCode === 'subtitles_unavailable' ? (
                  // Explicit choice (spec D3): never drop the
                  // requested subtitles silently.
                  <button
                    type="button"
                    onClick={() => void retryPendingDownload(item, { subtitles: [] })}
                    aria-label={`Download ${item.title} without subtitles`}
                    className={ROW_ACTION_CLASS}
                  >
                    Without subtitles
                  </button>
                ) : null}
                <button type="button" onClick={() => void retryPendingDownload(item)} aria-label={`Retry ${item.title}`} className={ROW_ACTION_CLASS}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" /> Retry
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  const renderItem = (item: DownloadItemSnapshot, episodeView = false) => {
    const size = formatSize(item.sizeBytes);
    const received = formatSize(item.receivedBytes);
    const percent = progressPercent(item.receivedBytes, item.sizeBytes);
    const inTransfer = item.transferState === 'queued'
      || item.transferState === 'downloading'
      || item.transferState === 'paused'
      || item.transferState === 'verifying'
      || (item.transferState == null && item.waitingForServer === true);
    const needsRepair = item.transferState === 'failed'
      || (item.transferState == null && item.state === 'needs-repair');
    const ready = !inTransfer && !needsRepair;
    const busy = acting.has(item.downloadId);
    const rate = item.transferState === 'downloading' ? formatRate(item.bytesPerSecond) : null;
    const eta = item.transferState === 'downloading' ? formatEta(item.etaSeconds) : null;
    const amount = size
      ? `${received || '0 MB'} of ${size}${typeof percent === 'number' ? ` · ${percent}%` : ''}`
      : received;
    return (
      <li key={item.downloadId} className={ROW_CLASS}>
        {episodeView ? <EpisodeStill src={downloadMeta(item.downloadId).still} /> : <DownloadPoster src={downloadMeta(item.downloadId).poster ?? item.posterUrl} />}
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 pt-1">
              <p className="truncate text-base font-medium text-white">{episodeView ? episodeLabel(item.episode, downloadMeta(item.downloadId).episodeTitle) : item.title}</p>
              <p className="type-secondary text-numeric mt-0.5 truncate text-white/60">
                {[episodeView ? null : item.subtitle, ready ? size : null].filter(Boolean).join(' · ')}
              </p>
            </div>
            {!ready && item.transferState !== 'verifying' ? (
              <button
                type="button"
                onClick={() => void runNativeAction(item.downloadId, 'cancel')}
                disabled={busy}
                aria-label={`Cancel download of ${item.title}`}
                title="Cancel download"
                className={CANCEL_CLASS}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            ) : ready && downloads?.remove ? (
              <button
                type="button"
                onClick={() => {
                  setRemoveError(null);
                  setPendingRemoval(item);
                }}
                aria-label={`Remove ${item.title}`}
                title="Remove download"
                className={CANCEL_CLASS}
              >
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {ready ? (
            <div>
              {watchedPercent(item) !== undefined ? (
                // Saved on the device, so it shows offline too.
                <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-label={`${item.title} watched`} aria-valuenow={watchedPercent(item)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-white" style={{ width: `${watchedPercent(item)}%` }} />
                </div>
              ) : null}
              <button type="button" onClick={() => playLocal(item)} className={`${ACTION_PRIMARY_CLASS} px-4`}>
                <Play className="h-4 w-4 fill-current" aria-hidden="true" /> {watchedPercent(item) !== undefined && (watchedPercent(item) ?? 0) < 90 ? 'Resume' : 'Play'}
              </button>
            </div>
          ) : (
            <div aria-live="polite">
              <div className={`type-secondary mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 ${needsRepair ? 'text-red-300' : 'text-white/70'}`}>
                <span>{transferStatus(item)}</span>
                {inTransfer && amount ? <span className="text-numeric shrink-0 text-white/60">{amount}</span> : null}
              </div>
              {inTransfer ? <DownloadProgress value={percent} label={`${item.title} download progress`} /> : null}
              {repairErrors[item.downloadId] ? (
                <p className="type-secondary mt-2 text-red-300" role="status">{repairErrors[item.downloadId]}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                {rate || eta ? (
                  <div className="type-secondary text-numeric flex items-center gap-4 text-white/60">
                    {rate ? <span>Speed <span className="text-white/85">{rate}</span></span> : null}
                    {eta ? <span>ETA <span className="text-white/85">{eta}</span></span> : null}
                  </div>
                ) : <span />}
                {item.transferState === 'downloading' ? (
                  <button
                    type="button"
                    onClick={() => void runNativeAction(item.downloadId, 'pause')}
                    disabled={busy}
                    aria-label={`Pause ${item.title}`}
                    className={ROW_ACTION_CLASS}
                  >
                    <Pause className="h-4 w-4 fill-current" aria-hidden="true" /> Pause
                  </button>
                ) : item.transferState === 'paused' ? (
                  <button
                    type="button"
                    onClick={() => void runNativeAction(item.downloadId, 'resume')}
                    disabled={busy}
                    aria-label={`Resume ${item.title}`}
                    className={ROW_ACTION_CLASS}
                  >
                    <Play className="h-4 w-4 fill-current" aria-hidden="true" /> Resume
                  </button>
                ) : needsRepair ? (
                  <button
                    type="button"
                    onClick={() => void runNativeAction(item.downloadId, 'resume')}
                    disabled={busy}
                    aria-label={`Retry download of ${item.title}`}
                    className={`${ROW_ACTION_CLASS} disabled:cursor-wait`}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> {busy ? 'Retrying…' : 'Retry'}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </li>
    );
  };

  // Overview: movies as rows, episodes grouped into one row per show.
  const renderOverview = () => {
    const groups = groupDownloads(pending, inventory?.items ?? []);
    return (
      <ul className="space-y-3">
        {groups.map((group) => {
          if (group.kind === 'pending') return renderPending(group.item);
          if (group.kind === 'item') return renderItem(group.item);
          return (
            <li key={`show-${group.seriesId}`}>
              <button
                type="button"
                onClick={() => navigate('downloads-series', { series: group.seriesId })}
                className={`${ROW_CLASS} w-full items-center text-left transition hover:bg-white/[0.06] ${FOCUS_RING_CLASS}`}
              >
                <DownloadPoster src={group.posterUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-white">{group.title}</p>
                  <p className="type-secondary text-numeric mt-0.5 text-white/60">
                    {[`${group.count} ${group.count === 1 ? 'episode' : 'episodes'}`, formatSize(group.bytes)].filter(Boolean).join(' · ')}
                  </p>
                  {group.summary ? (
                    <p className={`type-secondary mt-2 ${group.needsAttention ? 'text-red-300' : 'text-white/70'}`}>{group.summary}</p>
                  ) : null}
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-white/50" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  // A show's screen: episodes grouped by season, newest season last.
  const renderSeries = (id: string) => {
    const showPending = pending.filter((item) => item.seriesId === id && isEpisode(item));
    const showItems = (inventory?.items ?? []).filter((item) => item.seriesId === id && isEpisode(item));
    if (!showPending.length && !showItems.length) {
      return (
        <div>
          <p className="type-body text-white">No episodes downloaded</p>
          <button type="button" onClick={() => navigate('downloads')} className={`mt-4 ${ACTION_SECONDARY_CLASS}`}>
            Back to Downloads
          </button>
        </div>
      );
    }
    const seasons = Array.from(new Set([...showPending, ...showItems].map((item) => item.season ?? 0))).sort((a, b) => a - b);
    return (
      <div>
        {seasons.map((season, index) => (
          <section key={season} className={index ? 'mt-6' : ''} aria-label={`Season ${season}`}>
            <h3 className="type-secondary mb-3 font-medium text-white/70">Season {season}</h3>
            <ul className="space-y-3">
              {showPending.filter((item) => item.season === season).sort(byEpisode).map((item) => renderPending(item, true))}
              {showItems.filter((item) => (item.season ?? 0) === season).sort(byEpisode).map((item) => renderItem(item, true))}
            </ul>
          </section>
        ))}
      </div>
    );
  };


  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      <h1 className="type-section-title text-white">{seriesId ? seriesTitle : 'Downloads'}</h1>
      {!seriesId && storage && inventory?.items.length ? (
        <p className="type-secondary text-numeric mt-1 text-white/60">
          {formatSize(storage.usedBytes) ?? '0 MB'} used · {formatSize(storage.freeBytes) ?? '0 MB'} free
        </p>
      ) : null}

      {/* Placeholders only before the first read: later refreshes (pause,
          resume, progress) update the list in place, so it never collapses
          and throws the viewer back to the top. */}
      {loading && !inventory ? (
        <div className="mt-6 max-w-4xl space-y-3" role="status" aria-label="Loading downloads">
          {[0, 1].map((row) => (
            <div key={row} className="h-[132px] animate-pulse rounded-lg bg-white/[0.06] sm:h-[164px]" />
          ))}
        </div>
      ) : inventory?.unreadable ? (
        // Storage failure: repair/retry, never an empty state (wireframes
        // "Downloads storage failure").
        <div className="mt-6">
          <p className="type-body text-white">Couldn’t read your downloads</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className={ACTION_PRIMARY_CLASS}>
              Retry
            </button>
            <button type="button" onClick={onOpenSettings} className={ACTION_SECONDARY_CLASS}>
              Storage settings
            </button>
          </div>
        </div>
      ) : (!inventory || inventory.items.length === 0) && pending.length === 0 ? (
        // Empty: concise, no travel/setup explanation paragraph. The online
        // action finds something; the offline action goes to settings.
        <div className="mt-6">
          <p className="type-body text-white">No downloads yet</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {online ? (
              <button type="button" onClick={() => navigate('search')} className={ACTION_PRIMARY_CLASS}>
                Find something
              </button>
            ) : (
              <button type="button" onClick={onOpenSettings} className={ACTION_SECONDARY_CLASS}>
                Go to settings
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-6 max-w-4xl">
          {seriesId ? renderSeries(seriesId) : renderOverview()}
        </div>
      )}
      {/* Deletion is deliberate (wireframes "Deletion"): state what is
          removed and what is kept before the destructive action. */}
      <SelectionSurface open={pendingRemoval != null} title="Remove download?" onClose={() => { if (!removing) setPendingRemoval(null); }}>
        {pendingRemoval ? (
          <div className="pb-1">
            <p className="type-body text-white">{pendingRemoval.title}{pendingRemoval.subtitle ? ` · ${pendingRemoval.subtitle}` : ''}</p>
            <p className="type-secondary mt-1 text-white/70">
              {formatSize(pendingRemoval.sizeBytes) ? `Frees ${formatSize(pendingRemoval.sizeBytes)} on this device. ` : 'Deletes the file from this device. '}
              Watch Later and Favourites stay as they are.
            </p>
            {removeError ? <p className="type-secondary mt-3 text-red-300" role="alert">{removeError}</p> : null}
            <div className="mt-5 grid gap-3">
              <button
                type="button"
                disabled={removing}
                onClick={() => void confirmRemoval(pendingRemoval)}
                className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-red-600 px-5 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60 ${FOCUS_RING_CLASS}`}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" /> {removing ? 'Removing…' : 'Remove download'}
              </button>
              <button type="button" disabled={removing} onClick={() => setPendingRemoval(null)} className={ACTION_SECONDARY_CLASS}>
                Keep
              </button>
            </div>
          </div>
        ) : null}
      </SelectionSurface>
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
    <div className="mt-8 rounded-lg border border-[#ffc285]/30 bg-[#ffc285]/[0.04] p-4" data-testid="native-test-hook">
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
        className="mt-3 min-h-12 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3.5 text-base text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={() => void enqueue()} className={ACTION_PRIMARY_CLASS}>
          Enqueue download
        </button>
        <button type="button" onClick={() => void playLocal()} className={ACTION_SECONDARY_CLASS}>
          Play local
        </button>
      </div>
      {status ? <p className="mt-3 text-xs text-white/70" role="status">{status}</p> : null}
    </div>
  );
}
