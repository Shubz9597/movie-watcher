// NativePlayerControls (M1.4.7): the shared web control surface rendered ON
// TOP of the VLC surface (which sits behind the WebView). One implementation
// for iOS and Android: loading screen, tap-to-toggle controls, seek bar,
// ±10s, play/pause, subtitle sheet (embedded + torrent + OpenSubtitles +
// local import + timing offset), audio sheet (embedded + timing offset), and
// the skip-intro chip when timestamps exist (server /skip-segments).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, Pause, Play, Captions, AudioLines, Timer, Upload, LoaderCircle } from 'lucide-react';
import { getVodBase } from '../lib/api-client';
import { useConnectionStatus } from '../platform/PlatformProvider';
import LoadingScreen from '../components/player/LoadingScreen';

export type NativeTrackInfo = { id: number; label?: string; language?: string };

export type NativePlayerControlsSurface = {
  seekTo(positionSec: number): void;
  seekBy(deltaSeconds: number): void;
  togglePlayback(): void;
  setSubtitleDelay(seconds: number): void;
  setAudioDelay(seconds: number): void;
  selectAudioTrack(trackId: number): void;
  selectSubtitleTrack(trackId: number | null): void;
  loadSubtitle(input: { url: string; label?: string; language?: string }): Promise<number | null>;
  subscribeTime(listener: (update: { currentTime: number; duration: number }) => void): () => void;
  subscribeState(listener: (state: 'playing' | 'paused') => void): () => void;
  subscribeTracks(listener: (update: {
    audio: NativeTrackInfo[];
    subtitles: NativeTrackInfo[];
    selectedAudioTrackId?: number | null; // authoritative player state
    selectedSubtitleTrackId?: number | null; // -1 = none
  }) => void): () => void;
  subscribeBuffering(listener: (update: { active: boolean; progress?: number }) => void): () => void;
};

type SkipSegment = { type: string; start: number; end: number; provider: string };

type CatalogSubtitleTrack = {
  source: string; // 'torrent' | 'opensub'
  lang: string;
  label: string;
  url: string; // server-relative or absolute
  fileName: string;
  format?: string;
  downloadCount?: number;
  trusted?: boolean;
  hearingImpaired?: boolean;
  movieHashMatched?: boolean;
};

