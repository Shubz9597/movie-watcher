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
} from './native-playback-controller.ts';
import { getBackendOrigin, subscribeOrigin } from '../lib/connection-service.ts';

/** Shape of the local native plugin (implemented Swift-side / Kotlin-side). */
export interface TorWatchNativePlugin {
  play(options: {
    url: string;
    title: string;
    subtitles: Array<{ url: string; language?: string; label?: string; default?: boolean }>;
    seekTo?: number;
    playId: string;
  }): Promise<void>;
  seek(options: { positionSec: number; playId: string }): Promise<void>;
  dismiss(options: { playId: string }): Promise<void>;
  addListener(eventName: 'timeUpdate', callback: (event: { currentTime: number; duration: number; playId: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'playbackState', callback: (event: { state: string; message?: string; playId: string }) => void): Promise<PluginListenerHandle>;
}

export type PluginListenerHandle = { remove: () => Promise<void> | void };

export function isNativeCapacitor(): boolean {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform() === true;
}

/**
 * The device playback profile sent with every session create (M1.4 repair):
 * iOS -> ios-avplayer, Android -> android-media3, anything else -> ios-avplayer
 * (the conservative shared baseline). Detected EXPLICITLY from Capacitor —
 * never guessed from user agents.
 */
export function devicePlaybackProfile(): string {
  const capacitor = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const platform = typeof capacitor?.getPlatform === 'function' ? capacitor.getPlatform() : 'web';
  return platform === 'android' ? 'android-media3' : 'ios-avplayer';
}

export function createNativePlaybackBridge(plugin: TorWatchNativePlugin): NativePlaybackBridge {
  const timeListeners = new Set<(u: { currentTime: number; duration: number }) => void>();
  const stateListeners = new Set<(u: NativePlaybackState) => void>();
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
    async play(input) {
      await ensureReady();
      currentPlayId = input.playId;
      await plugin.play({
        url: input.url,
        title: input.title,
        subtitles: input.subtitles,
        seekTo: input.seekTo,
        playId: input.playId,
      });
    },
    async seek(positionSec: number, playId: string) {
      if (currentPlayId !== playId) return;
      await plugin.seek({ positionSec, playId });
    },
    onTime(callback) {
      timeListeners.add(callback);
      return () => timeListeners.delete(callback);
    },
    onState(callback) {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
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
      await listenersReady;
      const handles = nativeListenerHandles;
      nativeListenerHandles = [];
      await Promise.all(handles.map((handle) => Promise.resolve(handle.remove())));
    },
  };
}

function bridge(): NativePlaybackBridge {
  return createNativePlaybackBridge(registerPlugin<TorWatchNativePlugin>('TorWatchNative'));
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

  /** Dispose the composition-owned subscription (mobile shell teardown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachOrigin();
    void this.controller.dispose().catch(() => {});
  }
}
