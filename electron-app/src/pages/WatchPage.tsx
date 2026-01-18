import { useEffect, useState } from 'react';

export default function WatchPage({
  navigate,
  params,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
  params: Record<string, string>;
}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    async function startPlayback() {
      const { magnet, streamUrl, title } = params;
      const url = streamUrl || magnet;
      if (!url) return;

      try {
        const ready = await window.electronAPI.isMpvReady();
        if (!ready.ready) {
          alert('MPV player is not ready');
          return;
        }

        // Use magnet URI directly - main process will resolve to stream URL
        const finalUrl = streamUrl || magnet;
        if (!finalUrl) {
          alert('No magnet or stream URL provided');
          return;
        }

        const result = await window.electronAPI.playInMpv({
          url: finalUrl,
          title: title || 'Playing',
          cat: params.cat || 'movie',
          fileIndex: params.fileIndex ? Number(params.fileIndex) : 0,
        });

        if (result.ok) {
          setPlaying(true);
          // Start polling state
          const interval = setInterval(async () => {
            const state = await window.electronAPI.getMpvState();
            if (state.ok && state.state) {
              setTime(state.state.time || 0);
              setDuration(state.state.duration || 0);
            }
          }, 500);
          return () => clearInterval(interval);
        } else {
          alert(`Failed to play: ${result.error}`);
        }
      } catch (err) {
        console.error('Playback failed:', err);
        alert('Failed to start playback: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    startPlayback();
  }, [params]);

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const sec = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-black">
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center text-white">
          <h2 className="text-2xl font-semibold mb-2">{params.title || 'Playing'}</h2>
          <p className="text-slate-400 mb-4">Playing in MPV player</p>
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={async () => {
                const state = await window.electronAPI.getMpvState();
                if (state.ok && state.state) {
                  await window.electronAPI.pauseMpv(!state.state.paused);
                }
              }}
              className="rounded-full bg-white/20 p-4 hover:bg-white/30"
            >
              ⏸
            </button>
            <button
              onClick={async () => {
                await window.electronAPI.stopMpv();
                navigate('home');
              }}
              className="rounded-full bg-white/20 p-4 hover:bg-white/30"
            >
              ⏹
            </button>
          </div>
          <div className="mt-4 text-lg font-mono">{formatTime(time)} / {formatTime(duration)}</div>
          <button
            onClick={() => navigate('home')}
            className="mt-8 rounded-full bg-white/20 px-6 py-2 text-white hover:bg-white/30"
          >
            Back to browse
          </button>
        </div>
      </div>
    </div>
  );
}



