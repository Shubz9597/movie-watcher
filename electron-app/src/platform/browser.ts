// Browser adapter (M1.2): the browser development/preview entry's platform.
// Origin comes from the `?server=` URL parameter, persisted localStorage
// preference (`mw_server_origin`), or the build-time default — in that
// order. Switching origins re-checks compatibility and emits subscribers.
// No window.electronAPI is touched anywhere in this adapter.
import type { ConnectionConfig, DeviceStorage, PlayerPort, PlayerRequest, ServerCompatibility } from './contracts.ts'
import { probeBackendOrigin } from './electron.ts'
import { getBackendOrigin, setBackendOrigin } from '../lib/connection-service.ts'
import { getDeviceId } from '../lib/device-id.ts'
import { browserProgressContext, buildBrowserStreamUrl, type BrowserProgressContext } from './browser-player-core.ts'

const SERVER_ORIGIN_KEY = 'mw_server_origin';

// BrowserPlayer is the mobile-web adapter. It intentionally uses the native
// HTML5 media stack: MP4/H.264/AAC can direct-play on iOS, while unsupported
// torrent containers/codecs fail visibly and remain an M1.3 device-matrix
// result rather than being silently transcoded or claimed as supported.
export class BrowserPlayer implements PlayerPort {
  private overlay: HTMLDivElement | null = null;
  private video: HTMLVideoElement | null = null;
  private heartbeat: number | null = null;
  private callbacks = new Set<(event: { reason?: 'stopped' | 'ended' }) => void>();
  private progress: BrowserProgressContext | null = null;
  // Session token: incremented by every start()/stop() so an async
  // continuation from a replaced session (late resume lookup, in-flight
  // save) can never mutate or resurrect the CURRENT player session.
  private sessionToken = 0;
  // The session that already fired its stopped/ended callbacks (exactly once).
  private finishedSession = 0;
  // In-flight progress POSTs of the CURRENT session; aborted on teardown so a
  // replaced or closed session can never deliver a stale position.
  private sessionFetches = new Set<AbortController>();

  async start(request: PlayerRequest): Promise<void> {
    await this.stop();
    const session = ++this.sessionToken;

    const origin = getBackendOrigin();
    const streamUrl = buildBrowserStreamUrl(origin, request);
    this.progress = browserProgressContext(request);

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `Playing ${request.title}`);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:#050505;color:white;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom));';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 4px 12px;';
    const heading = document.createElement('strong');
    heading.textContent = request.title || 'TorWatch player';
    heading.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 15px/1.3 system-ui,sans-serif;';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close player');
    close.style.cssText = 'min-width:48px;min-height:48px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:#151515;color:white;padding:0 14px;font:600 14px system-ui,sans-serif;';
    header.append(heading, close);

    const stage = document.createElement('div');
    stage.style.cssText = 'position:relative;display:flex;min-height:0;flex:1;align-items:center;justify-content:center;overflow:hidden;border-radius:12px;background:#000;';
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.cssText = 'width:100%;height:100%;max-height:100%;object-fit:contain;background:#000;';
    const status = document.createElement('p');
    status.textContent = 'Connecting to peers…';
    status.setAttribute('role', 'status');
    status.style.cssText = 'position:absolute;left:12px;right:12px;bottom:58px;margin:0;padding:9px 12px;border-radius:8px;background:rgba(0,0,0,.78);color:rgba(255,255,255,.86);text-align:center;font:500 13px/1.4 system-ui,sans-serif;pointer-events:none;';
    stage.append(video, status);
    overlay.append(header, stage);
    document.body.append(overlay);
    this.overlay = overlay;
    this.video = video;

    close.addEventListener('click', () => {
      void this.finish('stopped');
    });
    video.addEventListener('loadstart', () => {
      status.textContent = 'Connecting to peers…';
    });
    video.addEventListener('waiting', () => {
      status.textContent = 'Buffering from peers…';
    });
    video.addEventListener('canplay', () => {
      status.textContent = 'Ready — tap play if playback did not start automatically.';
    });
    video.addEventListener('playing', () => {
      status.style.display = 'none';
    });
    video.addEventListener('pause', () => {
      if (!video.ended) void this.saveProgress();
    });
    video.addEventListener('ended', () => {
      void this.finish('ended');
    });
    video.addEventListener('error', () => {
      status.style.display = 'block';
      status.textContent = 'This source could not play in the phone browser. Try an MP4/H.264 source; MKV and some audio codecs require the later native-device compatibility work.';
    });

    // Attach the stream FIRST so buffering starts immediately; the resume
    // lookup runs concurrently and only seeks once metadata has arrived.
    // (A blocking lookup used to delay playback by up to its 2.5s timeout.)
    video.src = streamUrl;

    this.heartbeat = window.setInterval(() => {
      void this.saveProgress();
    }, 10_000);
    void video.play().catch(() => {
      if (this.sessionToken === session) {
        status.textContent = 'Ready when buffered — tap the Play control to begin.';
      }
    });

    // Resume: bounded, non-blocking, session-guarded. A response that arrives
    // after the session was replaced or stopped is dropped (its video element
    // is already detached, so applying it would mutate a dead element at best).
    void this.fetchResumePosition().then((resumePosition) => {
      if (this.sessionToken !== session || resumePosition <= 0) return;
      const applyResume = () => {
        if (this.sessionToken !== session) return;
        if (resumePosition < video.duration - 5) {
          video.currentTime = resumePosition;
        }
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) applyResume();
      else video.addEventListener('loadedmetadata', applyResume, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.sessionToken++;
    // Final save completes first; teardown then aborts any OTHER in-flight
    // heartbeats so nothing from this session outlives it.
    await this.saveProgress();
    this.teardown();
  }

  onStopped(callback: (event: { reason?: 'stopped' | 'ended' }) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private async finish(reason: 'stopped' | 'ended'): Promise<void> {
    // Exactly once per session: a Close click racing the 'ended' event (or a
    // second event from the dying element) must not fire callbacks twice and
    // must not create a route loop back into the player.
    const session = this.sessionToken;
    if (session === 0 || this.finishedSession === session) return;
    this.finishedSession = session;
    this.sessionToken++;
    await this.saveProgress();
    this.teardown();
    for (const callback of Array.from(this.callbacks)) callback({ reason });
  }

  private teardown(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.abortSessionFetches();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.overlay?.remove();
    this.video = null;
    this.overlay = null;
    this.progress = null;
  }

  private async fetchResumePosition(): Promise<number> {
    if (!this.progress) return 0;
    const params = new URLSearchParams({
      subjectId: this.progress.subjectId,
      seriesId: this.progress.seriesId,
      season: String(this.progress.season),
      episode: String(this.progress.episode),
    });
    try {
      const response = await fetch(`${getBackendOrigin()}/v1/resume?${params.toString()}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return 0;
      const payload = await response.json();
      const position = Number(payload?.position_s || 0);
      return payload?.found === true && Number.isFinite(position) && position > 0 ? position : 0;
    } catch {
      return 0;
    }
  }

  private async saveProgress(): Promise<void> {
    const video = this.video;
    const progress = this.progress;
    if (!video || !progress || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) return;
    // Bounded AND session-bound: teardown/finish aborts the in-flight POST so
    // a replaced or closed session can never deliver a stale position.
    const abort = new AbortController();
    this.sessionFetches.add(abort);
    try {
      await fetch(`${getBackendOrigin()}/v1/session/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectId: progress.subjectId,
          seriesId: progress.seriesId,
          season: progress.season,
          episode: progress.episode,
          position_s: Math.floor(video.currentTime),
          duration_s: Math.floor(video.duration),
          sourceUri: progress.sourceUri,
          sourceName: progress.sourceName,
          sourceKind: progress.sourceKind,
          sourceFileIndex: progress.sourceFileIndex,
          nextSeason: progress.nextSeason,
          nextEpisode: progress.nextEpisode,
        }),
        signal: typeof (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any === 'function'
          ? (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any([abort.signal, AbortSignal.timeout(2500)])
          : AbortSignal.timeout(2500),
      });
    } catch {
      // Aborted (session replaced) or timed out/failed: nothing actionable;
      // the next heartbeat retries while the session is alive.
    } finally {
      this.sessionFetches.delete(abort);
    }
  }

  private abortSessionFetches(): void {
    for (const controller of Array.from(this.sessionFetches)) controller.abort();
    this.sessionFetches.clear();
  }
}

export class BrowserStorage implements DeviceStorage {
  lastError: string | null = null;
  getClientId(): string {
    return getDeviceId();
  }
  getPreference(key: string): string | null {
    this.lastError = null;
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      this.lastError = String(error);
      return null;
    }
  }
  setPreference(key: string, value: string): void {
    this.lastError = null;
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      this.lastError = String(error);
      console.warn('[Platform/Browser] Preference persistence failed:', error);
    }
  }
}

