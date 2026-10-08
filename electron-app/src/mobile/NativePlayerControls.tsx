// NativePlayerControls (M1.4.7): the shared web control surface rendered ON
// TOP of the VLC surface (which sits behind the WebView). One implementation
// for iOS and Android: loading screen, tap-to-toggle controls, seek bar,
// ±10s, play/pause, subtitle sheet (embedded + torrent + OpenSubtitles +
// local import + timing offset), audio sheet (embedded + timing offset), and
// the skip-intro chip when timestamps exist (server /skip-segments).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, Pause, Play, Captions, AudioLines, Timer, Upload, LoaderCircle, Scan, Proportions, MoveHorizontal, HeartPulse, Minus, Plus, X, RotateCcw, RotateCw } from 'lucide-react';
import { getVodBase } from '../lib/api-client';
import { parseSubtitles, type SubtitleCue, type SubtitleFormat } from '../lib/subtitle-parser';
import { SUBTITLE_LANGUAGES } from '../lib/subtitle-languages';
import { offlineSkipSegments } from '../lib/offline-skip-segments';
import { clampPlaybackDelay, matchingSavedTrack, readVideoPlaybackPreferences, saveVideoPlaybackPreferences, subtitleCueAtTime, videoPlaybackPreferenceKey } from './video-playback-preferences';
import type { SavedSubtitle, VideoPlaybackPreferences } from './video-playback-preferences';

export type NativeTrackInfo = { id: number; label?: string; language?: string };

