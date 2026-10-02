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
  onError,
  className = '',
}: {
  selection: DownloadSelection | (() => Promise<DownloadSelection>);
  /** Shown in the sheet before a lazy selection resolves. */
  details?: { title?: string; label?: string; sizeBytes?: number };
  onError?: (message: string) => void;
  className?: string;
}) {
  const { connection } = usePlatform();
  const [state, setState] = useState<'idle' | 'starting' | 'queued'>('idle');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DownloadOptions | null>(null);
  const [subtitleLang, setSubtitleLang] = useState(readSubtitlePreference);
  const [error, setError] = useState<string | null>(null);

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

  const start = async (): Promise<void> => {
    if (state !== 'idle') return;
    setState('starting');
    setError(null);
    try {
      const resolved = typeof selection === 'function' ? await selection() : selection;
      const subtitles = options?.subtitlesSupported && subtitleLang ? [subtitleLang] : [];
      await queueNativeDownload({ ...resolved, subtitles }, connection);
      if (options?.subtitlesSupported) saveSubtitlePreference(subtitleLang);
      setState('queued');
      setOpen(false);
    } catch (err) {
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
        {state === 'queued' ? 'Queued' : 'Download'}
      </button>
      <SelectionSurface open={open} title="Download" onClose={() => { if (state !== 'starting') setOpen(false); }}>
        <div className="pb-1">
          <p className="type-body truncate text-white">{details?.title ?? eager?.title ?? 'This source'}{label ? ` · ${label}` : ''}</p>
          <p className="type-secondary text-numeric mt-1 text-white/70">
            {[size ?? 'Size unknown', free ? `${free} free` : null].filter(Boolean).join(' · ')}
          </p>
          {insufficient ? <p className="type-secondary mt-2 text-red-300" role="alert">Not enough storage on this device.</p> : null}

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