export class BrowserConnection implements ConnectionConfig {
  private listeners = new Set<(compat: ServerCompatibility) => void>();
  private current: ServerCompatibility;

  constructor(private readonly storage: DeviceStorage, initialOrigin: string) {
    this.current = { status: 'checking', origin: initialOrigin };
    // M1.4 repair: initialize the connection service's backend origin ONCE at
    // construction. Without this, getBackendOrigin() (used by ALL API calls)
    // returns the default — and my check() fix (which no longer calls
    // applyOrigin) meant setBackendOrigin was never reached.
    if (initialOrigin) {
      setBackendOrigin(initialOrigin);
    }
  }

  async loadOrigin(): Promise<string> {
    return this.current.origin;
  }

  async saveOrigin(origin: string): Promise<string> {
    this.storage.setPreference(SERVER_ORIGIN_KEY, origin);
    return this.applyOrigin(origin);
  }

  private async applyOrigin(origin: string): Promise<string> {
    // Drive the shared origin service first: buildBackendUrl, request
    // cancellation and origin-scoped caches follow the switch immediately.
    const normalized = setBackendOrigin(origin);
    console.debug('[Platform/Browser] applying origin', normalized);
    this.current = { status: 'checking', origin: normalized };
    this.emit();
    this.current = await probeBackendOrigin(normalized);
    console.debug('[Platform/Browser] probe result', this.current.status);
    this.emit();
    return this.current.origin;
  }

  async check(): Promise<ServerCompatibility> {
    // M1.4 repair (flash fix): a health re-check must NOT re-apply the
    // origin. applyOrigin bumps the connection-service generation (which
    // cancels in-flight requests and fires origin-switch listeners — killing
    // native playback) and emits 'checking', which unmounted the app to the
    // launch screen on every re-check. A check only PROBES and emits.
    const probed = await probeBackendOrigin(this.current.origin);
    this.current = probed;
    this.emit();
    return this.current;
  }

  subscribe(listener: (compat: ServerCompatibility) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener(this.current);
  }
}

// resolveBrowserOrigin: URL parameter wins (explicit, shareable), then the
// persisted preference, then the build-time default.
export function resolveBrowserOrigin(search: string): string {
  const params = new URLSearchParams(search);
  const fromUrl = params.get('server');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  try {
    const stored = window.localStorage.getItem(SERVER_ORIGIN_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // storage unavailable — fall through to the default
  }
  return '';
}