type Props = {
  player: NativePlayerControlsSurface;
  title: string;
  year?: number;
  posterUrl: string | null;
  magnet: string;
  cat: string;
  fileIndex: number | undefined;
  tmdbId: number | undefined;
  imdbId: string | undefined;
  malId: number | undefined;
  season: number;
  episode: number;
  absoluteEpisode: number | undefined;
  onClose: () => void;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function formatDelay(seconds: number): string {
  const sign = seconds > 0 ? '+' : '';
  return `${sign}${seconds.toFixed(1)}s`;
}

export default function NativePlayerControls(props: Props) {
  const { player, title, year, posterUrl, magnet, cat, fileIndex, tmdbId, imdbId, malId, season, episode, absoluteEpisode, onClose } = props;

  const [hasVideo, setHasVideo] = useState(false);
  const [buffering, setBuffering] = useState({ active: true, progress: 0 });
  const [time, setTime] = useState({ currentTime: 0, duration: 0 });
  const [playing, setPlaying] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activeSheet, setActiveSheet] = useState<'none' | 'subtitles' | 'audio' | 'sync'>('none');

  const [embeddedAudio, setEmbeddedAudio] = useState<NativeTrackInfo[]>([]);
  const [embeddedSubs, setEmbeddedSubs] = useState<NativeTrackInfo[]>([]);
  const [selectedEmbeddedSub, setSelectedEmbeddedSub] = useState<number | null>(null);
  const [selectedEmbeddedAudio, setSelectedEmbeddedAudio] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<CatalogSubtitleTrack[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogMessage, setCatalogMessage] = useState('');
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [subtitleDelay, setSubtitleDelayState] = useState(0);
  const [audioDelay, setAudioDelayState] = useState(0);
  const [skipSegments, setSkipSegments] = useState<SkipSegment[]>([]);
  const [importing, setImporting] = useState(false);
  const [loadingSubtitleUrl, setLoadingSubtitleUrl] = useState<string | null>(null);
  const [subtitleError, setSubtitleError] = useState('');
  const [language, setLanguage] = useState('en');
  const [scrubTo, setScrubTo] = useState<number | null>(null);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingApiKey, setSavingApiKey] = useState(false);
  const subtitleOperation = useRef(0);
  const controlsHideTimer = useRef<number | null>(null);
  // Double-tap seek zones: left third rewinds, right third advances.
  const lastTapRef = useRef<{ time: number; x: number } | null>(null);
  const singleTapTimer = useRef<number | null>(null);
  const activeSheetRef = useRef(activeSheet);
  activeSheetRef.current = activeSheet;
  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;

  const progress = time.duration > 0 ? ((scrubTo ?? time.currentTime) / time.duration) * 100 : 0;

  const commitScrub = useCallback(() => {
    setScrubTo((target) => {
      if (target != null) player.seekTo(target);
      return null;
    });
  }, [player]);

  // --- Live native events ---
  useEffect(() => {
    const detachTime = player.subscribeTime((update) => {
      setTime({ currentTime: update.currentTime, duration: update.duration });
    });
    const detachState = player.subscribeState((state) => {
      setPlaying(state === 'playing');
      if (state === 'playing') setHasVideo(true);
    });
    const detachBuffering = player.subscribeBuffering((update) => {
      setBuffering({ active: update.active, progress: Math.round(update.progress ?? 0) });
      if (!update.active) setHasVideo(true);
    });
    const detachTracks = player.subscribeTracks((update) => {
      setEmbeddedAudio(update.audio);
      setEmbeddedSubs(update.subtitles);
      // Authoritative selection state (optimistic echoes are overwritten by
      // the player's own report; -1 = none selected).
      if (update.selectedAudioTrackId != null) {
        setSelectedEmbeddedAudio(update.selectedAudioTrackId);
      } else {
        // Auto-select the first embedded audio track (VLC usually does this).
        setSelectedEmbeddedAudio((current) => current ?? update.audio[0]?.id ?? null);
      }
      setSelectedEmbeddedSub(
        update.selectedSubtitleTrackId != null && update.selectedSubtitleTrackId !== -1
          ? update.selectedSubtitleTrackId
          : null,
      );
    });
    return () => {
      detachTime();
      detachState();
      detachBuffering();
      detachTracks();
    };
  }, [player]);

  // --- Skip segments (where timestamps exist) ---
  useEffect(() => {
    const duration = time.duration;
    if (!duration || duration <= 0) return;
    if (skipSegments.length > 0) return;
    let cancelled = false;
    const params = new URLSearchParams({ kind: cat === 'anime' ? 'anime' : 'tv' });
    if (cat === 'anime') {
      if (malId) params.set('malId', String(malId));
      params.set('episode', String(absoluteEpisode ?? episode));
    } else {
      if (tmdbId) params.set('tmdbId', String(tmdbId));
      if (imdbId) params.set('imdbId', imdbId);
      params.set('season', String(season));
      params.set('episode', String(episode));
    }
    params.set('durationSeconds', String(Math.round(duration)));
    fetch(`${getVodBase()}/skip-segments?${params.toString()}`, { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : { segments: [] }))
      .then((data: { segments?: SkipSegment[] }) => {
        if (!cancelled) setSkipSegments(Array.isArray(data?.segments) ? data.segments : []);
      })
      .catch(() => {
        // Skip support is best-effort: no timestamps → no chip.
        if (!cancelled) setSkipSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [time.duration, skipSegments.length, cat, tmdbId, imdbId, malId, season, episode, absoluteEpisode]);

  const activeSkipSegment = useMemo(() => {
    return skipSegments.find((segment) => time.currentTime >= segment.start && time.currentTime <= segment.end && segment.type === 'intro') ?? null;
  }, [skipSegments, time.currentTime]);

  // --- Subtitle catalog (server /subtitles/list) ---
  useEffect(() => {
    if (activeSheet !== 'subtitles' || catalogStatus !== 'loading') return;
    let cancelled = false;
    const params = new URLSearchParams({ cat, magnet, langs: language, title });
    if (year) params.set('year', String(year));
    if (fileIndex != null) params.set('fileIndex', String(fileIndex));
    if (imdbId) params.set('imdbId', imdbId);
    if (tmdbId) params.set('tmdbId', String(tmdbId));
    params.set('season', String(season));
    params.set('episode', String(episode));
    fetch(`${getVodBase()}/subtitles/list?${params.toString()}`, { signal: AbortSignal.timeout(20000) })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: { tracks?: CatalogSubtitleTrack[]; message?: string; providerConfigured?: boolean }) => {
        if (cancelled) return;
        setCatalog(Array.isArray(data?.tracks) ? data.tracks : []);
        setCatalogMessage(data?.message ?? '');
        setProviderConfigured(data?.providerConfigured !== false);
        setCatalogStatus('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogMessage(`Subtitles could not be listed (${error instanceof Error ? error.message : 'network error'}).`);
        setCatalogStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [activeSheet, catalogStatus, magnet, cat, fileIndex, imdbId, tmdbId, season, episode, language, title, year]);

  // --- Controls auto-hide ---
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsHideTimer.current !== null) window.clearTimeout(controlsHideTimer.current);
    controlsHideTimer.current = window.setTimeout(() => {
      if (activeSheet === 'none') setControlsVisible(false);
    }, 4000);
  }, [activeSheet]);
  useEffect(() => () => {
    if (controlsHideTimer.current !== null) window.clearTimeout(controlsHideTimer.current);
    subtitleOperation.current++;
  }, []);

  const toggleControls = useCallback(() => {
    if (activeSheetRef.current !== 'none') {
      setActiveSheet('none');
      return;
    }
    if (controlsVisibleRef.current) {
      setControlsVisible(false);
    } else {
      revealControls();
    }
  }, [revealControls]);

  /**
   * Tap language (M1.4.7 device pass):
   *  - single tap anywhere: toggle the control chrome
   *  - double tap LEFT third: rewind 10s · RIGHT third: advance 10s
   *    (on-screen ±10s buttons were removed in favor of this)
   */
  const handleSurfaceTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = event.clientX;
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.time < 320) {
      lastTapRef.current = null;
      if (singleTapTimer.current !== null) {
        window.clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
      }
      const width = window.innerWidth;
      if (x < width * 0.4) player.seekBy(-10);
      else if (x > width * 0.6) player.seekBy(10);
      return;
    }
    lastTapRef.current = { time: now, x };
    if (singleTapTimer.current !== null) window.clearTimeout(singleTapTimer.current);
    singleTapTimer.current = window.setTimeout(() => {
      singleTapTimer.current = null;
      toggleControls();
    }, 280);
  };
  useEffect(() => () => {
    if (singleTapTimer.current !== null) window.clearTimeout(singleTapTimer.current);
  }, []);

  const chooseCatalogSubtitle = async (track: CatalogSubtitleTrack) => {
    if (loadingSubtitleUrl || importing) return;
    const operation = ++subtitleOperation.current;
    const url = track.url.startsWith('http') ? track.url : `${getVodBase()}${track.url}`;
    setLoadingSubtitleUrl(track.url);
    setSubtitleError('');
    try {
      await player.loadSubtitle({ url, label: track.label || track.fileName, language: track.lang });
      if (operation !== subtitleOperation.current) return;
      setActiveSubtitleUrl(track.url);
      setSelectedEmbeddedSub(null);
    } catch {
      if (operation === subtitleOperation.current) setSubtitleError('The subtitle could not be loaded. Try again or choose another file.');
    } finally {
      if (operation === subtitleOperation.current) setLoadingSubtitleUrl(null);
    }
  };

  const chooseEmbeddedSubtitle = (track: NativeTrackInfo) => {
    player.selectSubtitleTrack(track.id);
    setSelectedEmbeddedSub(track.id);
    setActiveSubtitleUrl(null);
  };

  const disableSubtitles = () => {
    player.selectSubtitleTrack(null);
    setSelectedEmbeddedSub(null);
    setActiveSubtitleUrl(null);
  };

  const chooseEmbeddedAudio = (track: NativeTrackInfo) => {
    player.selectAudioTrack(track.id);
    setSelectedEmbeddedAudio(track.id);
  };

  const importLocalSubtitle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (loadingSubtitleUrl || importing) return;
    if (file.size > 4 * 1024 * 1024 || file.size === 0) {
      setSubtitleError('Choose a non-empty subtitle file up to 4 MiB.');
      return;
    }
    setImporting(true);
    setSubtitleError('');
    const operation = ++subtitleOperation.current;
    const origin = getVodBase();
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`${origin}/subtitles/import`, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('The subtitle could not be imported. Check the file and try again.');
      const data = (await res.json()) as { url?: string; fileName?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? 'The subtitle could not be imported.');
      }
      if (operation !== subtitleOperation.current || origin !== getVodBase()) return;
      await player.loadSubtitle({ url: `${origin}${data.url}`, label: data.fileName ?? file.name });
      if (operation !== subtitleOperation.current) return;
      setActiveSubtitleUrl(data.url);
      setSelectedEmbeddedSub(null);
    } catch (error) {
      if (operation === subtitleOperation.current) setSubtitleError(error instanceof Error ? error.message : 'The subtitle could not be imported.');
    } finally {
      setImporting(false);
    }
  };

  const adjustDelay = (kind: 'subtitle' | 'audio', value: number) => {
    const clamped = Math.max(-30, Math.min(30, Math.round(value * 10) / 10));
    if (kind === 'subtitle') {
      setSubtitleDelayState(clamped);
      player.setSubtitleDelay(clamped);
    } else {
      setAudioDelayState(clamped);
      player.setAudioDelay(clamped);
    }
  };

  const submitImport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  /** Connect an OpenSubtitles API key (server-side credential, like desktop). */
  const connectOpenSubtitles = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const credential = apiKeyInput.trim();
    if (!credential) {
      setSubtitleError('Enter your OpenSubtitles API key.');
      return;
    }
    setSavingApiKey(true);
    setSubtitleError('');
    try {
      const res = await fetch(`${getVodBase()}/subtitles/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: credential }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('OpenSubtitles could not be connected.');
      setApiKeyInput('');
      setProviderConfigured(true);
      setCatalogStatus('loading'); // re-search with the new credential
    } catch (error) {
      setSubtitleError(error instanceof Error ? error.message : 'OpenSubtitles could not be connected.');
    } finally {
      setSavingApiKey(false);
    }
  };

  if (!hasVideo) {
    return (
      <>
      <LoadingScreen
        title={title}
        year={year}
        posterUrl={posterUrl}
        bufferPercentage={buffering.active ? Math.max(buffering.progress, 4) : 96}
        status={buffering.active ? 'buffering' : 'connecting'}
      />
      <button type="button" onClick={onClose} className="fixed left-[max(1rem,env(safe-area-inset-left))] top-[max(1rem,env(safe-area-inset-top))] z-[70] min-h-11 rounded-full border border-white/30 bg-black/70 px-5 text-white">
        Close player
      </button>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] select-none bg-transparent" onPointerUp={handleSurfaceTap}>
      {buffering.active ? <BufferingLoader title={title} posterUrl={posterUrl} progress={buffering.progress} /> : null}
      {/* Top bar — safe-area aware so the close button never sits under the
          Dynamic Island / notch in either orientation. */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-start justify-between pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] transition-opacity duration-200 ${controlsVisible || activeSheet !== 'none' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close player"
          onClick={onClose}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </button>
        <div className="pointer-events-none max-w-[55%] truncate rounded-full bg-black/50 px-4 py-2 text-sm text-white/85 backdrop-blur">{title}</div>
        <div className="w-11" aria-hidden="true" />
      </div>

      {/* Skip-intro chip (where timestamps exist) */}
      {activeSkipSegment ? (
        <div className="absolute bottom-28 right-4 z-20">
          <button
            type="button"
            onPointerUp={(event) => {
              event.stopPropagation();
              player.seekTo(activeSkipSegment.end + 0.25);
            }}
            className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-semibold text-black shadow-lg transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Skip intro
          </button>
        </div>
      ) : null}

      {/* Bottom control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10 transition-opacity duration-200 ${controlsVisible || activeSheet !== 'none' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onPointerUp={(event) => event.stopPropagation()}
      >
        {/* Seek bar — dragging scrubs locally; ONE seek commits on release
            so a drag cannot flood the player (or, via heartbeats, the server). */}
        <div className="flex items-center gap-3">
          <span className="font-label text-numeric text-xs text-white/80">{formatTime(time.currentTime)}</span>
          <div className="relative h-6 flex-1">
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-white/20">
              <div className="h-full rounded-full bg-[#ff7a17]" style={{ width: `${progress}%` }} />
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(time.duration, 1)}
              step={1}
              value={Math.min(scrubTo ?? time.currentTime, time.duration || 0)}
              aria-label="Seek"
              aria-valuetext={formatTime(scrubTo ?? time.currentTime)}
              onChange={(event) => setScrubTo(Number(event.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={(event) => {
                // Keyboard scrubbing commits on arrow-release, not per tick.
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) commitScrub();
              }}
              className="absolute inset-0 w-full cursor-pointer opacity-0"
            />
          </div>
          <span className="font-label text-numeric text-xs text-white/80">-{formatTime(Math.max(0, time.duration - (scrubTo ?? time.currentTime)))}</span>
        </div>

        {/* Buttons — play/pause only; ±10s is double-tap on the video. */}
        <div className="mt-2 flex items-center justify-between">
          <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => player.togglePlayback()} accent>
            {playing ? <Pause className="h-7 w-7" aria-hidden="true" /> : <Play className="h-7 w-7" aria-hidden="true" />}
          </IconButton>
          <div className="flex items-center gap-1">
            <IconButton label="Subtitles" onClick={() => setActiveSheet(activeSheet === 'subtitles' ? 'none' : 'subtitles')} active={activeSheet === 'subtitles' || activeSubtitleUrl !== null || selectedEmbeddedSub !== null}>
              <Captions className="h-6 w-6" aria-hidden="true" />
            </IconButton>
            <IconButton label="Audio tracks" onClick={() => setActiveSheet(activeSheet === 'audio' ? 'none' : 'audio')} active={activeSheet === 'audio'}>
              <AudioLines className="h-6 w-6" aria-hidden="true" />
            </IconButton>
            <IconButton label="Timing sync" onClick={() => setActiveSheet(activeSheet === 'sync' ? 'none' : 'sync')} active={activeSheet === 'sync'}>
              <Timer className="h-6 w-6" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </div>

      {/* Sheets — right-side panel (~42% width), desktop-equivalent; keeps
          the video visible on the left and respects safe areas. */}
      {activeSheet === 'subtitles' ? (
        <Sheet title="Subtitles" onClose={() => setActiveSheet('none')}>
          {subtitleError ? <p role="alert" className="mb-3 text-sm text-red-200">{subtitleError}</p> : null}
          <fieldset disabled={!!loadingSubtitleUrl || importing} className="flex flex-wrap gap-2 disabled:opacity-60">
            <ChipButton active={activeSubtitleUrl === null && selectedEmbeddedSub === null} onClick={disableSubtitles}>Off</ChipButton>
            {embeddedSubs.map((track) => (
              <ChipButton key={track.id} active={selectedEmbeddedSub === track.id} onClick={() => chooseEmbeddedSubtitle(track)}>
                {track.label || `Track ${track.id}`}
              </ChipButton>
            ))}
          </fieldset>
          <div className="mt-4 border-t border-white/10 pt-3">
            <label className="flex items-center justify-between gap-3 text-sm text-white/80">
              Subtitle language
              <select aria-label="Subtitle language" value={language} onChange={(event) => { setLanguage(event.target.value); setCatalog([]); setCatalogStatus('loading'); }} className="min-h-11 rounded-lg border border-white/20 bg-black px-3 text-base text-white">
                {Object.entries({ en: 'English', hi: 'Hindi', ja: 'Japanese', es: 'Spanish', fr: 'French', de: 'German', ar: 'Arabic', pt: 'Portuguese', ta: 'Tamil', te: 'Telugu' }).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            {!providerConfigured ? (
              <form onSubmit={(event) => void connectOpenSubtitles(event)} className="mt-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
                <label htmlFor="mobileOpenSubtitlesKey" className="text-sm text-white/80">OpenSubtitles API key</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="mobileOpenSubtitlesKey"
                    type="password"
                    value={apiKeyInput}
                    autoComplete="new-password"
                    disabled={savingApiKey}
                    placeholder="Paste API key"
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-black px-3 text-base text-white"
                  />
                  <button type="submit" disabled={savingApiKey} className="min-h-11 rounded-lg bg-white px-4 text-sm text-black transition hover:bg-white/85">
                    {savingApiKey ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => window.open('https://www.opensubtitles.com/en/api-keys', '_blank', 'noopener')}
                  className="mt-2 text-xs text-white/60 underline"
                >
                  Get an API key
                </button>
              </form>
            ) : null}
            {catalogStatus === 'loading' ? <p className="mt-2 flex items-center gap-2 text-sm text-white/60" role="status"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Finding subtitles…</p> : null}
            {catalogStatus !== 'loading' && catalog.length === 0 ? (
              <p className="mt-2 text-sm text-white/60">{catalogMessage || 'No subtitle files were found for this language.'}</p>
            ) : null}
            {catalogStatus !== 'loading' ? <button type="button" onClick={() => setCatalogStatus('loading')} className="mt-2 min-h-11 text-sm text-white underline">Search again</button> : null}
            <div className="mt-2 space-y-1">
              {catalog.map((track) => (
                <button
                  key={track.url}
                  type="button"
                  onClick={() => void chooseCatalogSubtitle(track)}
                  disabled={!!loadingSubtitleUrl || importing}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${activeSubtitleUrl === track.url ? 'border-[#ff7a17]/60 bg-[#ff7a17]/10 text-white' : 'border-white/10 bg-white/[0.04] text-white/80 hover:border-white/25 hover:text-white'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{loadingSubtitleUrl === track.url ? 'Loading…' : track.fileName || track.label}</span>
                  <span className="shrink-0 text-xs text-white/50">
                    {track.source === 'torrent' ? 'Torrent' : 'OpenSubtitles'}
                    {track.movieHashMatched ? ' · hash match' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <form onSubmit={submitImport} className="mt-4 border-t border-white/10 pt-3">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white">
              <Upload className="h-4 w-4" aria-hidden="true" />
              {importing ? 'Importing…' : 'Import subtitle file'}
              <input type="file" accept=".srt,.vtt,.ass,.ssa" className="sr-only" onChange={(event) => void importLocalSubtitle(event)} disabled={importing || !!loadingSubtitleUrl} />
            </label>
            <p className="mt-2 text-xs text-white/45">SRT, VTT, ASS or SSA up to 4 MiB.</p>
          </form>
        </Sheet>
      ) : null}

      {activeSheet === 'audio' ? (
        <Sheet title="Audio" onClose={() => setActiveSheet('none')}>
          {embeddedAudio.length === 0 ? (
            <p className="text-sm text-white/60">No embedded audio tracks were reported for this file.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {embeddedAudio.map((track) => (
                <ChipButton key={track.id} active={selectedEmbeddedAudio === track.id} onClick={() => chooseEmbeddedAudio(track)}>
                  {track.label || `Track ${track.id}`}
                </ChipButton>
              ))}
            </div>
          )}
        </Sheet>
      ) : null}

      {activeSheet === 'sync' ? (
        <Sheet title="Timing sync" onClose={() => setActiveSheet('none')}>
          <DelayRow
            label="Subtitles"
            value={subtitleDelay}
            onAdjust={(value) => adjustDelay('subtitle', value)}
          />
          <DelayRow
            label="Audio"
            value={audioDelay}
            onAdjust={(value) => adjustDelay('audio', value)}
          />
          <p className="mt-3 text-xs text-white/45">Negative shows audio/subtitles earlier; positive later. Applies instantly, no restart.</p>
        </Sheet>
      ) : null}
    </div>
  );
}

function IconButton({ label, onClick, children, active = false, accent = false }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-12 w-12 items-center justify-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${accent ? 'border-white/70 bg-white text-black hover:bg-white/85' : active ? 'border-[#ff7a17]/60 bg-[#ff7a17]/15 text-[#ffc285]' : 'border-white/20 bg-black/50 text-white hover:border-white/45'}`}
    >
      {children}
    </button>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-10 max-w-full truncate rounded-full border px-4 text-sm transition ${active ? 'border-[#ff7a17]/60 bg-[#ff7a17]/15 text-[#ffc285]' : 'border-white/15 bg-white/[0.04] text-white/80 hover:border-white/35 hover:text-white'}`}
    >
      {children}
    </button>
  );
}

/** Right-side settings panel (~42% width): the video stays visible on the
 *  left; the connection status and its details live at the top, like the
 *  desktop player's menu column. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const compat = useConnectionStatus();
  const statusDot: Record<string, string> = {
    checking: 'bg-white/40',
    ready: 'bg-emerald-400',
    unreachable: 'bg-red-400',
    incompatible: 'bg-[#ffc285]',
  };
  const statusLabel: Record<string, string> = {
    checking: 'Checking server…',
    ready: 'Connected',
    unreachable: 'Not connected',
    incompatible: 'Server incompatible',
  };
  let host = compat.origin || 'not set';
  try { host = compat.origin ? new URL(compat.origin).host : 'not set'; } catch { /* keep raw */ }

  return (
    <div
      className="absolute inset-y-0 right-0 z-30 flex w-[42vw] min-w-[300px] max-w-[480px] flex-col rounded-l-2xl border-l border-white/10 bg-[#0a0a0a]/95 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-xl"
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between px-5">
        <h2 className="font-label text-sm uppercase tracking-wide text-white/70">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="min-h-10 rounded-full px-3 text-sm text-white/70 transition hover:text-white"
        >
          Done
        </button>
      </div>
      {/* Connection status + details (matches the desktop menu column). */}
      <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDot[compat.status] ?? 'bg-white/40'} ${compat.status === 'checking' ? 'animate-pulse' : ''}`}
        />
        <div className="min-w-0">
          <p className="truncate text-sm text-white/85">{statusLabel[compat.status] ?? compat.status}</p>
          <p className="truncate text-xs text-white/45">{host}</p>
        </div>
      </div>
      <div className="app-scrollbar mt-3 flex-1 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  );
}

