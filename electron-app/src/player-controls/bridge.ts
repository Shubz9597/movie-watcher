import type { PlayerBridge, PlayerState } from './types';

declare global {
  interface Window {
    __playerPreviewInvocations?: Array<{ channel: string; args: unknown[] }>;
    playerAPI?: PlayerBridge;
    renderPlaybackIdentity?: (identity: unknown) => void;
  }
}

const previewAspectLabels = ['Fill', 'Fit', '16:9', '4:3', 'Cinema 2.35:1', 'Zoomed fill'];

function createPreviewBridge(): PlayerBridge {
  let clock = 0;
  let pollCount = 0;
  let fullscreen = false;
  let aspectIndex = 0;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  window.__playerPreviewInvocations = [];

  const emit = (channel: string, ...args: unknown[]) => {
    listeners.get(channel)?.forEach((listener) => listener(...args));
  };

  setTimeout(() => {
    emit('mpv:identity', {
      title: 'The Last Horizon',
      kind: 'episode',
      season: 1,
      episode: 7,
      episodeCode: 'S01E07',
      episodeLabel: 'Season 1, Episode 7',
      year: 2026,
      posterUrl: null,
    });
    emit('mpv:skipSegments', [{ type: 'intro', start: 0, end: 20 }]);
    emit('mpv:loadingState', { status: 'buffering', percentage: 72 });
    emit('mpv:playbackLoaded');
    emit('mpv:subtitleTracks', new URLSearchParams(location.search).get('subtitles') === 'missing'
      ? { status: 'error', source: 'opensub', tracks: [], providerConfigured: false, message: 'OpenSubtitles is not configured.' }
      : {
          status: 'ready',
          source: 'opensub',
          providerConfigured: true,
          tracks: [
            { source: 'opensub', lang: 'en', fileName: 'Movie.2026.WEBRip.AMZN.srt', format: 'srt', downloadCount: 18432, trusted: true, movieHashMatched: true, url: 'http://localhost:4001/subtitles/external?source=opensub&id=1&lang=en' },
            { source: 'opensub', lang: 'en', fileName: 'Movie.2026.BluRay.x264.HI.srt', format: 'srt', downloadCount: 7821, hearingImpaired: true, url: 'http://localhost:4001/subtitles/external?source=opensub&id=2&lang=en' },
            { source: 'opensub', lang: 'en', fileName: 'Movie.2026.WEB-DL.NTb.srt', format: 'srt', downloadCount: 3190, url: 'http://localhost:4001/subtitles/external?source=opensub&id=3&lang=en' },
          ],
        });
  }, 80);

  return {
    async invoke<T>(channel: string, ...args: unknown[]) {
      window.__playerPreviewInvocations?.push({ channel, args });
      if (channel === 'mpv:state') {
        pollCount += 1;
        clock += 0.25;
        const stalled = new URLSearchParams(location.search).get('preview') === 'stall' && pollCount > 4;
        return {
          ok: true,
          state: {
            time: stalled ? 2 : clock,
            duration: 120,
            paused: false,
            volume: 0.82,
            mute: false,
            buffering: stalled,
            audioDelay: 0,
            subtitleDelay: 0,
          } satisfies PlayerState,
        } as T;
      }
      if (channel === 'window:toggleFullscreen') {
        fullscreen = !fullscreen;
        emit('mpv:fullscreen', fullscreen);
        return { ok: true, fullscreen } as T;
      }
      if (channel === 'mpv:cycleAspect') {
        aspectIndex = (aspectIndex + 1) % previewAspectLabels.length;
        return { ok: true, label: previewAspectLabels[aspectIndex] } as T;
      }
      if (channel === 'mpv:loadSub') return { ok: true } as T;
      return { ok: true } as T;
    },
    send(channel: string, ...args: unknown[]) {
      window.__playerPreviewInvocations?.push({ channel, args });
    },
    on(channel: string, callback: (...args: unknown[]) => void) {
      const channelListeners = listeners.get(channel) ?? new Set<(...args: unknown[]) => void>();
      channelListeners.add(callback);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(callback);
    },
  };
}

function createElectronBridge(): PlayerBridge {
  if (window.playerAPI) return window.playerAPI;
  return {
    invoke: async () => {
      throw new Error('The secure player bridge is unavailable. Restart TorWatch.');
    },
    send: () => {},
    on: () => () => {},
  };
}

export function createPlayerBridge(): PlayerBridge {
  const previewMode = new URLSearchParams(location.search).has('preview');
  return previewMode ? createPreviewBridge() : createElectronBridge();
}
