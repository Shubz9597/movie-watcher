// NativePlaybackController (feature 002 M1.4.3/M1.4.7).
//
// Orchestrates the SERVER session lifecycle around a native player bridge
// (iOS AVPlayer / Android Media3 via Capacitor). Responsibilities:
//   - create a session via the shared client (NEVER a magnet),
//   - hand ONLY opaque URLs + non-sensitive metadata to the bridge,
//   - stream native time events into bounded /v1/session/heartbeat writes,
//   - restore a CONFIRMED resume position without delaying media attachment
//     (seek arrives after the player started),
//   - DELETE the session on explicit close / ended / unrecoverable error /
//     superseded playback,
//   - guarantee exactly-once terminal events and stale-callback immunity
//     (generation counter; late events from a replaced session are dropped).

import {
  PlaybackClientError,
  PlaybackSessionClient,
  type PlaybackSession,
} from './playback-session-client.ts';
import type { PlayerRequest } from './contracts.ts';

export type NativeBridgeTrack = {
  url: string;
  language?: string;
  label?: string;
  default?: boolean;
};

export type NativePlaybackInput = {
  url: string; // opaque playback URL from the session (direct media or HLS master)
  title: string;
  subtitles: NativeBridgeTrack[];
  seekTo?: number; // confirmed resume position in seconds
  // Replacement-safety tag echoed by every native event; events carrying a
  // different id belong to a replaced player and are dropped by the bridge.
  playId: string;
};

export type NativeTimeUpdate = { currentTime: number; duration: number; playId?: string };
export type NativePlaybackState =
  | { state: 'playing' | 'paused'; playId?: string }
  | { state: 'ended'; playId?: string }
  // The USER dismissed the native player UI (Done button / back gesture).
  // Semantically identical to an explicit stop: the controller deletes the
  // server session and emits exactly one 'stopped' terminal event.
  | { state: 'stopped'; playId?: string }
  | { state: 'error'; message: string; playId?: string };

export type NativePlaybackBridge = {
  prepare?(title: string, playId: string): Promise<void>;
  showError?(message: string, playId: string): Promise<void>;
  play(input: NativePlaybackInput): Promise<void>;
  seek(positionSec: number, playId: string): Promise<void>;
  onTime(callback: (update: NativeTimeUpdate) => void): () => void;
  onState(callback: (update: NativePlaybackState) => void): () => void;
  dismiss(playId: string): Promise<void>;
  dispose?(): Promise<void>;
};

export type NativeControllerDeps = {
  client: PlaybackSessionClient;
  bridge: NativePlaybackBridge;
  /** Bounded heartbeat cadence. */
  heartbeatMs?: number;
  now?: () => number;
};

const DEFAULT_HEARTBEAT_MS = 10_000;

export type NativeTerminalEvent = { reason: 'stopped' | 'ended' | 'error'; message?: string };

export class NativePlaybackController {
  private readonly client: PlaybackSessionClient;
  private readonly bridge: NativePlaybackBridge;
  private readonly heartbeatMs: number;

  // Generation guards: any async continuation from a superseded playback
  // (late time events, stale heartbeats, old state callbacks) is dropped.
  private generation = 0;
  // Replacement-safety tag: native events carry the playId they belong to;
  // events tagged with a DIFFERENT id come from a replaced (dying) player and
  // are dropped. Undefined playIds are accepted for bridge compatibility.
  private currentPlayId = '';
  private session: PlaybackSession | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private detachTime: (() => void) | null = null;
  private detachState: (() => void) | null = null;
  private terminalFiredGeneration = -1;
  // During teardown the generation is already invalidated, but the FINAL
  // bounded progress write for the dying session must still be allowed.
  private flushingGeneration = -1;
  private lastPositionSec = 0;
  private lastDurationSec = 0;
  private disposed = false;

  private request: PlayerRequest | null = null;
  private listeners = new Set<(event: NativeTerminalEvent) => void>();

