import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { usePlatform } from '../platform/PlatformProvider.tsx';
import { FOCUS_RING_CLASS } from '../lib/design-tokens.ts';
import {
  nativeDownloadsSupported,
  queueNativeDownload,
  type DownloadSelection,
} from '../mobile/download-queue.ts';

export function NativeDownloadButton({
  selection,
  onError,
  className = '',
}: {
  selection: DownloadSelection | (() => Promise<DownloadSelection>);
  onError?: (message: string) => void;
  className?: string;
}) {
  const { connection } = usePlatform();
  const [state, setState] = useState<'idle' | 'starting' | 'queued'>('idle');

  if (!nativeDownloadsSupported()) return null;

  const start = async (): Promise<void> => {
    if (state !== 'idle') return;
    setState('starting');
    try {
      const resolvedSelection = typeof selection === 'function' ? await selection() : selection;
      await queueNativeDownload(resolvedSelection, connection);
      setState('queued');
    } catch (error) {
      setState('idle');
      onError?.(error instanceof Error ? error.message : 'Could not start the download.');
    }
  };

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={state !== 'idle'}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/20 px-4 text-sm text-white/90 transition hover:border-white/40 hover:bg-white/[0.05] disabled:opacity-60 ${FOCUS_RING_CLASS} ${className}`}
    >
      {state === 'starting' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-4 w-4" aria-hidden="true" />
      )}
      {state === 'starting' ? 'Starting…' : state === 'queued' ? 'Queued' : 'Download'}
    </button>
  );
}