export type NativePlayerControlsSurface = {
  seekTo(positionSec: number): void;
  seekBy(deltaSeconds: number): void;
  togglePlayback(): void;
  setSubtitleDelay(seconds: number): void;
  setAudioDelay(seconds: number): void;
  selectAudioTrack(trackId: number): void;
  selectSubtitleTrack(trackId: number | null): void;
  setVideoScale(mode: 'fit' | 'fill' | 'stretch'): void;
  loadSubtitle(input: { url: string; label?: string; language?: string }): Promise<number | null>;
  /** Embedded-subtitle text scale (% of default) — engine recreate at position. */
  setEmbeddedSubtitleScale(percent: number): void;
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

// Torrent telemetry (desktop TorrentHealthMenu parity): served by the same
// GET /buffer/info endpoint the desktop player polls.
type TorrentHealthStats = {
  activePeers?: number;
  connectedSeeders?: number;
  totalPeers?: number;
  pendingPeers?: number;
  downloadedBytes?: number;
  completedBytes?: number;
  contiguousAhead?: number;
  targetBytes?: number;
  fileLength?: number;
  pollingError?: boolean;
};

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
  logoUrl: string | null;
  magnet: string;
  /** Local download playback: offline skip timestamps are read for it. */
  downloadId?: string;
  cat: string;
  fileIndex: number | undefined;
  tmdbId: number | undefined;
  imdbId: string | undefined;
  malId: number | undefined;
  /** Anime: maps episodes to the show's IMDb season/episode for subtitles. */
  anilistId?: number;
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


// Fit keeps the whole picture; Fill crops to cover; Stretch fills both axes.
const SCALE_MODES = {
  fit: 'Fit',
  fill: 'Fill',
  stretch: 'Stretch',
} as const;

function nextScaleMode(mode: 'fit' | 'fill' | 'stretch'): 'fit' | 'fill' | 'stretch' {
  return mode === 'fit' ? 'fill' : mode === 'fill' ? 'stretch' : 'fit';
}

export default function NativePlayerControls(props: Props) {
  const { player, title, year, logoUrl, magnet, cat, fileIndex, tmdbId, imdbId, malId, anilistId, season, episode, absoluteEpisode, downloadId, onClose } = props;
  const episodeLabel = Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : null;
  // Offline downloads play without a magnet: no server catalog, torrent
  // telemetry or import — only the tracks inside the downloaded package.
  const local = !magnet;
  // PlayerPage remounts controls for a different source/file/episode. Capture
  // this video's settings once, and save explicit changes immediately.
  const [savedVideo] = useState(() => {
    const key = videoPlaybackPreferenceKey({ origin: getVodBase(), magnet, downloadId, cat, fileIndex, season, episode });
    return { key, preferences: readVideoPlaybackPreferences(key) };
  });
  const preferencesRef = useRef<VideoPlaybackPreferences>(savedVideo.preferences ?? {
    subtitle: null, subtitleDelay: 0, audioTrack: null, audioDelay: 0,
  });
  const pendingSubtitleRestore = useRef(savedVideo.preferences?.subtitle ?? null);
  const pendingAudioRestore = useRef(savedVideo.preferences?.audioTrack ?? null);
  const timingRestored = useRef(false);
  const savePreferences = (patch: Partial<VideoPlaybackPreferences>) => {
    preferencesRef.current = { ...preferencesRef.current, ...patch };
    saveVideoPlaybackPreferences(savedVideo.key, preferencesRef.current);
  };

  const [hasVideo, setHasVideo] = useState(false);
  const [buffering, setBuffering] = useState<{ active: boolean; progress?: number }>({ active: true });
  const [showRebuffering, setShowRebuffering] = useState(false);
  const [time, setTime] = useState({ currentTime: 0, duration: 0 });
  const [playing, setPlaying] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activeSheet, setActiveSheet] = useState<'none' | 'subtitles' | 'audio' | 'sync' | 'stats'>('none');

  const [embeddedAudio, setEmbeddedAudio] = useState<NativeTrackInfo[]>([]);
  const [embeddedSubs, setEmbeddedSubs] = useState<NativeTrackInfo[]>([]);
  const [selectedEmbeddedSub, setSelectedEmbeddedSub] = useState<number | null>(null);
  const [selectedEmbeddedAudio, setSelectedEmbeddedAudio] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<CatalogSubtitleTrack[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogMessage, setCatalogMessage] = useState('');
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [subtitleDelay, setSubtitleDelayState] = useState(preferencesRef.current.subtitleDelay);
  const [audioDelay, setAudioDelayState] = useState(preferencesRef.current.audioDelay);
  const [skipSegments, setSkipSegments] = useState<SkipSegment[]>([]);
  const [importing, setImporting] = useState(false);
  const [loadingSubtitleUrl, setLoadingSubtitleUrl] = useState<string | null>(null);
  const [subtitleError, setSubtitleError] = useState('');
  const [language, setLanguage] = useState(() => {
    const selection = preferencesRef.current.subtitle;
    return selection?.kind === 'external' ? selection.language || 'en' : 'en';
  });
  const [scrubTo, setScrubTo] = useState<number | null>(null);
  // Mirror the saved native sizing preference for the button.
  const [scaleMode, setScaleMode] = useState<'fit' | 'fill' | 'stretch'>(() => {
    try {
      const saved = window.localStorage.getItem('mw_video_scale');
      return saved === 'fill' || saved === 'stretch' ? saved : 'fit';
    } catch {
      return 'fit';
    }
  });
  // Names the new mode for a moment: three similar icons need a word.
  const [scaleToast, setScaleToast] = useState<string | null>(null);
  const scaleToastTimer = useRef<number | null>(null);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [health, setHealth] = useState<TorrentHealthStats | null>(null);
  const healthSpeedRef = useRef<{ bytes: number; at: number } | null>(null);
  const [healthSpeed, setHealthSpeed] = useState(0);
  const subtitleOperation = useRef(0);
  const controlsHideTimer = useRef<number | null>(null);
  // Web-rendered subtitle overlay (v2): sheet-loaded tracks (OpenSubtitles,
  // torrent sidecars, imports) render as a web overlay with live pinch
  // resize — VLC's own renderer has no runtime size API, and embedded tracks
  // stay VLC-rendered at the engine's fixed size.
  const [overlayCues, setOverlayCues] = useState<SubtitleCue[] | null>(null);
  const [overlaySize, setOverlaySize] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem('mw_sub_overlay_px'));
    return Number.isFinite(saved) && saved >= 12 && saved <= 48 ? saved : 18;
  });
  const overlaySizeRef = useRef(overlaySize);
  overlaySizeRef.current = overlaySize;
  const pinchGuardRef = useRef(0);
  // Double-tap seek zones: left third rewinds, right third advances.
  const lastTapRef = useRef<{ time: number; x: number } | null>(null);
  const singleTapTimer = useRef<number | null>(null);
  const activeSheetRef = useRef(activeSheet);
  activeSheetRef.current = activeSheet;
  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;
  const selectedEmbeddedSubRef = useRef<number | null>(null);
  selectedEmbeddedSubRef.current = selectedEmbeddedSub;

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
      setHasVideo(true);
      setBuffering({ active: false });
    });
    const detachBuffering = player.subscribeBuffering((update) => {
      setBuffering(update);
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

  // Brief cache refills should not flash a loading screen over a movie.
  // Completion cancels the pending indicator immediately; no minimum stall.
  useEffect(() => {
    if (!hasVideo || !buffering.active || !playing) {
      setShowRebuffering(false);
      return;
    }
    const timer = window.setTimeout(() => setShowRebuffering(true), 450);
    return () => window.clearTimeout(timer);
  }, [hasVideo, buffering.active, playing]);

  // --- Skip segments (where timestamps exist) ---
  // Downloads use the timestamps stored when they were downloaded.
  useEffect(() => {
    if (!downloadId) return;
    setSkipSegments(offlineSkipSegments(downloadId));
  }, [downloadId]);
  useEffect(() => {
    if (downloadId) return;
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
  }, [downloadId, time.duration, skipSegments.length, cat, tmdbId, imdbId, malId, season, episode, absoluteEpisode]);

  const activeSkipSegment = useMemo(() => {
    return skipSegments.find((segment) => time.currentTime >= segment.start && time.currentTime <= segment.end && segment.type === 'intro') ?? null;
  }, [skipSegments, time.currentTime]);

  // --- Web subtitle overlay: the active cue for the current playback time,
  // derived (not stored) so a 500ms clock tick never misses a cue.
  const activeOverlayCue = useMemo(() => {
    if (!overlayCues) return null;
    return subtitleCueAtTime(overlayCues, time.currentTime, subtitleDelay);
  }, [overlayCues, time.currentTime, subtitleDelay]);

  // --- Pinch-to-resize on the video surface: two-finger spread adjusts the
  // overlay font size live and persists per device. A pinch suppresses the
  // tap gestures for a short guard window afterwards.
  const pinchRef = useRef<{ dist0: number; size0: number } | null>(null);
  const touchDist = (touches: React.TouchList): number => {
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      pinchRef.current = { dist0: touchDist(event.touches), size0: overlaySizeRef.current };
      if (singleTapTimer.current !== null) {
        window.clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
      }
      lastTapRef.current = null;
    }
  };
  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const pinch = pinchRef.current;
    if (!pinch || event.touches.length < 2) return;
    const ratio = touchDist(event.touches) / pinch.dist0;
    const next = Math.round(Math.max(12, Math.min(48, pinch.size0 * ratio)));
    if (next !== overlaySizeRef.current) {
      overlaySizeRef.current = next;
      setOverlaySize(next);
    }
  };
  const handleTouchEnd = () => {
    if (pinchRef.current) {
      pinchRef.current = null;
      pinchGuardRef.current = Date.now() + 400; // ignore trailing taps
      window.localStorage.setItem('mw_sub_overlay_px', String(overlaySizeRef.current));
      // Embedded subs scale via the same gesture: one engine recreate at the
      // current position when an embedded track is actually selected.
      if (selectedEmbeddedSubRef.current !== null) {
        const percent = Math.round(75 * (overlaySizeRef.current / 18));
        player.setEmbeddedSubtitleScale(Math.max(25, Math.min(200, percent)));
      }
    }
  };


  // --- Torrent telemetry (desktop TorrentHealthMenu parity) ---
  // Polls GET /buffer/info on the same 4s cadence as the desktop player,
  // ONLY while the stats sheet is open (bounded surface, no background load).
  // Download speed is derived from downloadedBytes deltas between polls.
  useEffect(() => {
    if (activeSheet !== 'stats' || local) return;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      const params = new URLSearchParams({ magnet, cat });
      if (fileIndex != null) params.set('fileIndex', String(fileIndex));
      try {
        const res = await fetch(`${getVodBase()}/buffer/info?${params.toString()}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(4000),
        });
        if (cancelled) return;
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as TorrentHealthStats;
        setHealth({ ...data, pollingError: false });
        const now = Date.now();
        const previous = healthSpeedRef.current;
        const bytes = Math.max(0, Number(data.downloadedBytes) || 0);
        if (previous && now > previous.at) {
          const rate = Math.max(0, (bytes - previous.bytes) / ((now - previous.at) / 1000));
          setHealthSpeed(rate);
        }
        healthSpeedRef.current = { bytes, at: now };
      } catch {
        if (cancelled) return;
        setHealth((current) => ({ ...(current ?? {}), pollingError: true }));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
    };

    healthSpeedRef.current = null;
    setHealthSpeed(0);
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeSheet, magnet, cat, fileIndex]);

  // --- Subtitle catalog (server /subtitles/list) ---
  useEffect(() => {
    if (activeSheet !== 'subtitles' || catalogStatus !== 'loading' || local) return;
    let cancelled = false;
    const params = new URLSearchParams({ cat, magnet, langs: language, title });
    if (year) params.set('year', String(year));
    if (fileIndex != null) params.set('fileIndex', String(fileIndex));
    if (imdbId) params.set('imdbId', imdbId);
    if (tmdbId) params.set('tmdbId', String(tmdbId));
    if (cat === 'anime' && anilistId) params.set('anilistId', String(anilistId));
    if (cat === 'anime' && malId) params.set('malId', String(malId));
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
      if (activeSheet === 'none' && playing) setControlsVisible(false);
    }, 4000);
  }, [activeSheet, playing]);
  useEffect(() => {
    if (controlsHideTimer.current !== null) window.clearTimeout(controlsHideTimer.current);
    if (!playing) setControlsVisible(true);
    if (hasVideo && playing && controlsVisible && activeSheet === 'none') {
      controlsHideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
    }
    return () => {
      if (controlsHideTimer.current !== null) window.clearTimeout(controlsHideTimer.current);
    };
  }, [hasVideo, playing, controlsVisible, activeSheet]);
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
   *    (the centre buttons do the same while the controls show)
   */
  const handleSurfaceTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Trailing taps right after a pinch are gesture remnants — ignore.
    if (Date.now() < pinchGuardRef.current) return;
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
    if (scaleToastTimer.current !== null) window.clearTimeout(scaleToastTimer.current);
  }, []);

  // Sheet-loaded tracks render as the WEB overlay (pinch-resizable); embedded
  // tracks stay VLC-rendered. Choosing one kind always clears the other so
  // subtitles never render twice.
  const applyOverlayFromUrl = async (selection: Extract<SavedSubtitle, { kind: 'external' }>, operation: number): Promise<boolean> => {
    const url = selection.url.startsWith('http') ? selection.url : `${getVodBase()}${selection.url}`;
    const res = await fetch(url, { headers: { Accept: 'text/vtt, text/plain, */*' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`subtitle download failed (${res.status})`);
    const raw = await res.text();
    const cues = parseSubtitles(raw, selection.format);
    if (cues.length === 0) throw new Error('That subtitle file has no readable cues.');
    // A late download must not override Off, a manual track choice, or a
    // replaced player (including automatic restore requests).
    if (operation !== subtitleOperation.current) return false;
    setOverlayCues(cues);
    setSelectedEmbeddedSub(null);
    setActiveSubtitleUrl(selection.url);
    player.selectSubtitleTrack(null); // never double-render over the overlay
    return true;
  };

  // Restore only after the native player is ready. Embedded inventories can
  // arrive later than Playing, so keep a missing selection pending until its
  // track appears. User actions cancel their respective pending restoration.
  useEffect(() => {
    if (!hasVideo) return;
    if (!timingRestored.current) {
      timingRestored.current = true;
      player.setSubtitleDelay(preferencesRef.current.subtitleDelay);
      player.setAudioDelay(preferencesRef.current.audioDelay);
    }
    const audio = pendingAudioRestore.current;
    if (audio) {
      const track = matchingSavedTrack(embeddedAudio, audio);
      if (track) {
        pendingAudioRestore.current = null;
        player.selectAudioTrack(track.id);
        setSelectedEmbeddedAudio(track.id);
      }
    }
    const selection = pendingSubtitleRestore.current;
    if (!selection) return;
    if (selection.kind === 'embedded') {
      const track = matchingSavedTrack(embeddedSubs, selection.track);
      if (!track) return;
      pendingSubtitleRestore.current = null;
      player.selectSubtitleTrack(track.id);
      setSelectedEmbeddedSub(track.id);
    } else if (selection.kind === 'off') {
      // Wait for track enumeration so VLC's initial auto-selection settles.
      if (embeddedSubs.length === 0) return;
      pendingSubtitleRestore.current = null;
      player.selectSubtitleTrack(null);
      setSelectedEmbeddedSub(null);
    } else {
      pendingSubtitleRestore.current = null;
      const operation = ++subtitleOperation.current;
      setLoadingSubtitleUrl(selection.url);
      void applyOverlayFromUrl(selection, operation).catch(() => {
        if (operation === subtitleOperation.current) setSubtitleError('Couldn’t restore your saved subtitle. Select it to try again.');
      }).finally(() => {
        if (operation === subtitleOperation.current) setLoadingSubtitleUrl(null);
      });
    }
  }, [hasVideo, embeddedAudio, embeddedSubs, player]);

  const chooseCatalogSubtitle = async (track: CatalogSubtitleTrack) => {
    if (loadingSubtitleUrl || importing) return;
    pendingSubtitleRestore.current = null;
    const operation = ++subtitleOperation.current;
    const selection: Extract<SavedSubtitle, { kind: 'external' }> = {
      kind: 'external', url: track.url, format: (track.format || 'vtt') as SubtitleFormat,
      label: track.fileName || track.label, language: track.lang,
    };
    setLoadingSubtitleUrl(track.url);
    setSubtitleError('');
    try {
      if (operation !== subtitleOperation.current) return;
      if (await applyOverlayFromUrl(selection, operation)) savePreferences({ subtitle: selection });
    } catch {
      if (operation === subtitleOperation.current) setSubtitleError('Couldn’t load this subtitle.');
    } finally {
      if (operation === subtitleOperation.current) setLoadingSubtitleUrl(null);
    }
  };

  const chooseEmbeddedSubtitle = (track: NativeTrackInfo) => {
    pendingSubtitleRestore.current = null;
    subtitleOperation.current++;
    setLoadingSubtitleUrl(null);
    setOverlayCues(null);
    setActiveSubtitleUrl(null);
    player.selectSubtitleTrack(track.id);
    setSelectedEmbeddedSub(track.id);
    savePreferences({ subtitle: { kind: 'embedded', track } });
  };

  const disableSubtitles = () => {
    pendingSubtitleRestore.current = null;
    subtitleOperation.current++;
    setLoadingSubtitleUrl(null);
    setOverlayCues(null);
    setActiveSubtitleUrl(null);
    player.selectSubtitleTrack(null);
    setSelectedEmbeddedSub(null);
    savePreferences({ subtitle: { kind: 'off' } });
  };

  const chooseEmbeddedAudio = (track: NativeTrackInfo) => {
    pendingAudioRestore.current = null;
    player.selectAudioTrack(track.id);
    setSelectedEmbeddedAudio(track.id);
    savePreferences({ audioTrack: track });
  };

  const importLocalSubtitle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (loadingSubtitleUrl || importing) return;
    if (file.size > 4 * 1024 * 1024 || file.size === 0) {
      setSubtitleError('Choose a subtitle file up to 4 MB.');
      return;
    }
    setImporting(true);
    pendingSubtitleRestore.current = null;
    setSubtitleError('');
    const operation = ++subtitleOperation.current;
    const origin = getVodBase();
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`${origin}/subtitles/import`, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('Couldn’t import this subtitle.');
      const data = (await res.json()) as { url?: string; fileName?: string; format?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? 'The subtitle could not be imported.');
      }
      if (operation !== subtitleOperation.current || origin !== getVodBase()) return;
      const selection: Extract<SavedSubtitle, { kind: 'external' }> = {
        kind: 'external', url: data.url, format: (data.format || 'vtt') as SubtitleFormat,
        label: data.fileName || file.name,
      };
      if (await applyOverlayFromUrl(selection, operation)) savePreferences({ subtitle: selection });
    } catch (error) {
      if (operation === subtitleOperation.current) setSubtitleError(error instanceof Error ? error.message : 'The subtitle could not be imported.');
    } finally {
      setImporting(false);
    }
  };

  const adjustDelay = (kind: 'subtitle' | 'audio', value: number) => {
    const clamped = clampPlaybackDelay(value);
    if (kind === 'subtitle') {
      setSubtitleDelayState(clamped);
      player.setSubtitleDelay(clamped);
      savePreferences({ subtitleDelay: clamped });
    } else {
      setAudioDelayState(clamped);
      player.setAudioDelay(clamped);
      savePreferences({ audioDelay: clamped });
    }
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

  // The centre buttons and dim layer show with the controls, but not over
  // an open sheet.
  const centerVisible = hasVideo && controlsVisible && activeSheet === 'none';
  return (
    <div
      className="fixed inset-0 z-[60] touch-none select-none bg-transparent"
      onPointerUp={handleSurfaceTap}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <BufferingLoader title={title} logoUrl={logoUrl} visible={!hasVideo} progress={buffering.progress} />
      <div className={`native-rebuffer${showRebuffering ? ' native-rebuffer--visible' : ''}`} role={showRebuffering ? 'status' : undefined} aria-label="Buffering" aria-hidden={!showRebuffering}>
        <LoaderCircle aria-hidden="true" />
      </div>
      {/* Web-rendered subtitle overlay (sheet-loaded tracks): pinch anywhere
          on the video to resize — the size persists per device. */}
      {hasVideo && activeOverlayCue ? (
        <div className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-6 transition-all duration-200" style={{ bottom: controlsVisible || activeSheet !== 'none' ? '9.5rem' : '3rem' }}>
          <span
            className="whitespace-pre-line rounded bg-black/55 px-3 py-1 text-center leading-snug text-white [text-shadow:_0_1px_3px_rgb(0_0_0/90%)]"
            style={{ fontSize: `${overlaySize}px` }}
          >
            {activeOverlayCue.text}
          </span>
        </div>
      ) : null}
      {/* YouTube-style chrome: the picture dims while the controls show. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 z-10 bg-black/40 transition-opacity duration-200 ${centerVisible ? 'opacity-100' : 'opacity-0'}`} />

      {/* Top bar — title on the left, track tools on the right; safe-area
          aware so nothing sits under the Dynamic Island / notch. */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-start gap-1 bg-gradient-to-b from-black/60 to-transparent pb-6 px-[max(0.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity duration-200 ${!hasVideo || controlsVisible || activeSheet !== 'none' || scaleToast ? 'opacity-100' : 'pointer-events-none invisible opacity-0'}`}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close player"
          onClick={onClose}
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white [filter:drop-shadow(0_1px_3px_rgb(0_0_0/80%))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </button>
        {hasVideo ? (
          <div className="pointer-events-none min-w-0 flex-1 pt-1.5 text-left">
            <div data-player-heading className="min-w-0 text-left text-white [text-shadow:_0_1px_3px_rgb(0_0_0/80%)]">
              <p className="truncate text-lg font-semibold leading-6" title={title}>{title}</p>
              {episodeLabel ? <p data-player-episode className="text-numeric truncate text-sm text-white/75">{episodeLabel}</p> : null}
            </div>
            {scaleToast ? (
              <span className="mt-2 inline-block rounded-full bg-black/80 px-3 py-1 text-sm font-medium text-white" role="status" aria-live="polite">{scaleToast}</span>
            ) : null}
          </div>
        ) : <div className="flex-1" />}
        {hasVideo ? (
          <div className="flex shrink-0 items-center gap-1">
            {!local ? (
              <IconButton label="Torrent health" onClick={() => setActiveSheet(activeSheet === 'stats' ? 'none' : 'stats')} active={activeSheet === 'stats'}>
                <HeartPulse className="h-6 w-6" aria-hidden="true" />
              </IconButton>
            ) : null}
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
        ) : null}
      </div>

      {/* Centre: back 10 s, play/pause, forward 10 s (double-tap the left or
          right of the picture does the same). Hidden while buffering, where
          the spinner takes the centre. */}
      {hasVideo ? (
        <div className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-10 transition-opacity duration-200 ${centerVisible && !showRebuffering ? 'opacity-100' : 'invisible opacity-0'}`}>
          <CenterButton label="Back 10 seconds" onClick={() => player.seekBy(-10)}>
            <RotateCcw className="h-7 w-7" aria-hidden="true" />
          </CenterButton>
          <CenterButton label={playing ? 'Pause' : 'Play'} onClick={() => player.togglePlayback()} large>
            {playing ? <Pause className="h-9 w-9 fill-current" aria-hidden="true" /> : <Play className="ml-1 h-9 w-9 fill-current" aria-hidden="true" />}
          </CenterButton>
          <CenterButton label="Forward 10 seconds" onClick={() => player.seekBy(10)}>
            <RotateCw className="h-7 w-7" aria-hidden="true" />
          </CenterButton>
        </div>
      ) : null}

      {/* Skip-intro chip (where timestamps exist) */}
      {activeSkipSegment ? (
        <div className="absolute bottom-28 right-4 z-20">
          <button
            type="button"
            onPointerUp={(event) => {
              event.stopPropagation();
              player.seekTo(activeSkipSegment.end + 0.25);
            }}
            className="min-h-12 rounded-lg bg-white px-5 text-sm font-medium text-black shadow-lg transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Skip intro
          </button>
        </div>
      ) : null}

      {/* Bottom: elapsed / total on the left, screen size on the right, the
          full-width seek bar beneath. */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 transition-opacity duration-200 ${hasVideo && (controlsVisible || activeSheet !== 'none') ? 'opacity-100' : 'pointer-events-none invisible opacity-0'}`}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-numeric rounded-full bg-black/45 px-3 py-1 text-sm font-medium text-white">
            {formatTime(scrubTo ?? time.currentTime)} / {formatTime(time.duration)}
          </span>
            {/* Scale sits LAST — the convention in mainstream players. */}
            <IconButton
              label={SCALE_MODES[nextScaleMode(scaleMode)]}
              onClick={() => {
                const next = nextScaleMode(scaleMode);
                setScaleMode(next);
                player.setVideoScale(next);
                setScaleToast(SCALE_MODES[next]);
                if (scaleToastTimer.current) window.clearTimeout(scaleToastTimer.current);
                scaleToastTimer.current = window.setTimeout(() => setScaleToast(null), 1600);
                try {
                  window.localStorage.setItem('mw_video_scale', next);
                } catch {
                  // The native player still remembers the choice.
                }
              }}
            >
              {scaleMode === 'fit'
                ? <Scan className="h-6 w-6" aria-hidden="true" />
                : scaleMode === 'fill'
                  ? <Proportions className="h-6 w-6" aria-hidden="true" />
                  : <MoveHorizontal className="h-6 w-6" aria-hidden="true" />}
            </IconButton>
        </div>
        {/* Seek bar — dragging scrubs locally; ONE seek commits on release
            so a drag cannot flood the player (or, via heartbeats, the server). */}
        <div className="relative mt-1 h-8">
          <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-white/25">
            <div className="h-full rounded-full bg-white" style={{ width: `${progress}%` }} />
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `${progress}%` }}
          />
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
      </div>

      {/* Sheets — right-side panel (~42% width), desktop-equivalent; keeps
          the video visible on the left and respects safe areas. */}
      {activeSheet === 'subtitles' ? (
        <Sheet title="Subtitles" onClose={() => setActiveSheet('none')}>
          {subtitleError ? <p role="alert" className="type-secondary mb-3 text-red-300">{subtitleError}</p> : null}
          {/* Compact track chips */}
          <fieldset disabled={!!loadingSubtitleUrl || importing} className="flex flex-wrap gap-2 disabled:opacity-60">
            {/* Off only makes sense when something is actually active. */}
            {activeSubtitleUrl !== null || selectedEmbeddedSub !== null ? (
              <ChipButton active={false} onClick={disableSubtitles}>Off</ChipButton>
            ) : null}
            {embeddedSubs.map((track) => (
              <ChipButton key={track.id} active={selectedEmbeddedSub === track.id} onClick={() => chooseEmbeddedSubtitle(track)}>
                {track.label || `Track ${track.id}`}
              </ChipButton>
            ))}
          </fieldset>
          {local ? (
            embeddedSubs.length === 0 ? <p className="type-secondary text-white/60">No subtitles in this download.</p> : null
          ) : <>
          <div className="mt-4 border-t border-white/[0.08] pt-4">
            <h3 className="text-sm font-semibold text-white">Online subtitles</h3>
            <label className="type-secondary mt-3 flex items-center justify-between gap-2 text-white/75">
              Language
              <select aria-label="Subtitle language" value={language} onChange={(event) => { setLanguage(event.target.value); setCatalog([]); setCatalogStatus('loading'); }} className="min-h-12 rounded-lg border border-white/15 bg-black px-3 text-sm text-white">
                {SUBTITLE_LANGUAGES.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            {!providerConfigured ? (
              <form onSubmit={(event) => void connectOpenSubtitles(event)} className="mt-3">
                <label htmlFor="mobileOpenSubtitlesKey" className="type-secondary text-white/75">OpenSubtitles API key</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="mobileOpenSubtitlesKey"
                    type="password"
                    value={apiKeyInput}
                    autoComplete="new-password"
                    disabled={savingApiKey}
                    placeholder="Paste API key"
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    className="min-h-12 min-w-0 flex-1 rounded-lg border border-white/15 bg-black px-3 text-base text-white"
                  />
                  <button type="submit" disabled={savingApiKey} className="min-h-12 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-white/85 disabled:opacity-50">
                    {savingApiKey ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => window.open('https://www.opensubtitles.com/en/api-keys', '_blank', 'noopener')}
                  className="type-secondary mt-1 min-h-12 text-white/70 underline"
                >
                  Get an API key
                </button>
              </form>
            ) : null}
            {catalogStatus === 'loading' ? <p className="type-secondary mt-3 flex items-center gap-2 text-white/70" role="status"><LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> Finding subtitles…</p> : null}
            {catalogStatus !== 'loading' && (catalogMessage || catalog.length === 0) ? (
              <p className="type-secondary mt-3 text-white/60">{catalogMessage || 'No subtitles found.'}</p>
            ) : null}
            {catalogStatus !== 'loading' ? <button type="button" onClick={() => setCatalogStatus('loading')} className="type-secondary min-h-12 text-white/75 underline transition hover:text-white">Search again</button> : null}
            <div className="mt-1 space-y-2">
              {catalog.map((track) => (
                <button
                  key={track.url}
                  type="button"
                  onClick={() => void chooseCatalogSubtitle(track)}
                  disabled={!!loadingSubtitleUrl || importing}
                  aria-pressed={activeSubtitleUrl === track.url}
                  className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${activeSubtitleUrl === track.url ? 'border-white bg-white text-black' : 'border-white/10 bg-white/[0.03] text-white/80 hover:border-white/25 hover:text-white'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{loadingSubtitleUrl === track.url ? 'Loading…' : track.fileName || track.label}</span>
                  <span className="shrink-0 text-xs opacity-60">
                    {track.source === 'torrent' ? 'Torrent' : 'OpenSubtitles'}
                    {track.movieHashMatched ? ' · hash' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 border-t border-white/[0.08] pt-4">
            <label className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-white/20 px-4 text-sm font-medium text-white transition hover:border-white/40 focus-within:ring-2 focus-within:ring-white">
              <Upload className="h-4 w-4" aria-hidden="true" />
              {importing ? 'Importing…' : 'Import subtitle file'}
              <input type="file" accept=".srt,.vtt,.ass,.ssa" className="sr-only" onChange={(event) => void importLocalSubtitle(event)} disabled={importing || !!loadingSubtitleUrl} />
            </label>
            <p className="type-secondary mt-2 text-white/60">SRT, VTT, ASS or SSA · up to 4 MB</p>
          </div>
          </>}
        </Sheet>
      ) : null}

      {activeSheet === 'audio' ? (
        <Sheet title="Audio" onClose={() => setActiveSheet('none')}>
          {embeddedAudio.length === 0 ? (
            <p className="type-secondary text-white/60">No audio tracks found.</p>
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
                  </Sheet>
      ) : null}

      {activeSheet === 'stats' ? (
        <Sheet title="Torrent health" onClose={() => setActiveSheet('none')}>
          <TorrentHealthSheet health={health} speed={healthSpeed} />
        </Sheet>
      ) : null}
    </div>
  );
}

/** Torrent telemetry (desktop TorrentHealthMenu parity): peers, seeders,
 *  speed, buffer-ahead and the downloaded-file progress bar. */
function formatSpeed(bytesPerSecond: number): string {
  const value = Math.max(0, Number(bytesPerSecond) || 0);
  if (value <= 0) return '0 KB/s';
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function TorrentHealthSheet({ health, speed }: { health: TorrentHealthStats | null; speed: number }) {
  const pollingError = health?.pollingError === true;
  const activePeers = Math.max(0, Number(health?.activePeers) || 0);
  const seeders = Math.max(0, Number(health?.connectedSeeders) || 0);
  const totalPeers = Math.max(activePeers, Number(health?.totalPeers) || 0);
  const pendingPeers = Math.max(0, Number(health?.pendingPeers) || 0);
  const targetBytes = Math.max(0, Number(health?.targetBytes) || 0);
  const contiguousAhead = Math.max(0, Number(health?.contiguousAhead) || 0);
  const fileLength = Math.max(0, Number(health?.fileLength) || 0);
  const completedBytes = Math.max(0, Number(health?.completedBytes) || 0);
  const bufferPct = targetBytes > 0 ? Math.min(100, Math.round((contiguousAhead / targetBytes) * 100)) : 0;
  const downloadedPct = fileLength > 0 ? Math.min(100, Math.round((completedBytes / fileLength) * 100)) : 0;
  const stateLabel = pollingError ? 'Waiting for update' : activePeers > 0 ? 'Connected' : 'Connecting';

  return (
    <div>
      <p className="type-secondary text-white/70" role="status">{stateLabel}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Peers" value={activePeers ? String(activePeers) : '—'} detail={totalPeers ? `${totalPeers} known · ${pendingPeers} pending` : undefined} />
        <Metric label="Seeders" value={seeders ? String(seeders) : '—'} />
        <Metric label="Speed" value={formatSpeed(speed)} />
        <Metric label="Buffer ahead" value={`${bufferPct}%`} />
      </div>
      <div className="mt-5">
        <div className="type-secondary flex items-center justify-between text-white/70">
          <span>Downloaded</span>
          <output className="text-numeric text-white">{downloadedPct}%</output>
        </div>
        <div className="mt-2 h-1 w-full rounded-full bg-white/15">
          <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${downloadedPct}%` }} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <p className="type-secondary text-white/60">{label}</p>
      <p className="font-mono text-numeric mt-1 text-lg text-white">{value}</p>
      {detail ? <p className="mt-0.5 truncate text-xs text-white/60">{detail}</p> : null}
    </div>
  );
}