  constructor(deps: NativeControllerDeps) {
    this.client = deps.client;
    this.bridge = deps.bridge;
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /** Register a terminal-event listener (PlayerPort.onStopped shape). */
  onStopped(callback: (event: NativeTerminalEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Replacement-safety filter: an event tagged with a different playId comes
   * from a replaced (dying) native player. Undefined playIds are accepted for
   * simple bridges that do not tag events.
   */
  private eventBelongsToCurrentPlay(playId: string | undefined): boolean {
    return playId === undefined || playId === this.currentPlayId;
  }

  /** Full start: plan -> session -> native playback. Throws typed errors. */
  async start(request: PlayerRequest): Promise<PlaybackSession> {
    if (this.disposed) {
      throw new PlaybackClientError('invalid', 'The native player has been disposed.');
    }
    // Supersede any current playback SILENTLY: the caller is starting new
    // playback, not dismissing the old one -- no terminal event fires here.
    await this.teardown(/* notify */ false);
    const generation = ++this.generation;
    const playId = String(generation);
    this.lastPositionSec = 0;
    this.lastDurationSec = 0;

    if (this.bridge.prepare) {
      this.currentPlayId = playId;
      this.request = request;
      this.attachBridgeListeners(generation);
      try {
        await this.bridge.prepare(request.title || 'TorWatch', playId);
      } catch (error) {
        if (generation === this.generation) await this.teardown(false);
        throw error;
      }
      if (generation !== this.generation) {
        await this.bridge.dismiss(playId);
        throw new PlaybackClientError('network', 'Playback was cancelled.');
      }
    }

    let session: PlaybackSession;
    try {
      session = await this.client.create({
        cat: request.cat || 'movie',
        sourceId: infoHashFromSource(request),
        fileIndex: request.fileIndex ?? 0,
      });
    } catch (error) {
      if (generation === this.generation && this.bridge.prepare) {
        await this.bridge.showError?.(error instanceof PlaybackClientError ? error.message : 'Could not prepare this source. Choose another source and try again.', playId);
      }
      throw error;
    }
    if (generation !== this.generation) {
      // Superseded while planning: release immediately.
      await this.client.delete(session.sessionId);
      throw new PlaybackClientError('network', 'Playback was replaced while starting.');
    }
    if (session.mode === 'unsupported') {
      // M1.4 repair: an unsupported plan is a NEW server session that must
      // be released immediately — it is never playable.
      await this.client.delete(session.sessionId);
      if (this.bridge.prepare) await this.bridge.showError?.(session.message, playId);
      throw new PlaybackClientError('planning', session.message, session.reasonCode);
    }

    this.session = session;
    this.request = request;
    this.lastPositionSec = 0;
    this.lastDurationSec = 0;
    this.currentPlayId = playId;

    // Media attaches IMMEDIATELY; resume is confirmed concurrently and seeks
    // afterwards so a slow lookup never delays playback start.
    try {
      await this.bridge.play({
        url: this.client.resolve(session.playbackUrl),
        title: request.title || 'TorWatch',
        subtitles: session.subtitles.map((track) => ({
          url: this.client.resolve(track.url),
          language: track.language,
          label: track.label,
          default: track.default,
        })),
        playId,
      });
    } catch (error) {
      // A stale start owns only its playId and server session. It must never
      // clear or dismiss a replacement that became current while play() was
      // pending.
      if (this.ownsPlayback(generation, session.sessionId, playId)) {
        this.stopTimersAndListeners();
        this.session = null;
        this.request = null;
        this.currentPlayId = '';
      }
      this.bridge.dismiss(playId).catch(() => {});
      await this.client.delete(session.sessionId);
      if (generation !== this.generation) {
        throw new PlaybackClientError('network', 'Playback was replaced while starting.');
      }
      if (error instanceof PlaybackClientError) throw error;
      throw new PlaybackClientError('network', 'The native player could not start playback.');
    }
    if (generation !== this.generation) {
      // Superseded while the bridge was starting: release only this start's
      // resources. Shared controller state now belongs to the replacement.
      this.bridge.dismiss(playId).catch(() => {});
      await this.client.delete(session.sessionId);
      return session;
    }

    this.attachBridgeListeners(generation);
    this.startHeartbeat(generation);
    void this.confirmResumeAndSeek(generation);
    return session;
  }

  /**
   * Explicit stop from the consumer (PlayerPort.stop): final bounded progress
   * flush, session DELETE, native dismissal, then exactly one 'stopped'
   * terminal event when a session was actually active.
   */
  async stop(): Promise<void> {
    await this.teardown(/* notify */ true);
  }

  /** Release controller, native bridge, and terminal listeners exactly once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.teardown(/* notify */ false);
    this.listeners.clear();
    await this.bridge.dispose?.();
  }

  private ownsPlayback(generation: number, sessionId: string, playId: string): boolean {
    return generation === this.generation &&
      this.session?.sessionId === sessionId &&
      this.currentPlayId === playId;
  }

  /** Shared teardown. notify=false when superseding via start(). */
  private async teardown(notify: boolean): Promise<void> {
    const hadSession = this.session !== null || this.currentPlayId !== '';
    const generation = ++this.generation;
    this.flushingGeneration = generation;
    this.stopTimersAndListeners();
    const session = this.session;
    const playId = this.currentPlayId;
    this.session = null;
    this.currentPlayId = '';
    const request = this.request;
    this.request = null;
    try {
      await this.flushProgress(generation, request);
    } catch {
      // A failed final flush must never block dismissal.
    }
    this.flushingGeneration = -1;
    // Only dismiss when something was actually handed to the native player;
    // a bare supersede-start with no prior session must not touch the bridge.
    if (hadSession) {
      await this.bridge.dismiss(playId).catch(() => {});
      if (session) await this.client.delete(session.sessionId);
      if (notify) this.fireTerminal(generation, { reason: 'stopped' });
    }
  }

  /** Player-reported terminal states route here exactly once. */
  private handleBridgeState(update: NativePlaybackState, generation: number): void {
    if (generation !== this.generation) return;
    if (update.state === 'error') {
      this.fireErrorAndCleanup(generation, update.message || 'The native player reported a playback error.');
      return;
    }
    if (update.state === 'ended') {
      void this.finishNaturally(generation);
      return;
    }
    if (update.state === 'stopped') {
      // Native-UI dismissal: same terminal path as an explicit stop.
      void this.teardown(/* notify */ true);
    }
    // playing/paused: no terminal action. A PAUSE triggers an immediate
    // bounded progress write (the repair-pass contract: pause persists —
    // periodic heartbeats alone do not cover a user who pauses and walks
    // away with the device).
    if (update.state === 'paused') {
      void this.flushProgress(generation, this.request).catch(() => {});
    }
  }

  private async finishNaturally(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.generation++; // invalidate pending continuations
    this.flushingGeneration = generation; // allow this session's final write
    this.stopTimersAndListeners();
    const session = this.session;
    const playId = this.currentPlayId;
    this.session = null;
    this.currentPlayId = '';
    const request = this.request;
    this.request = null;
    try {
      await this.flushProgress(generation, request);
    } catch {
      // bounded best-effort
    }
    this.bridge.dismiss(playId).catch(() => {});
    if (session) await this.client.delete(session.sessionId);
    this.fireTerminal(generation, { reason: 'ended' });
  }

  private fireErrorAndCleanup(generation: number, message: string): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.flushingGeneration = generation; // attempt a durable final write
    this.stopTimersAndListeners();
    const session = this.session;
    const playId = this.currentPlayId;
    this.session = null;
    this.currentPlayId = '';
    const request = this.request;
    void this.flushProgress(generation, request).catch(() => {}).finally(() => {
      this.flushingGeneration = -1;
    });
    this.bridge.dismiss(playId).catch(() => {});
    if (session) void this.client.delete(session.sessionId);
    this.fireTerminal(generation, { reason: 'error', message });
  }

