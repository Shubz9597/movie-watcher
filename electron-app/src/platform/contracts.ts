// Platform runtime boundary (feature 002 M1.2, architecture.md adapter
// contract responsibilities). Interface-only: no implementation, no Electron
// imports, no globals. Each platform supplies one Platform object at its
// composition root; shared code consumes ports through PlatformProvider,
// never through window.electronAPI.

export type ConnectionStatus = 'checking' | 'ready' | 'unreachable' | 'incompatible';

export type ServerCompatibility = {
  status: ConnectionStatus;
  origin: string;
  message?: string;
  serverVersion?: string;
  supportedProtocolRange?: number[];
};

// Connection/config port: validated server origin management plus version
// discovery without Electron prerequisites. On a successful switch the
// implementation must cancel in-flight requests and clear origin-scoped
// caches (connection-service does this for the shared origin).
export interface ConnectionConfig {
  loadOrigin(): Promise<string>;
  saveOrigin(origin: string): Promise<string>;
  check(): Promise<ServerCompatibility>;
  subscribe(listener: (compat: ServerCompatibility) => void): () => void;
}

// Device storage port: stable client identity and preferences with failures
// surfaced. Never stores provider credentials. Household caches are keyed by
// server origin upstream.
export interface DeviceStorage {
  getClientId(): string;
  getPreference(key: string): string | null;
  setPreference(key: string, value: string): void;
  readonly lastError: string | null;
}

// Desktop chrome port: optional Electron-only actions. Mobile/browser
// compositions omit it; shared code must treat absence as normal.
export interface DesktopChrome {
  openSetup(): void;
  openTmdbGuide?(): void;
  repairTmdb?(credential: unknown): Promise<unknown>;
  requestTmdb?<T>(params: { path: string; params?: Record<string, string | number> }): Promise<T>;
  debugLog?(message: string, meta?: Record<string, unknown>): void;
}

// PlayerRequest carries the resolved playback context to the platform player
// (desktop MPV today; the mobile player lands with M1.3 and must record its
// own supported-format matrix — do not infer one from this shape).
export interface PlayerRequest {
  url: string;
  magnet: string;
  title: string;
  cat: string;
  fileIndex?: number;
  tmdbId?: number;
  imdbId?: string;
  anilistId?: number;
  malId?: number;
  year?: number;
  posterUrl?: string | null;
  subjectId?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  sourceName?: string;
  nextSeason?: number;
  nextEpisode?: number;
}

// Player port: start/stop plus stop notifications. Implementations reject
// with actionable, truthful messages when playback is unavailable — never
// fall back to a different transport silently.
export interface PlayerPort {
  start(request: PlayerRequest): Promise<void>;
  stop(): Promise<void>;
  onStopped(callback: (event: { reason?: 'stopped' | 'ended' }) => void): () => void;
}

export type PlatformKind = 'electron' | 'browser' | 'fixture';

export interface Platform {
  kind: PlatformKind;
  connection: ConnectionConfig;
  storage: DeviceStorage;
  desktop?: DesktopChrome;
  player?: PlayerPort;
}
