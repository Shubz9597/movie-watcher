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

/** A season pack's episode range: any released episode, first..last. */
export type BatchRange = {
  first: number;
  last: number;
  current: number;
  selections: (from: number, to: number) => Promise<{ selections: DownloadSelection[]; missing: number[] }>;
};

// "E3, E7–E9" for the episodes a pack lacks.
function episodeList(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `E${sorted[i]}–E${sorted[j]}` : `E${sorted[i]}`);
    i = j;
  }
  return parts.join(', ');
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
  /** Batch torrents: queue a range of episodes from the same pack. */
  batch?: BatchRange | null;
  onError?: (message: string) => void;
  className?: string;
}) {
  const { connection } = usePlatform();
  const [state, setState] = useState<'idle' | 'starting' | 'queued'>('idle');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DownloadOptions | null>(null);
  const [subtitleLang, setSubtitleLang] = useState(readSubtitlePreference);
  const [error, setError] = useState<string | null>(null);
  // Kept as typed text so a box can be cleared while editing.
  const [rangeFrom, setRangeFrom] = useState(String(batch?.current ?? ''));
  const [rangeTo, setRangeTo] = useState(String(batch?.current ?? ''));
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);
    if (batch) {
      setRangeFrom(String(batch.current));
      setRangeTo(String(batch.current));
    }
    setOpen(true);
    void loadDownloadOptions(connection).then(setOptions);
  };

  const from = Number.parseInt(rangeFrom, 10);
  const to = Number.parseInt(rangeTo, 10);
  const rangeError = !batch
    ? null
    : !Number.isFinite(from) || !Number.isFinite(to)
      ? 'Enter both episode numbers.'
      : from < batch.first || to > batch.last
        ? `Episodes ${batch.first}–${batch.last} are available.`
        : from > to
          ? '“From” must not be after “To”.'
          : null;
  const isRange = Boolean(batch && !rangeError && !(from === batch.current && to === batch.current));

  const start = async (): Promise<void> => {
    if (state !== 'idle') return;
    setState('starting');
    setError(null);
    try {
      const subtitles = options?.subtitlesSupported && subtitleLang ? [subtitleLang] : [];
      let selections: DownloadSelection[];
      let missing: number[] = [];
      if (batch && isRange) {
        setProgress('Finding episodes in this batch…');
        ({ selections, missing } = await batch.selections(from, to));
        if (selections.length === 0) throw new Error(`This batch doesn’t include E${from}–E${to}.`);
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
      // Leave the sheet open to say which episodes the pack lacks.
      if (missing.length > 0) setNotice(`Queued ${queued}. Not in this batch: ${episodeList(missing)}.`);
      else setOpen(false);
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

          {batch ? (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-white">Episodes</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label="From episode"
                    min={batch.first}
                    max={batch.last}
                    value={rangeFrom}
                    onChange={(event) => setRangeFrom(event.target.value)}
                    className="min-h-12 w-20 rounded-lg border border-white/15 bg-black px-3 text-center text-base text-white"
                  />
                  <span className="text-sm text-white/70">to</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label="To episode"
                    min={batch.first}
                    max={batch.last}
                    value={rangeTo}
                    onChange={(event) => setRangeTo(event.target.value)}
                    className="min-h-12 w-20 rounded-lg border border-white/15 bg-black px-3 text-center text-base text-white"
                  />
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className={`type-secondary ${rangeError ? 'text-red-300' : 'text-white/70'}`}>
                  {rangeError ?? (from === to ? `Episode ${from}` : `${to - from + 1} episodes`)}
                </p>
                <button
                  type="button"
                  onClick={() => setRangeTo(String(batch.last))}
                  className="min-h-11 px-2 text-sm font-medium text-white/85 underline-offset-4 hover:underline"
                >
                  To last ({batch.last})
                </button>
              </div>
            </div>
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
          {notice ? <p className="type-secondary mt-3 text-white/85" role="status">{notice}</p> : null}
          {error ? <p className="type-secondary mt-3 text-red-300" role="alert">{error}</p> : null}
          <button
            type="button"
            onClick={() => void start()}
            disabled={state !== 'idle' || options === null || insufficient || Boolean(rangeError)}
            className={`mt-5 w-full ${ACTION_PRIMARY_CLASS}`}
          >
            {state === 'starting' || options === null
              ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              : <Download className="h-4 w-4" aria-hidden="true" />}
            {state === 'starting' ? 'Starting…' : state === 'queued' ? `Queued ${queuedCount}` : 'Download'}
          </button>
        </div>
      </SelectionSurface>
    </>
  );
}
