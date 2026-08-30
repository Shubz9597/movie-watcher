import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Activity,
  ArrowLeft,
  Captions,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { LoadingOverlay } from './components/LoadingOverlay';
import { SubtitleMenu } from './components/SubtitleMenu';
import { SyncMenu } from './components/SyncMenu';
import { TorrentHealthMenu } from './components/TorrentHealthMenu';
import type { PlaybackIdentity, PlayerBridge, PlayerState, SkipSegment, SubtitleState, SubtitleTrack, TorrentHealth } from './types';
import { clamp, episodeCodeFromIdentity, formatTime, skipSegmentsFromPayload } from './player-utils';

const HUD_AUTO_HIDE_MS = 2600;
const INITIAL_SKIP_PROMPT_MS = 5000;
const POLL_INTERVAL_MS = 250;
const EMPTY_SUBTITLE_STATE: SubtitleState = { status: 'loading', source: 'none', tracks: [], message: '', providerConfigured: true };

type MenuName = 'health' | 'subtitle' | 'sync' | null;

type Props = {
  bridge: PlayerBridge;
};

const DEFAULT_PLAYER_STATE: PlayerState = {
  time: 0,
  duration: 0,
  paused: true,
  volume: 1,
  mute: false,
  buffering: false,
  audioDelay: 0,
  subtitleDelay: 0,
};

