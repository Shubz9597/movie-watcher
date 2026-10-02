import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { usePlatform } from '../platform/PlatformProvider.tsx';
import { ACTION_PRIMARY_CLASS, ACTION_SECONDARY_CLASS } from '../lib/design-tokens.ts';
import { SUBTITLE_LANGUAGES } from '../lib/subtitle-languages.ts';
import { SelectionSurface } from './primitives';
import {
  loadDownloadOptions,
  nativeDownloadsSupported,
  queueNativeDownload,
  type DownloadOptions,
  type DownloadSelection,
} from '../mobile/download-queue.ts';

const SUBTITLE_PREFERENCE_KEY = 'mw_download_subtitle_lang';

function readSubtitlePreference(): string {
  try {
    return localStorage.getItem(SUBTITLE_PREFERENCE_KEY) ?? 'en';
  } catch {
    return 'en';
  }
}

function saveSubtitlePreference(lang: string): void {
  try {
    localStorage.setItem(SUBTITLE_PREFERENCE_KEY, lang);
  } catch {
    // A preference that cannot persist only resets to English next time.
  }
}

function formatSize(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Download entry (WF04): opens a sheet that discloses size and free space,
// offers subtitle languages when the server can package them, and starts ONE
// job. Dismissing the sheet after starting never cancels the download.
export function NativeDownloadButton({
  selection,
  details,
  batch,
  onError,
  className = '',
}: {
  selection: DownloadSelection | (() => Promise<DownloadSelection>);
  /** Shown in the sheet before a lazy selection resolves. */
  details?: { title?: string; label?: string; sizeBytes?: number };
  /** Batch torrents: also queue the following episodes from the same pack. */
  batch?: { maxExtra: number; selections: (extra: number) => Promise<DownloadSelection[]> };
  onError?: (message: string) => void;
  className?: string;
}) {
  const { connection } = usePlatform();
  const [state, setState] = useState<'idle' | 'starting' | 'queued'>('idle');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DownloadOptions | null>(null);
  const [subtitleLang, setSubtitleLang] = useState(readSubtitlePreference);
  const [error, setError] = useState<string | null>(null);
  const [extraEpisodes, setExtraEpisodes] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  if (!nativeDownloadsSupported()) return null;

  const eager = typeof selection === 'function' ? null : selection;
  const label = details?.label ?? eager?.subtitleLabel;
  const sizeBytes = details?.sizeBytes ?? eager?.sizeBytes;
  const size = formatSize(sizeBytes);
  const free = formatSize(options?.freeBytes);
  const insufficient = Boolean(sizeBytes && options?.freeBytes != null && options.freeBytes < sizeBytes);

  const openSheet = (): void => {
    if (state !== 'idle') return;
    setError(null);
    setOpen(true);
    void loadDownloadOptions(connection).then(setOptions);
  };

  const maxExtra = batch?.maxExtra ?? 0;
  const episodeOptions = Array.from(new Set([0, Math.min(2, maxExtra), Math.min(4, maxExtra), maxExtra]))
    .filter((extra) => extra >= 0 && extra <= maxExtra);
  const episodeLabel = (extra: number): string => {
    if (extra === 0) return 'This episode';
    if (extra === maxExtra && maxExtra > 4) return `Rest of season (${extra + 1} episodes)`;
    return `This + next ${extra}`;
  };

  const start = async (): Promise<void> => {
    if (state !== 'idle') return;
    setState('starting');
    setError(null);
    try {
      const subtitles = options?.subtitlesSupported && subtitleLang ? [subtitleLang] : [];
      let selections: DownloadSelection[];
      if (batch && extraEpisodes > 0) {
        setProgress('Finding episodes in this batch…');
        selections = await batch.selections(extraEpisodes);
      } else {
        selections = [typeof selection === 'function' ? await selection() : selection];
      }
      // Queue one job per episode; episodes already in Downloads are skipped.
      let queued = 0;
      let firstError: unknown = null;
      for (const [index, item] of selections.entries()) {
        if (selections.length > 1) setProgress(`Adding ${index + 1} of ${selections.length}…`);
        try {
          await queueNativeDownload({ ...item, subtitles }, connection);
          queued += 1;
        } catch (itemError) {
          const message = itemError instanceof Error ? itemError.message : '';
          if (!/already in Downloads/i.test(message)) firstError ??= itemError;
        }
      }
      setProgress(null);
      if (queued === 0 && firstError) throw firstError;
      if (queued === 0) throw new Error('These episodes are already in Downloads.');
      if (options?.subtitlesSupported) saveSubtitlePreference(subtitleLang);
      setQueuedCount(queued);
      setState('queued');
      setOpen(false);
    } catch (err) {
      setProgress(null);
      const message = err instanceof Error ? err.message : 'Couldn’t start the download.';
      setState('idle');
      setError(message);
      onError?.(message);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        disabled={state !== 'idle'}
        aria-haspopup="dialog"
        className={`${ACTION_SECONDARY_CLASS} px-4 ${className}`}
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {state === 'queued' ? (queuedCount > 1 ? `Queued ${queuedCount}` : 'Queued') : 'Download'}
      </button>
      <SelectionSurface open={open} title="Download" onClose={() => { if (state !== 'starting') setOpen(false); }}>
        <div className="pb-1">
          <p className="type-body truncate text-white">{details?.title ?? eager?.title ?? 'This source'}{label ? ` · ${label}` : ''}</p>
          <p className="type-secondary text-numeric mt-1 text-white/70">
            {[size ?? 'Size unknown', free ? `${free} free` : null].filter(Boolean).join(' · ')}
          </p>
          {insufficient ? <p className="type-secondary mt-2 text-red-300" role="alert">Not enough storage on this device.</p> : null}

          {batch && maxExtra > 0 ? (
            <label className="mt-5 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-white">Episodes</span>
              <select
                value={extraEpisodes}
                onChange={(event) => setExtraEpisodes(Number(event.target.value))}
                className="min-h-12 rounded-lg border border-white/15 bg-black px-3 text-base text-white"
              >
                {episodeOptions.map((extra) => <option key={extra} value={extra}>{episodeLabel(extra)}</option>)}
              </select>
            </label>
          ) : null}

          {options?.subtitlesSupported ? (
            <label className="mt-5 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-white">Subtitles</span>
              <select
                value={subtitleLang}
                onChange={(event) => setSubtitleLang(event.target.value)}
                className="min-h-12 rounded-lg border border-white/15 bg-black px-3 text-base text-white"
              >
                <option value="">Off</option>
                {SUBTITLE_LANGUAGES.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
          ) : null}

          {progress ? <p className="type-secondary mt-3 text-white/70" role="status">{progress}</p> : null}
          {error ? <p className="type-secondary mt-3 text-red-300" role="alert">{error}</p> : null}
          <button
            type="button"
            onClick={() => void start()}
            disabled={state !== 'idle' || options === null || insufficient}
            className={`mt-5 w-full ${ACTION_PRIMARY_CLASS}`}
          >
            {state === 'starting' || options === null
              ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              : <Download className="h-4 w-4" aria-hidden="true" />}
            {state === 'starting' ? 'Starting…' : 'Download'}
          </button>
        </div>
      </SelectionSurface>
    </>
  );
}
