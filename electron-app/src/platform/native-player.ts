// Native mobile player (feature 002 M1.4.3/M1.4.4/M1.4.5 shared client side;
// repair pass M1.4).
//
// NativePlayer implements the PlayerPort contract (start/stop/onStopped;
// desktop MPV and the browser staging player keep their behavior). It
// delegates to NativePlaybackController, which owns the server session
// lifecycle, and to the TorWatchNative Capacitor plugin (Swift AVPlayer on
// iOS, Kotlin Media3 on Android).
//
// The bridge NEVER receives magnets, credentials, or server tokens: only the
// opaque playback/subtitle URLs returned by /v2/playback/sessions, a display
// title, and the web-chosen playId (replacement-safety tag).

import { registerPlugin } from '@capacitor/core';
import type { PlayerPort, PlayerRequest } from './contracts.ts';
import { PlaybackSessionClient } from './playback-session-client.ts';
import {
  NativePlaybackController,
  type NativePlaybackBridge,
  type NativeTerminalEvent,
  type NativePlaybackState,
  type NativeTracksUpdate,
  type NativeBufferingUpdate,
} from './native-playback-controller.ts';
import { getBackendOrigin, subscribeOrigin } from '../lib/connection-service.ts';

/** Shape of the local native plugin (implemented Swift-side / Kotlin-side). */
export interface TorWatchNativePlugin {
  prepare?(options: { title: string; playId: string; posterUrl?: string | null }): Promise<void>;
  showError?(options: { message: string; playId: string }): Promise<void>;
  play(options: {
    url: string;
    title: string;
    posterUrl?: string | null;
    logoUrl?: string | null;
    subtitles: Array<{ url: string; language?: string; label?: string; default?: boolean }>;
    seekTo?: number;
    playId: string;
  }): Promise<void>;
  seek(options: { positionSec: number; playId: string }): Promise<void>;
  seekBy?(options: { deltaSeconds: number; playId: string }): Promise<void>;
  togglePlayback?(options: { playId: string }): Promise<void>;
  selectAudioTrack?(options: { trackId: number; playId: string }): Promise<void>;
  selectSubtitleTrack?(options: { trackId: number | null; playId: string }): Promise<void>;
  setSubtitleDelay?(options: { seconds: number; playId: string }): Promise<void>;
  setAudioDelay?(options: { seconds: number; playId: string }): Promise<void>;
  setVideoScale?(options: { mode: 'fit' | 'fill'; playId: string }): Promise<void>;
  setPlaybackOrientation?(options: { landscape: boolean }): Promise<void>;
  loadSubtitle?(options: { url: string; label?: string; language?: string; playId: string }): Promise<{ trackId?: number | null }>;
  dismiss(options: { playId: string }): Promise<void>;
  addListener(eventName: 'timeUpdate', callback: (event: { currentTime: number; duration: number; playId: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'playbackState', callback: (event: { state: string; message?: string; playId: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'tracksUpdate', callback: (event: { audio: Array<{ id: number; label?: string; language?: string }>; subtitles: Array<{ id: number; label?: string; language?: string }>; selectedAudioTrackId?: number | null; selectedSubtitleTrackId?: number | null; playId: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'buffering', callback: (event: { active: boolean; progress?: number; playId: string }) => void): Promise<PluginListenerHandle>;
}

export type PluginListenerHandle = { remove: () => Promise<void> | void };

export function isNativeCapacitor(): boolean {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform() === true;
}

/**
 * The device playback profile sent with every session create (M1.4 repair):
 * the VLC layer (MobileVLCKit / LibVLC) direct-plays the ORIGINAL file, so
 * the -vlc profiles are the mobile surface. iOS -> ios-vlc, Android ->
 * android-vlc, anything else -> ios-vlc (the conservative shared baseline).
 * Detected EXPLICITLY from Capacitor — never guessed from user agents.
 */
export function devicePlaybackProfile(): string {
  const capacitor = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const platform = typeof capacitor?.getPlatform === 'function' ? capacitor.getPlatform() : 'web';
  return platform === 'android' ? 'android-vlc' : 'ios-vlc';
}

export function createNativePlaybackBridge(plugin: TorWatchNativePlugin, supportsPreparation = false): NativePlaybackBridge {
  const timeListeners = new Set<(u: { currentTime: number; duration: number }) => void>();
  const stateListeners = new Set<(u: NativePlaybackState) => void>();
  const trackListeners = new Set<(u: NativeTracksUpdate) => void>();
  const bufferingListeners = new Set<(u: NativeBufferingUpdate) => void>();
  // Replacement safety: the CURRENT playId. Events carrying a different id
  // belong to a replaced (dying) native player and are dropped.
  let currentPlayId = '';
  const accept = (eventPlayId: string | undefined): boolean =>
    currentPlayId !== '' && eventPlayId === currentPlayId;
  const forward = (event: { state: string; message?: string; playId?: string }): void => {
    if (!accept(event.playId)) return;
    const typed: NativePlaybackState =
      event.state === 'ended' ? { state: 'ended', playId: event.playId }
      : event.state === 'error' ? { state: 'error', message: event.message ?? 'The native player reported a playback error.', playId: event.playId }
      : event.state === 'paused' ? { state: 'paused', playId: event.playId }
      : event.state === 'playing' ? { state: 'playing', playId: event.playId }
      : event.state === 'stopped' ? { state: 'stopped', playId: event.playId }
      : { state: 'error', message: 'Unknown native playback state.', playId: event.playId };
    stateListeners.forEach((cb) => cb(typed));
  };
  let disposed = false;
  let listenerError: unknown = null;
  let nativeListenerHandles: PluginListenerHandle[] = [];
  const registrations = [
    plugin.addListener('timeUpdate', (event) => {
      if (!accept(event.playId)) return;
      timeListeners.forEach((cb) => cb(event));
    }).then((handle) => { nativeListenerHandles.push(handle); }),
    plugin.addListener('playbackState', (event) => {
      forward(event as { state: string; message?: string; playId?: string });
    }).then((handle) => { nativeListenerHandles.push(handle); }),
    plugin.addListener('tracksUpdate', (event) => {
      if (!accept(event.playId)) return;
      const update: NativeTracksUpdate = {
        audio: event.audio ?? [],
        subtitles: event.subtitles ?? [],
        selectedAudioTrackId: typeof event.selectedAudioTrackId === 'number' ? event.selectedAudioTrackId : null,
        selectedSubtitleTrackId: typeof event.selectedSubtitleTrackId === 'number' ? event.selectedSubtitleTrackId : null,
        playId: event.playId,
      };
      trackListeners.forEach((cb) => cb(update));
    }).then((handle) => { nativeListenerHandles.push(handle); }),
    plugin.addListener('buffering', (event) => {
      if (!accept(event.playId)) return;
      bufferingListeners.forEach((cb) => cb({
        active: event.active === true,
        progress: typeof event.progress === 'number' ? event.progress : undefined,
        playId: event.playId,
      }));
    }).then((handle) => { nativeListenerHandles.push(handle); }),
  ];
  const listenersReady = Promise.allSettled(registrations).then((results) => {
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    listenerError = failed?.reason ?? null;
  });

  const ensureReady = async (): Promise<void> => {
    await listenersReady;
    if (listenerError) throw listenerError;
    if (disposed) throw new Error('The native playback bridge has been disposed.');
  };

  return {
    ...(supportsPreparation ? {
      async prepare(title: string, playId: string, posterUrl?: string | null) {
        await ensureReady();
        currentPlayId = playId;
        await plugin.prepare!({ title, playId, posterUrl: posterUrl ?? undefined });
      },
      async showError(message: string, playId: string) {
        if (currentPlayId === playId) await plugin.showError!({ message, playId });
      },
    } : {}),
    async play(input) {
      await ensureReady();
      currentPlayId = input.playId;
      await plugin.play({
        url: input.url,
        title: input.title,
        posterUrl: input.posterUrl ?? undefined,
        logoUrl: input.logoUrl ?? undefined,
        subtitles: input.subtitles,
        seekTo: input.seekTo,
        playId: input.playId,
      });
    },
    async seek(positionSec: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.seek({ positionSec, playId });
    },
    async seekBy(deltaSeconds: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.seekBy?.({ deltaSeconds, playId });
    },
    async togglePlayback(playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.togglePlayback?.({ playId });
    },
    async selectAudioTrack(trackId: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.selectAudioTrack?.({ trackId, playId });
    },
    async selectSubtitleTrack(trackId: number | null, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.selectSubtitleTrack?.({ trackId, playId });
    },
    async setSubtitleDelay(seconds: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.setSubtitleDelay?.({ seconds, playId });
    },
    async setAudioDelay(seconds: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.setAudioDelay?.({ seconds, playId });
    },
    async setVideoScale(mode: 'fit' | 'fill', playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.setVideoScale?.({ mode, playId });
    },
    async setPlaybackOrientation(landscape: boolean) {
      await plugin.setPlaybackOrientation?.({ landscape });
    },
    async loadSubtitle(input: { url: string; label?: string; language?: string; playId: string }) {
      if (currentPlayId !== input.playId) throw new Error('Playback is no longer active.');
      if (!plugin.loadSubtitle) throw new Error('This player cannot load subtitles.');
      const result = await plugin.loadSubtitle(input);
      return result?.trackId ?? null;
    },
    onTime(callback) {
      timeListeners.add(callback);
      return () => timeListeners.delete(callback);
    },
    onState(callback) {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
    onTracks(callback) {
      trackListeners.add(callback);
      return () => trackListeners.delete(callback);
    },
    onBuffering(callback) {
      bufferingListeners.add(callback);
      return () => bufferingListeners.delete(callback);
    },
    async dismiss(playId: string) {
      if (currentPlayId !== playId) return;
      currentPlayId = '';
      await plugin.dismiss({ playId });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      currentPlayId = '';
      timeListeners.clear();
      stateListeners.clear();
      trackListeners.clear();
      bufferingListeners.clear();
      await listenersReady;
      const handles = nativeListenerHandles;
      nativeListenerHandles = [];
      await Promise.all(handles.map((handle) => Promise.resolve(handle.remove())));
    },
  };
}

function bridge(): NativePlaybackBridge {
  // The VLC layer renders BEHIND the Capacitor WebView and the web layer owns
  // every control surface, so the modal native prepare screen is retired:
  // loading/buffering UI is web-rendered (poster overlay + server progress).
  return createNativePlaybackBridge(registerPlugin<TorWatchNativePlugin>('TorWatchNative'), false);
}

export class NativePlayer implements PlayerPort {
  private readonly controller: NativePlaybackController;
  private readonly detachOrigin: () => void;
  private disposed = false;

  constructor() {
    const client = new PlaybackSessionClient({
      getOrigin: getBackendOrigin,
      // M1.4 repair: the platform-explicit capability profile.
      profile: devicePlaybackProfile(),
    });
    this.controller = new NativePlaybackController({ client, bridge: bridge() });
    // M1.4.6: a server-origin change must stop native playback and delete
    // (or abandon) the old session BEFORE the shared stores clear. The
    // connection service fires subscribers on every explicit origin switch.
    this.detachOrigin = subscribeOrigin(() => {
      void this.controller.stop().catch(() => {});
    });
  }

  async start(request: PlayerRequest): Promise<void> {
    await this.controller.start(request);
  }

  async stop(): Promise<void> {
    await this.controller.stop();
  }

  onStopped(callback: (event: NativeTerminalEvent) => void): () => void {
    return this.controller.onStopped(callback);
  }

  // --- M1.4.7 VLC interactive surface (delegated to the controller; every
  // method is a safe no-op outside an active playback).

  seekBy(deltaSeconds: number): void {
    this.controller.seekBy(deltaSeconds);
  }

  seekTo(positionSec: number): void {
    this.controller.seekTo(positionSec);
  }

  togglePlayback(): void {
    this.controller.togglePlayback();
  }

  subscribeTime(listener: (update: { currentTime: number; duration: number }) => void): () => void {
    return this.controller.subscribeTime(listener);
  }

  subscribeState(listener: (state: 'playing' | 'paused') => void): () => void {
    return this.controller.subscribeState(listener);
  }

  selectAudioTrack(trackId: number): void {
    this.controller.selectAudioTrack(trackId);
  }

  selectSubtitleTrack(trackId: number | null): void {
    this.controller.selectSubtitleTrack(trackId);
  }

  setSubtitleDelay(seconds: number): void {
    this.controller.setSubtitleDelay(seconds);
  }

  setAudioDelay(seconds: number): void {
    this.controller.setAudioDelay(seconds);
  }

  setVideoScale(mode: 'fit' | 'fill'): void {
    this.controller.setVideoScale(mode);
  }

  setPlaybackOrientation(landscape: boolean): void {
    this.controller.setPlaybackOrientation(landscape);
  }

  loadSubtitle(input: { url: string; label?: string; language?: string }): Promise<number | null> {
    return this.controller.loadSubtitle(input);
  }

  subscribeTracks(listener: (update: NativeTracksUpdate) => void): () => void {
    return this.controller.subscribeTracks(listener);
  }

  subscribeBuffering(listener: (update: NativeBufferingUpdate) => void): () => void {
    return this.controller.subscribeBuffering(listener);
  }

  /** Dispose the composition-owned subscription (mobile shell teardown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachOrigin();
    void this.controller.dispose().catch(() => {});
  }
}