export function PlayerControlsApp({ bridge }: Props) {
  const [state, setState] = useState<PlayerState>(DEFAULT_PLAYER_STATE);
  const [identity, setIdentity] = useState<PlaybackIdentity>({ title: 'TorWatch' });
  const [hudVisible, setHudVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [loadingState, setLoadingState] = useState({ status: 'Finding peers', percentage: 0, failed: false });
  const [skipSegments, setSkipSegments] = useState<SkipSegment[]>([]);
  const [skipPromptDismissed, setSkipPromptDismissed] = useState(false);
  const [skipPromptRevealed, setSkipPromptRevealed] = useState(false);
  const [skipSeekInFlight, setSkipSeekInFlight] = useState(false);
  const [activeMenu, setActiveMenu] = useState<MenuName>(() => (
    new URLSearchParams(location.search).get('subtitles') === 'missing' ? 'subtitle' : null
  ));
  const [subtitleState, setSubtitleState] = useState<SubtitleState>(EMPTY_SUBTITLE_STATE);
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [loadingSubtitleUrl, setLoadingSubtitleUrl] = useState<string | null>(null);
  const [health, setHealth] = useState<TorrentHealth>({});
  const [aspectToast, setAspectToast] = useState('');
  const [bufferingReason, setBufferingReason] = useState('Buffering');
  const hideTimerRef = useRef<number | null>(null);
  const aspectToastTimerRef = useRef<number | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const pendingDragPointRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const dragFrameRef = useRef<number>(0);
  const subtitleSelectionRef = useRef(0);
  const skipPromptTimerRef = useRef<number | null>(null);

  const episodeCode = identity.episodeCode || episodeCodeFromIdentity(identity.season, identity.episode);
  const episodeLabel = identity.episodeLabel || (
    episodeCode && Number.isInteger(identity.season) && Number.isInteger(identity.episode)
      ? `Season ${identity.season}, Episode ${identity.episode}`
      : ''
  );

  const activeSkipSegment = useMemo(() => {
    if (!playbackStarted || skipPromptDismissed || !skipPromptRevealed) return null;
    const currentTime = Number(state.time) || 0;
    const priority = { recap: 0, intro: 1, credits: 2 };
    return skipSegments
      .filter((segment) => currentTime >= segment.start && currentTime < segment.end - 0.5)
      .sort((left, right) => priority[left.type] - priority[right.type])[0] || null;
  }, [playbackStarted, skipPromptDismissed, skipPromptRevealed, skipSegments, state.time]);

  const showHud = useCallback(() => {
    setHudVisible(true);
    if (playbackStarted && skipSegments.length > 0) setSkipPromptRevealed(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (activeMenu === null && playbackStarted && !state.paused) setHudVisible(false);
    }, HUD_AUTO_HIDE_MS);
  }, [activeMenu, playbackStarted, skipSegments.length, state.paused]);

  const invokeSafely = useCallback(async <T,>(channel: string, ...args: unknown[]): Promise<T | null> => {
    try {
      return await bridge.invoke<T>(channel, ...args);
    } catch (error) {
      console.error('[PlayerControls]', error);
      return null;
    }
  }, [bridge]);

  const stopPlayback = useCallback(async () => {
    await invokeSafely('mpv:stop');
  }, [invokeSafely]);

  const togglePlay = useCallback(async () => {
    const nextPaused = !state.paused;
    setState((current) => ({ ...current, paused: nextPaused }));
    const result = await invokeSafely<{ ok: boolean; error?: string }>('mpv:pause', nextPaused);
    if (!result?.ok) setState((current) => ({ ...current, paused: !nextPaused }));
  }, [invokeSafely, state.paused]);

  const seekRelative = useCallback(async (seconds: number) => {
    await invokeSafely('mpv:seek', seconds, true);
    showHud();
  }, [invokeSafely, showHud]);

  const seekAbsolute = useCallback(async (seconds: number) => {
    const target = clamp(seconds, 0, state.duration || 0);
    setState((current) => ({ ...current, time: target }));
    await invokeSafely('mpv:seek', target, false);
    showHud();
  }, [invokeSafely, showHud, state.duration]);

  const setVolume = useCallback(async (volume: number) => {
    const nextVolume = clamp(volume, 0, 1);
    setState((current) => ({ ...current, volume: nextVolume, mute: nextVolume === 0 }));
    await invokeSafely('mpv:setVolume', nextVolume);
  }, [invokeSafely]);

  const toggleMute = useCallback(async () => {
    const nextMute = !state.mute;
    setState((current) => ({ ...current, mute: nextMute }));
    await invokeSafely('mpv:setMute', nextMute);
  }, [invokeSafely, state.mute]);

  const setSyncDelay = useCallback(async (kind: 'audio' | 'subtitle', value: number) => {
    const next = Math.round(clamp(value, -30, 30) * 10) / 10;
    const field = kind === 'audio' ? 'audioDelay' : 'subtitleDelay';
    const channel = kind === 'audio' ? 'mpv:setAudioDelay' : 'mpv:setSubtitleDelay';
    setState((current) => ({ ...current, [field]: next }));
    await invokeSafely(channel, next);
  }, [invokeSafely]);

  const toggleFullscreen = useCallback(async () => {
    const result = await invokeSafely<{ ok: boolean; fullscreen?: boolean }>('window:toggleFullscreen');
    if (result?.ok && typeof result.fullscreen === 'boolean') setIsFullscreen(result.fullscreen);
  }, [invokeSafely]);

  const cycleAspect = useCallback(async () => {
    const result = await invokeSafely<{ ok: boolean; label?: string }>('mpv:cycleAspect');
    if (result?.ok) {
      setAspectToast(`Aspect - ${result.label || 'Changed'}`);
      if (aspectToastTimerRef.current) window.clearTimeout(aspectToastTimerRef.current);
      aspectToastTimerRef.current = window.setTimeout(() => setAspectToast(''), 1400);
    }
  }, [invokeSafely]);

  const chooseSubtitle = useCallback(async (track: SubtitleTrack) => {
    const selection = subtitleSelectionRef.current + 1;
    subtitleSelectionRef.current = selection;
    setLoadingSubtitleUrl(track.url);
    const result = await invokeSafely<{ ok: boolean; error?: string }>('mpv:loadSub', { url: track.url, format: track.format || 'srt' });
    if (selection !== subtitleSelectionRef.current) return;
    setLoadingSubtitleUrl(null);
    if (result?.ok) setActiveSubtitleUrl(track.url);
  }, [invokeSafely]);

  const disableSubtitles = useCallback(async () => {
    subtitleSelectionRef.current += 1;
    setLoadingSubtitleUrl(null);
    await invokeSafely('mpv:setSub', -1);
    setActiveSubtitleUrl(null);
  }, [invokeSafely]);

  const configureOpenSubtitles = useCallback(async (apiKey: string) => {
    const result = await invokeSafely<{ ok: boolean; error?: string }>('subtitles:configure-provider', apiKey);
    return result || { ok: false, error: 'OpenSubtitles could not be connected.' };
  }, [invokeSafely]);

  const openOpenSubtitlesGuide = useCallback(() => {
    void invokeSafely('setup:open-opensubtitles-guide');
  }, [invokeSafely]);

  const sendPendingDrag = useCallback(() => {
    dragFrameRef.current = 0;
    if (!pendingDragPointRef.current) return;
    bridge.send('window:dragMove', pendingDragPointRef.current);
    pendingDragPointRef.current = null;
  }, [bridge]);

  const beginWindowDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (isFullscreen) return;
    dragPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    bridge.send('window:dragStart', { screenX: event.screenX, screenY: event.screenY });
  }, [bridge, isFullscreen]);

  const moveWindowDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    pendingDragPointRef.current = { screenX: event.screenX, screenY: event.screenY };
    if (!dragFrameRef.current) dragFrameRef.current = window.requestAnimationFrame(sendPendingDrag);
  }, [sendPendingDrag]);

  const endWindowDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    if (pendingDragPointRef.current) bridge.send('window:dragMove', pendingDragPointRef.current);
    pendingDragPointRef.current = null;
    dragPointerIdRef.current = null;
    bridge.send('window:dragEnd');
  }, [bridge]);

  useEffect(() => {
    window.renderPlaybackIdentity = (data: unknown) => {
      const next = data && typeof data === 'object' ? data as PlaybackIdentity : {};
      flushSync(() => {
        setIdentity({ title: 'Playing', ...next });
      });
    };
    return () => {
      delete window.renderPlaybackIdentity;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = [
      bridge.on('mpv:fullscreen', (fullscreen) => setIsFullscreen(Boolean(fullscreen))),
      bridge.on('mpv:title', (title) => setIdentity((current) => ({ ...current, title: String(title || 'Playing') }))),
      bridge.on('mpv:identity', (data) => window.renderPlaybackIdentity?.(data)),
      bridge.on('mpv:skipSegments', (data) => setSkipSegments(skipSegmentsFromPayload(data) as SkipSegment[])),
      bridge.on('mpv:loadingMeta', (data) => {
        window.renderPlaybackIdentity?.(data);
        setPlaybackStarted(false);
        setHudVisible(true);
        setState(DEFAULT_PLAYER_STATE);
        setSkipSegments([]);
        setSkipPromptDismissed(false);
        setSkipPromptRevealed(false);
        setActiveMenu(null);
        setSubtitleState(EMPTY_SUBTITLE_STATE);
        subtitleSelectionRef.current += 1;
        setActiveSubtitleUrl(null);
        setLoadingSubtitleUrl(null);
        setHealth({});
        setAspectToast('');
        setBufferingReason('Buffering');
      }),
      bridge.on('mpv:loadingState', (data) => {
        const next = data && typeof data === 'object' ? data as { status?: string; percentage?: number; failed?: boolean } : {};
        setLoadingState({
          status: next.status || 'Finding peers',
          percentage: Number(next.percentage) || 0,
          failed: Boolean(next.failed),
        });
      }),
      bridge.on('mpv:playbackLoaded', () => {
        setPlaybackStarted(true);
        setHudVisible(true);
        setSkipPromptRevealed(false);
        if (skipPromptTimerRef.current) window.clearTimeout(skipPromptTimerRef.current);
        skipPromptTimerRef.current = window.setTimeout(() => {
          skipPromptTimerRef.current = null;
          setSkipPromptDismissed(false);
        }, INITIAL_SKIP_PROMPT_MS);
      }),
      bridge.on('mpv:torrentHealth', (data) => {
        const next = data && typeof data === 'object' ? data as TorrentHealth : {};
        setHealth((current) => {
          const sameSource = Boolean(next.sourceId && next.sourceId === current.sourceId);
          const nextSampledAt = Number(next.sampledAt) || 0;
          const currentSampledAt = Number(current.sampledAt) || 0;
          const elapsedSeconds = (nextSampledAt - currentSampledAt) / 1000;
          const downloadedDelta = Number(next.downloadedBytes) - Number(current.downloadedBytes);
          const downloadSpeed = sameSource && elapsedSeconds > 0 && downloadedDelta >= 0
            ? downloadedDelta / elapsedSeconds
            : nextSampledAt > 0 ? 0 : current.downloadSpeed;
          return { ...current, ...next, downloadSpeed };
        });
      }),
      bridge.on('mpv:subtitleTracks', (data) => setSubtitleState(data && typeof data === 'object' ? data as SubtitleState : EMPTY_SUBTITLE_STATE)),
    ];
    return () => {
      unsubscribe.forEach((remove) => remove());
      if (skipPromptTimerRef.current) window.clearTimeout(skipPromptTimerRef.current);
      skipPromptTimerRef.current = null;
    };
  }, [bridge]);

  useEffect(() => {
    document.documentElement.classList.toggle('is-fullscreen', isFullscreen);
  }, [isFullscreen]);

  useEffect(() => () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (aspectToastTimerRef.current) window.clearTimeout(aspectToastTimerRef.current);
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', showHud);
    return () => document.removeEventListener('mousemove', showHud);
  }, [showHud]);

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      button?.blur();
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => document.removeEventListener('pointerup', onPointerUp);
  }, []);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const isInteractive = Boolean(target?.closest('button, a[href], input, select, textarea, [role="slider"], [contenteditable="true"]'));
      if (isInteractive && !['Escape', ' ', 'Spacebar'].includes(event.key)) return;
      if (event.key === ' ' || event.code === 'Space' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        await togglePlay();
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        await seekRelative(-10);
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        await seekRelative(10);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        await seekRelative(event.shiftKey ? 1 : 10);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        await seekRelative(event.shiftKey ? -1 : -10);
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        await toggleFullscreen();
      } else if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        await cycleAspect();
      } else if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        setActiveMenu((current) => current === 'subtitle' ? null : 'subtitle');
      } else if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        await setSyncDelay(event.shiftKey ? 'audio' : 'subtitle', (event.shiftKey ? state.audioDelay : state.subtitleDelay) - 0.1);
      } else if (event.key.toLowerCase() === 'x') {
        event.preventDefault();
        await setSyncDelay(event.shiftKey ? 'audio' : 'subtitle', (event.shiftKey ? state.audioDelay : state.subtitleDelay) + 0.1);
      } else if (event.key === 'Escape') {
        setActiveMenu(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cycleAspect, seekRelative, setSyncDelay, state.audioDelay, state.subtitleDelay, toggleFullscreen, togglePlay]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const poll = async () => {
      const result = await invokeSafely<{ ok: boolean; state?: Partial<PlayerState> }>('mpv:state');
      if (active && result?.ok && result.state) {
        setState((current) => ({ ...current, ...result.state }));
        if (result.state.buffering) setBufferingReason('Buffering');
      }
      if (active) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [invokeSafely]);

  const seekToPointer = (clientX: number, element: HTMLElement | null) => {
    if (!element || state.duration <= 0) return;
    const rect = element.getBoundingClientRect();
    seekAbsolute((clamp((clientX - rect.left) / rect.width, 0, 1)) * state.duration);
  };

  const volumeToPointer = (clientX: number, element: HTMLElement | null) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setVolume(clamp((clientX - rect.left) / rect.width, 0, 1));
  };

  const handleTimelineKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 1 : 10;
    if (event.key === 'Home') {
      event.preventDefault();
      void seekAbsolute(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      void seekAbsolute(state.duration);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      void seekRelative(-step);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      void seekRelative(step);
    }
  };

  const handleVolumeKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 0.01 : 0.05;
    if (event.key === 'Home') {
      event.preventDefault();
      void setVolume(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      void setVolume(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      void setVolume(effectiveVolume - step);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      void setVolume(effectiveVolume + step);
    }
  };

  const progressPercentage = state.duration > 0 ? clamp((state.time / state.duration) * 100, 0, 100) : 0;
  const effectiveVolume = state.mute ? 0 : clamp(state.volume, 0, 1);
  const loadingStatus = loadingState.failed
    ? loadingState.status
    : ({ connecting: 'Finding peers', buffering: 'Buffering video', ready: 'Starting video' }[loadingState.status] || loadingState.status);

  return (
    <>
      <div className="click-catcher" id="clickCatcher" onMouseMove={showHud} onClick={togglePlay} onDoubleClick={toggleFullscreen} />
      <div className={`aspect-toast${aspectToast ? ' visible' : ''}`} id="aspectToast" role="status" aria-live="polite">{aspectToast}</div>
      <div className={`buffering-toast${state.buffering ? ' visible' : ''}`} id="bufferingToast" role="status" aria-live="polite">{bufferingReason}</div>
      <LoadingOverlay
        identity={identity}
        failed={loadingState.failed}
        percentage={loadingState.percentage}
        playbackStarted={playbackStarted}
        status={loadingStatus}
        onClose={stopPlayback}
        onDragStart={beginWindowDrag}
        onDragMove={moveWindowDrag}
        onDragEnd={endWindowDrag}
      />
      <div className={`hud${hudVisible ? '' : ' hidden'}`} id="hud" onMouseMove={showHud}>
        <div className="top-bar">
          <div className="now-playing">
            <button className="icon-btn back-to-title tooltip" id="closeBtn" data-tooltip="Back to title" aria-label="Stop playback and return to title" onClick={stopPlayback}><ArrowLeft aria-hidden="true" /></button>
            <div className="now-playing-copy">
              <div className="eyebrow">Now playing</div>
              <div className="title-line">
                <div className="title" id="titleText">{identity.title || 'TorWatch'}</div>
                <div className="episode-code" id="episodeCode" hidden={!episodeCode} aria-label={episodeLabel}>{episodeCode}</div>
              </div>
            </div>
          </div>
          <div
            className="window-drag-surface"
            id="windowDragSurface"
            title="Drag player window"
            aria-hidden="true"
            onPointerDown={beginWindowDrag}
            onPointerMove={moveWindowDrag}
            onPointerUp={endWindowDrag}
            onPointerCancel={endWindowDrag}
            onLostPointerCapture={endWindowDrag}
          >
            <span className="window-drag-grip" />
          </div>
        </div>

        <div className="bottom-panel">
          <div
            className="timeline-wrap"
            id="progressBar"
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(state.duration))}
            aria-valuenow={Math.max(0, Math.round(state.time))}
            aria-valuetext={`${formatTime(state.time)} of ${formatTime(state.duration)}`}
            tabIndex={0}
            onKeyDown={handleTimelineKeyDown}
            onMouseDown={(event) => seekToPointer(event.clientX, event.currentTarget)}
          >
            <div className="timeline">
              <div className="timeline-fill" id="progressFill" style={{ width: `${progressPercentage}%` }} />
              <div className="timeline-thumb" id="timelineThumb" style={{ left: `${progressPercentage}%` }} />
            </div>
          </div>
          <div className="control-row">
            <button className="icon-btn primary tooltip" id="playBtn" data-tooltip="Play / pause - Space or K" aria-label="Play or pause (Space or K)" onClick={togglePlay}>{state.paused ? <Play aria-hidden="true" fill="currentColor" /> : <Pause aria-hidden="true" fill="currentColor" />}</button>
            <button className="icon-btn tooltip" id="backBtn" data-tooltip="Back 10 seconds - J" aria-label="Seek backward 10 seconds (J)" onClick={() => seekRelative(-10)}><RotateCcw aria-hidden="true" /></button>
            <button className="icon-btn tooltip" id="forwardBtn" data-tooltip="Forward 10 seconds - L" aria-label="Seek forward 10 seconds (L)" onClick={() => seekRelative(10)}><RotateCw aria-hidden="true" /></button>
            <div className="volume-control">
              <button className="icon-btn tooltip" id="muteBtn" data-tooltip={state.mute || effectiveVolume === 0 ? 'Unmute' : 'Mute'} aria-label={state.mute || effectiveVolume === 0 ? 'Unmute' : 'Mute'} onClick={toggleMute}>{state.mute || effectiveVolume === 0 ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</button>
              <div
                className="volume-slider"
                id="volumeSlider"
                role="slider"
                tabIndex={0}
                aria-label="Volume"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(effectiveVolume * 100)}
                aria-valuetext={`${Math.round(effectiveVolume * 100)} percent`}
                onKeyDown={handleVolumeKeyDown}
                onMouseDown={(event) => volumeToPointer(event.clientX, event.currentTarget)}
              >
                <div className="volume-track"><div className="volume-fill" id="volumeFill" style={{ width: `${effectiveVolume * 100}%` }} /></div>
              </div>
            </div>
            <div className="time" id="timeDisplay">{formatTime(state.time)} <span>/</span> {formatTime(state.duration)}</div>
            <div className="control-spacer" />
            <div className="track-menu-wrap">
              <button className="icon-btn tooltip" id="healthBtn" data-tooltip="Torrent health" aria-label="Show torrent health" aria-expanded={activeMenu === 'health'} aria-controls="healthMenu" data-health="connecting" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'health' ? null : 'health'); }}><Activity aria-hidden="true" /></button>
              {activeMenu === 'health' ? <TorrentHealthMenu health={health} /> : null}
            </div>
            <div className="track-menu-wrap">
              <button className="icon-btn tooltip" id="subtitleBtn" data-tooltip="Subtitles - C" aria-label="Choose subtitles (C)" aria-expanded={activeMenu === 'subtitle'} aria-controls="subtitleMenu" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'subtitle' ? null : 'subtitle'); }}><Captions aria-hidden="true" /></button>
              {activeMenu === 'subtitle' ? <SubtitleMenu activeSubtitleUrl={activeSubtitleUrl} loadingSubtitleUrl={loadingSubtitleUrl} state={subtitleState} onChoose={chooseSubtitle} onDisable={disableSubtitles} onConfigure={configureOpenSubtitles} onOpenGuide={openOpenSubtitlesGuide} /> : null}
            </div>
            <div className="track-menu-wrap">
              <button className="icon-btn tooltip" id="syncBtn" data-tooltip="Playback sync - Z / X" aria-label="Adjust audio and subtitle timing" aria-expanded={activeMenu === 'sync'} aria-controls="syncMenu" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'sync' ? null : 'sync'); }}><SlidersHorizontal aria-hidden="true" /></button>
              {activeMenu === 'sync' ? <SyncMenu audioDelay={state.audioDelay} subtitleDelay={state.subtitleDelay} onChange={setSyncDelay} /> : null}
            </div>
            <button className="icon-btn tooltip" id="fullscreenBtn" data-tooltip={isFullscreen ? 'Exit full screen - F' : 'Full screen - F'} aria-label="Toggle full screen (F)" onClick={toggleFullscreen}>{isFullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}</button>
          </div>
        </div>
      </div>
      <button
        className={`segment-skip${activeSkipSegment ? ' visible' : ''}`}
        id="segmentSkipBtn"
        type="button"
        aria-label="Skip intro"
        aria-hidden={activeSkipSegment ? 'false' : 'true'}
        tabIndex={activeSkipSegment ? 0 : -1}
        disabled={!activeSkipSegment || skipSeekInFlight}
        onClick={async () => {
          if (!activeSkipSegment) return;
          setSkipSeekInFlight(true);
          await seekAbsolute(activeSkipSegment.end);
          setSkipPromptDismissed(true);
          setSkipSeekInFlight(false);
        }}
      >
        <span id="segmentSkipLabel">Skip {activeSkipSegment?.type || 'intro'}</span>
      </button>
    </>
  );
}
