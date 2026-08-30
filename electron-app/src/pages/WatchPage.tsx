import { useEffect, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';

const POLL_INTERVAL_MS = 500;

export default function WatchPage({
  navigate,
  params,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
  params: Record<string, string>;
}) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [starting, setStarting] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const api = window.electronAPI;
    const finalUrl = params.streamUrl || params.magnet;
    if (!finalUrl) {
      setStarting(false);
      setError('This playback link does not include a stream or torrent source.');
      return;
    }
    if (!api) {
      setStarting(false);
      setError('The Electron playback bridge is unavailable. Restart TorWatch and try again.');
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    let pollInFlight = false;
    let startedPlayback = false;

    const pollState = async () => {
      if (cancelled || pollInFlight || document.hidden) return;
      pollInFlight = true;
      try {
        const result = await api.getMpvState();
        if (cancelled) return;
        if (!result.ok || !result.state) {
          if (result.error) setError(result.error);
          return;
        }
        setTime(Number.isFinite(result.state.time) ? Math.max(0, result.state.time) : 0);
        setDuration(Number.isFinite(result.state.duration) ? Math.max(0, result.state.duration) : 0);
        setPaused(Boolean(result.state.paused));
      } catch (pollError) {
        if (!cancelled) {
          console.error('[WatchPage] Could not read playback state:', pollError);
          setError('Playback state could not be updated. The video may still be playing.');
        }
      } finally {
        pollInFlight = false;
      }
    };

    const startPlayback = async () => {
      setStarting(true);
      setError(null);
      try {
        const result = await api.playInMpv({
          url: finalUrl,
          magnet: params.magnet,
          title: params.title || 'Playing',
          cat: params.cat || 'movie',
          fileIndex: params.fileIndex ? Number(params.fileIndex) : 0,
          season: params.season !== undefined ? Number(params.season) : undefined,
          episode: params.episode !== undefined ? Number(params.episode) : undefined,
        });
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error || 'The player could not start.');

        startedPlayback = true;
        setPaused(false);
        await pollState();
        if (!cancelled) intervalId = window.setInterval(() => void pollState(), POLL_INTERVAL_MS);
      } catch (startError) {
        if (cancelled) return;
        console.error('[WatchPage] Playback failed:', startError);
        setError(startError instanceof Error ? startError.message : 'Playback could not be started.');
      } finally {
        if (!cancelled) setStarting(false);
      }
    };

    void startPlayback();
    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
      if (startedPlayback) {
        void api.stopMpv().catch((stopError) => {
          console.error('[WatchPage] Could not stop MPV during cleanup:', stopError);
        });
      }
    };
  }, [params, retryToken]);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const sec = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const togglePause = async () => {
    const api = window.electronAPI;
    if (!api || actionBusy) return;
    const nextPaused = !paused;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api.pauseMpv(nextPaused);
      if (!result.ok) throw new Error(result.error || 'Playback could not be updated.');
      setPaused(nextPaused);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Playback could not be updated.');
    } finally {
      setActionBusy(false);
    }
  };

  const stopPlayback = async () => {
    const api = window.electronAPI;
    if (actionBusy) return;
    setActionBusy(true);
    try {
      if (api) {
        const result = await api.stopMpv();
        if (!result.ok) throw new Error(result.error || 'The player could not be stopped.');
      }
      navigate('home');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The player could not be stopped.');
      setActionBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black px-6">
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-xl text-center text-white">
          <p className="font-label text-white/65">{starting ? 'Preparing playback' : 'Now playing'}</p>
          <h1 className="type-section-title mt-4 break-words text-white">
            {params.title || 'Playing'}
          </h1>

          {error ? (
            <div className="type-body measure-compact mt-6 rounded-lg border border-red-300/20 bg-red-950/30 px-5 py-4 text-red-100" role="alert">
              <p>{error}</p>
              {!starting ? (
                <button
                  type="button"
                  onClick={() => setRetryToken((token) => token + 1)}
                  className="mt-4 min-h-11 rounded-full border border-red-100/25 px-4 py-2 text-sm text-red-50 transition hover:border-red-100/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-100/70"
                >
                  Try playback again
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-7 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={starting || actionBusy || Boolean(error)}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={paused ? 'Resume playback' : 'Pause playback'}
            >
              {paused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={() => void stopPlayback()}
              disabled={actionBusy}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-wait disabled:opacity-45"
              aria-label="Stop playback and return home"
            >
              <Square className="h-5 w-5" />
            </button>
          </div>

          <p className="text-numeric mt-5 font-mono text-base text-white/75">
            {formatTime(time)} / {formatTime(duration)}
          </p>
          <button
            type="button"
            onClick={() => navigate('home')}
            className="mt-8 min-h-11 rounded-full border border-white/20 px-6 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Back to browse
          </button>
        </div>
      </div>
    </div>
  );
}
