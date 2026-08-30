// Type definitions for Electron API exposed via preload script
export interface ElectronAPI {
  debugLog?: (...args: any[]) => void;
  // MPV controls
  playInMpv: (payload: { url: string; title: string; magnet?: string; cat?: string; fileIndex?: number; tmdbId?: number; imdbId?: string; malId?: number; anilistId?: number; year?: number; posterUrl?: string | null; subjectId?: string; seriesId?: string; season?: number; episode?: number; absoluteEpisode?: number; sourceName?: string; nextSeason?: number; nextEpisode?: number }) => Promise<{ ok: boolean; streamUrl?: string; resumedFrom?: number; error?: string }>;
  pauseMpv: (paused: boolean) => Promise<{ ok: boolean; error?: string }>;
  seekMpv: (seconds: number, relative?: boolean) => Promise<{ ok: boolean; error?: string }>;
  getMpvState: () => Promise<{ ok: boolean; state?: { time: number; duration: number; paused: boolean; volume: number; mute: boolean; eofReached?: boolean; buffering: boolean; audioDelay: number; subtitleDelay: number }; error?: string }>;
  stopMpv: () => Promise<{ ok: boolean; error?: string }>;
  setVolume: (volume: number) => Promise<{ ok: boolean; error?: string }>;
  setMute: (mute: boolean) => Promise<{ ok: boolean; error?: string }>;
  setAudioDelay: (seconds: number) => Promise<{ ok: boolean; value?: number; error?: string }>;
  setSubtitleDelay: (seconds: number) => Promise<{ ok: boolean; value?: number; error?: string }>;
  cycleAspect: () => Promise<{ ok: boolean; mode?: string; label?: string; error?: string }>;
  isMpvReady: () => Promise<{ ok: boolean; ready: boolean; error?: string }>;
  waitForMpvReady: () => Promise<{ ok: boolean; ready: boolean; error?: string }>;
  // MPV embedding and buffer info
  embedMpv: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; error?: string }>;
  getBufferInfo: (params?: { sse?: boolean }) => Promise<{ ok: boolean; data?: any; error?: string }>;
  loadSubtitle: (url: string) => Promise<{ ok: boolean; error?: string }>;
  setAudioTrack: (index: number) => Promise<{ ok: boolean; error?: string }>;
  setSubtitleTrack: (index: number) => Promise<{ ok: boolean; error?: string }>;
  onMpvStopped: (callback: (event?: { reason?: 'stopped' | 'ended' }) => void) => () => void;
  // Window controls
  toggleFullscreen: () => Promise<{ ok: boolean; fullscreen?: boolean; error?: string }>;
  // Config management
  getConfig: () => Promise<Record<string, any>>;
  setConfig: (config: Record<string, any>) => Promise<{ ok: boolean; error?: string }>;
  openSetup: () => Promise<{ ok: boolean; error?: string }>;
  openTmdbGate: (message: string) => Promise<{ ok: boolean }>;
  openTmdbGuide: () => Promise<{ ok: boolean }>;
  getCatalogState: () => Promise<CatalogState>;
  repairTmdb: (replacement: string) => Promise<{ ok: boolean; error?: string; next?: 'setup' | 'home' }>;
  requestTmdb: <T = unknown>(request: { path: string; params?: Record<string, string> }) => Promise<{ ok: boolean; data?: T; error?: string; status: number; requiresSetup?: boolean }>;
  onCatalogState: (callback: (state: CatalogState) => void) => (() => void) | void;
  getRuntimeState: () => Promise<RuntimeState>;
  retryRuntime: () => Promise<{ ok: boolean; state: RuntimeState }>;
  onRuntimeState: (callback: (state: RuntimeState) => void) => (() => void) | void;
  getDiagnosticLogPaths: () => Promise<{ frontend: string; backend: string; errors: string; directory: string }>;
  openDiagnosticLogs: () => Promise<{ ok: boolean; error?: string }>;
}

export interface RuntimeState {
  status: 'idle' | 'starting' | 'ready' | 'error' | 'setup-required';
  message: string;
  code: string;
}

export interface CatalogState {
  status: 'checking' | 'ready' | 'needs-setup';
  issue: string;
  hasSavedCredential: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}