  private attachBridgeListeners(generation: number): void {
    this.detachTime?.();
    this.detachState?.();
    this.detachTime = this.bridge.onTime((update) => {
      if (generation !== this.generation) return;
      if (!this.eventBelongsToCurrentPlay(update.playId)) return;
      this.lastPositionSec = update.currentTime;
      this.lastDurationSec = update.duration;
    });
    this.detachState = this.bridge.onState((update) => {
      if (generation !== this.generation) return;
      if (!this.eventBelongsToCurrentPlay(update.playId)) return;
      this.handleBridgeState(update, generation);
    });
  }

  private startHeartbeat(generation: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (generation !== this.generation) {
        this.stopHeartbeat();
        return;
      }
      void this.flushProgress(generation, this.request).catch(() => {
        // bounded writes tolerate transient network loss; the next tick retries
      });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopTimersAndListeners(): void {
    this.stopHeartbeat();
    this.detachTime?.();
    this.detachState?.();
    this.detachTime = null;
    this.detachState = null;
  }

  /** One bounded progress write. Stale sessions never write. */
  private async flushProgress(generation: number, request: PlayerRequest | null): Promise<void> {
    // A generation mismatch is fine when THIS is the sanctioned teardown
    // flush (flushingGeneration); anything else is stale and dropped.
    if ((generation !== this.generation && generation !== this.flushingGeneration) || !request) return;
    const context = progressContext(request);
    if (!context) return;
    if (!Number.isFinite(this.lastDurationSec) || this.lastDurationSec <= 0) return; // duration unknown yet
    const body = JSON.stringify({
      subjectId: context.subjectId,
      seriesId: context.seriesId,
      season: context.season,
      episode: context.episode,
      position_s: Math.floor(this.lastPositionSec),
      duration_s: Math.floor(this.lastDurationSec),
      sourceUri: context.sourceUri,
      sourceName: context.sourceName,
      sourceKind: context.sourceKind,
      sourceFileIndex: context.sourceFileIndex,
      nextSeason: context.nextSeason,
      nextEpisode: context.nextEpisode,
    });
    await this.client.request('/v1/session/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(2500),
    });
  }