// Bare toolbar icons over the bottom scrim (design-system: icon-only tools,
// 48px targets). Selection uses a filled surface plus aria-pressed, never
// color alone.
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
      title={label}
      onClick={onClick}
      {...(accent ? {} : { 'aria-pressed': active })}
      className={`inline-flex h-12 w-12 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${accent ? 'text-white [&_svg]:fill-current' : active ? 'bg-white text-black' : 'text-white hover:bg-white/10'} [filter:drop-shadow(0_1px_3px_rgb(0_0_0/60%))]`}
    >
      {children}
    </button>
  );
}

// Round centre controls over the dimmed picture (YouTube style). They stop
// the tap from reaching the surface, which would toggle the controls.
function CenterButton({ label, onClick, children, large = false }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerUp={(event) => event.stopPropagation()}
      className={`pointer-events-auto inline-flex items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${large ? 'h-20 w-20' : 'h-14 w-14'}`}
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
      aria-pressed={active}
      className={`min-h-12 max-w-full truncate rounded-lg border px-4 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${active ? 'border-white bg-white text-black' : 'border-white/15 bg-white/[0.03] text-white/80 hover:border-white/35 hover:text-white'}`}
    >
      {children}
    </button>
  );
}

/** Right-side settings panel (~42% width): the video stays visible on the
 *  left; no connection chrome — this surface is about tracks and timing. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-y-0 right-0 z-30 flex w-[42vw] min-w-[300px] max-w-[480px] flex-col border-l border-white/10 bg-[#0a0a0a]/95 pr-[env(safe-area-inset-right)] pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-xl"
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between pl-5 pr-2">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="inline-flex h-12 w-12 items-center justify-center rounded-lg text-white/75 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="app-scrollbar mt-2 flex-1 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  );
}

/** Startup only. Keep mounted for a quiet fade into the native video surface. */
function BufferingLoader({ title, logoUrl, visible, progress }: {
  title: string;
  logoUrl: string | null;
  visible: boolean;
  progress?: number;
}) {
  const [loadedLogo, setLoadedLogo] = useState<string | null>(null);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const imageReady = !!logoUrl && loadedLogo === logoUrl && failedLogo !== logoUrl;
  const known = typeof progress === 'number' && Number.isFinite(progress) && progress > 0;
  const reveal = known ? Math.max(0, Math.min(100, progress)) : 100;
  return (
    <div role={visible ? 'status' : undefined} aria-label={`Loading ${title}`} aria-hidden={!visible} className={`native-loader${visible ? ' native-loader--visible' : ''}`}>
      <div className="native-loader-artwork" data-known-progress={known}>
        {logoUrl && failedLogo !== logoUrl ? <>
          <img className="native-loader-logo native-loader-logo--base" src={logoUrl} alt="" aria-hidden="true"
            style={{ opacity: imageReady ? undefined : 0 }}
            onLoad={() => setLoadedLogo(logoUrl)} onError={() => setFailedLogo(logoUrl)} />
          {imageReady ? <img className="native-loader-logo native-loader-logo--fill" src={logoUrl} alt="" aria-hidden="true"
            style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }} /> : null}
        </> : null}
        {!imageReady ? <span className="native-loader-title">{title}</span> : null}
      </div>
    </div>
  );
}

function DelayRow({ label, value, onAdjust }: { label: string; value: number; onAdjust: (value: number) => void }) {
  const stepClass = 'inline-flex h-12 w-12 items-center justify-center rounded-lg border border-white/20 text-white transition hover:border-white/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <span className="text-sm text-white/85">{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={`${label} earlier`} onClick={() => onAdjust(value - 0.1)} className={stepClass}><Minus className="h-4 w-4" aria-hidden="true" /></button>
        <output className="text-numeric w-16 text-center text-sm text-white">{formatDelay(value)}</output>
        <button type="button" aria-label={`${label} later`} onClick={() => onAdjust(value + 0.1)} className={stepClass}><Plus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" aria-label={`Reset ${label.toLowerCase()} timing`} onClick={() => onAdjust(0)} className="min-h-12 px-2 text-sm text-white/80 underline hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Reset</button>
      </div>
    </div>
  );
}
