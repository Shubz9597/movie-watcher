// NativePlayerControls (M1.4.7): the shared web control surface rendered ON
// TOP of the VLC surface (which sits behind the WebView). One implementation
// for iOS and Android: loading screen, tap-to-toggle controls, seek bar,
// ±10s, play/pause, subtitle sheet (embedded + torrent + OpenSubtitles +
// local import + timing offset), audio sheet (embedded + timing offset), and
// the skip-intro chip when timestamps exist (server /skip-segments).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { ChevronLeft, Pause, Play, RotateCcw, RotateCw, Captions, AudioLines, Timer, Upload } from 'lucide-react';
import { getVodBase } from '../lib/api-client';
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
  const subtitleOperation = useRef(0);
  const controlsHideTimer = useRef<number | null>(null);

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
      .then((data: { tracks?: CatalogSubtitleTrack[]; message?: string }) => {
        if (cancelled) return;
        setCatalog(Array.isArray(data?.tracks) ? data.tracks : []);
        setCatalogMessage(data?.message ?? '');
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

  const toggleControls = () => {
    if (activeSheet !== 'none') {
      setActiveSheet('none');
      return;
    }
    if (controlsVisible) {
      setControlsVisible(false);
    } else {
      revealControls();
    }
  };

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
    <div className="fixed inset-0 z-[60] select-none bg-transparent" onPointerUp={toggleControls}>
      {buffering.active ? <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40"><span className="rounded-full bg-black/80 px-5 py-3 text-white">Buffering…</span></div> : null}
      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-start justify-between p-4 transition-opacity duration-200 ${controlsVisible || activeSheet !== 'none' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
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

        {/* Buttons */}
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <IconButton label="Back 10 seconds" onClick={() => player.seekBy(-10)}>
              <RotateCcw className="h-6 w-6" aria-hidden="true" />
            </IconButton>
            <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => player.togglePlayback()} accent>
              {playing ? <Pause className="h-7 w-7" aria-hidden="true" /> : <Play className="h-7 w-7" aria-hidden="true" />}
            </IconButton>
            <IconButton label="Forward 10 seconds" onClick={() => player.seekBy(10)}>
              <RotateCw className="h-6 w-6" aria-hidden="true" />
            </IconButton>
          </div>
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

      {/* Sheets */}
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
            {catalogStatus === 'loading' ? <p className="mt-2 text-sm text-white/60" role="status">Finding subtitles…</p> : null}
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

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-30" onPointerUp={(event) => event.stopPropagation()}>
      <div className="rounded-t-2xl border-t border-white/10 bg-[#0a0a0a]/95 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl">
        <div className="mb-3 flex items-center justify-between">
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
        <div className="max-h-[45vh] overflow-y-auto app-scrollbar">{children}</div>
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
