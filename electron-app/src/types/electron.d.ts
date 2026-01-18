// Type definitions for Electron API exposed via preload script
export interface ElectronAPI {
  debugLog?: (...args: any[]) => void;
  // MPV controls
  playInMpv: (payload: { url: string; title: string; cat?: string; fileIndex?: number; tmdbId?: number; malId?: number }) => Promise<{ ok: boolean; streamUrl?: string; error?: string }>;
  pauseMpv: (paused: boolean) => Promise<{ ok: boolean; error?: string }>;
  seekMpv: (seconds: number, relative?: boolean) => Promise<{ ok: boolean; error?: string }>;
  getMpvState: () => Promise<{ ok: boolean; state?: { time: number; duration: number; paused: boolean; volume: number; mute: boolean }; error?: string }>;
  stopMpv: () => Promise<{ ok: boolean; error?: string }>;
  setVolume: (volume: number) => Promise<{ ok: boolean; error?: string }>;
  setMute: (mute: boolean) => Promise<{ ok: boolean; error?: string }>;
  isMpvReady: () => Promise<{ ok: boolean; ready: boolean; error?: string }>;
  waitForMpvReady: () => Promise<{ ok: boolean; ready: boolean; error?: string }>;
  // MPV embedding and buffer info
  embedMpv: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; error?: string }>;
  getBufferInfo: (params?: { sse?: boolean }) => Promise<{ ok: boolean; data?: any; error?: string }>;
  loadSubtitle: (url: string) => Promise<{ ok: boolean; error?: string }>;
  setAudioTrack: (index: number) => Promise<{ ok: boolean; error?: string }>;
  setSubtitleTrack: (index: number) => Promise<{ ok: boolean; error?: string }>;
  // Window controls
  toggleFullscreen: () => Promise<{ ok: boolean; fullscreen?: boolean; error?: string }>;
  // Config management
  getConfig: () => Promise<Record<string, any>>;
  setConfig: (config: Record<string, any>) => Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}