/** Stremio-inspired buffering state: the movie title breathes under a moving
 *  light sheen (no bare text loader). */
function BufferingLoader({ title, posterUrl, progress }: { title: string; posterUrl: string | null; progress: number }) {
  return (
    <div role="status" aria-label={`Buffering ${title}`} className="absolute inset-0 z-10 overflow-hidden bg-black/60">
      {posterUrl ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center opacity-20"
          style={{ backgroundImage: `url(${posterUrl})`, filter: 'blur(28px) saturate(0.7)', transform: 'scale(1.1)' }}
        />
      ) : null}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
        <div className="relative overflow-hidden px-6">
          <h2 className="type-page-title bg-gradient-to-r from-white/30 via-white to-white/30 bg-[length:220%_100%] bg-clip-text text-center text-transparent animate-shimmer">
            {title}
          </h2>
        </div>
        <div className="relative h-8 w-8">
          <LoaderCircle className="h-8 w-8 animate-spin text-white/85" aria-hidden="true" />
        </div>
        <p className="font-label text-numeric text-xs text-white/55">
          {progress > 0 && progress < 100 ? `Buffering ${Math.round(progress)}%` : 'Buffering…'}
        </p>
      </div>
    </div>
  );
}

function DelayRow({ label, value, onAdjust }: { label: string; value: number; onAdjust: (value: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="w-24 shrink-0 text-sm text-white/80">{label}</span>
      <div className="flex items-center gap-3">
        <button type="button" aria-label={`${label} earlier`} onClick={() => onAdjust(value - 0.1)} className="h-10 w-10 rounded-full border border-white/20 text-white/85 transition hover:border-white/45">−</button>
        <output className="font-label text-numeric w-16 text-center text-sm text-white">{formatDelay(value)}</output>
        <button type="button" aria-label={`${label} later`} onClick={() => onAdjust(value + 0.1)} className="h-10 w-10 rounded-full border border-white/20 text-white/85 transition hover:border-white/45">+</button>
        <button type="button" aria-label={`Reset ${label.toLowerCase()} timing`} onClick={() => onAdjust(0)} className="min-h-11 px-2 text-sm text-white underline">Reset</button>
      </div>
    </div>
  );
}