  /** Resume lookup (bounded, non-blocking) + native seek when confirmed. */
  private async confirmResumeAndSeek(generation: number): Promise<void> {
    const request = this.request;
    const context = request ? progressContext(request) : null;
    if (!context) return;
    try {
      const response = await this.client.request(
        `/v1/resume?${new URLSearchParams({
          subjectId: context.subjectId,
          seriesId: context.seriesId,
          season: String(context.season),
          episode: String(context.episode),
        })}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) },
      );
      if (generation !== this.generation || !response.ok) return;
      const payload = (await response.json()) as { found?: boolean; position_s?: number };
      const position = Number(payload?.position_s || 0);
      if (payload?.found === true && Number.isFinite(position) && position > 5) {
        if (generation !== this.generation) return;
        await this.bridge.seek(position, this.currentPlayId);
      }
    } catch {
      // Resume is an optimization; failure never blocks playback.
    }
  }

  private fireTerminal(generation: number, event: NativeTerminalEvent): void {
    if (generation === this.terminalFiredGeneration) return; // exactly once
    this.terminalFiredGeneration = generation;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // listener errors must not re-enter the lifecycle
      }
    }
  }
}

// Progress context mirrors the desktop/browser heartbeat contract
// (/v1/session/heartbeat; session.go field names).
type ProgressContext = {
  subjectId: string;
  seriesId: string;
  season: number;
  episode: number;
  sourceUri: string;
  sourceName: string;
  sourceKind: string;
  sourceFileIndex: number | null;
  nextSeason: number | null;
  nextEpisode: number | null;
};

function progressContext(request: PlayerRequest): ProgressContext | null {
  const subjectId = String(request.subjectId || '').trim();
  const seriesId = String(request.seriesId || '').trim();
  const season = Number(request.season ?? 0);
  const episode = Number(request.episode ?? 0);
  if (!subjectId || !seriesId || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
    return null;
  }
  const fileIndex = Number(request.fileIndex);
  const nextSeason = Number(request.nextSeason);
  const nextEpisode = Number(request.nextEpisode);
  const hasNext =
    Number.isInteger(nextSeason) && Number.isInteger(nextEpisode) &&
    nextSeason >= 0 && nextEpisode > 0 &&
    (nextSeason !== season || nextEpisode !== episode);
  return {
    subjectId,
    seriesId,
    season,
    episode,
    // The heartbeat contract stores the SOURCE URI, but the native path never
    // carries magnets: the server-side session owns the source. Store the
    // opaque series identifier for resume re-resolution instead.
    sourceUri: seriesId,
    sourceName: String(request.sourceName || '').trim(),
    sourceKind: String(request.cat || '').trim(),
    sourceFileIndex: Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : null,
    nextSeason: hasNext ? nextSeason : null,
    nextEpisode: hasNext ? nextEpisode : null,
  };
}

// PlayerRequest may arrive with a magnet in url/magnet (desktop shape). The
// native client must send ONLY the 40-hex identifier; extraction is explicit
// and fails closed when absent.
export function infoHashFromSource(request: PlayerRequest): string {
  for (const candidate of [request.magnet, request.url]) {
    const match = /urn:btih:([0-9a-fA-F]{40})/i.exec(String(candidate || ''));
    if (match) return match[1];
  }
  throw new PlaybackClientError('invalid', 'The selected source did not provide a valid torrent identifier for native playback.');
}
