// Native downloads bridge (offline-downloads D03): the typed Capacitor
// surface of TorWatchDownloadsPlugin. Only contract-shaped data crosses the
// bridge (ids, safe states, byte counts, titles) — never magnets, provider
// data, or credentials. Local file paths are requested through
// localPlayablePath, which resolves ONLY verified ready downloads.
import type { Plugin } from '@capacitor/core';

export type NativeDownloadState = 'queued' | 'downloading' | 'paused' | 'verifying' | 'ready' | 'failed';

export type NativeDownloadItem = {
  downloadId: string;
  instanceId: string;
  origin: string;
  seriesId: string;
  season: number;
  episode: number;
  title: string;
  posterUrl: string;
  subtitleLabel: string;
  state: NativeDownloadState;
  reason: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  positionS?: number;
  durationS?: number;
  /** When local playback last saved the position (epoch seconds). */
  progressUpdatedAt?: number;
  subtitleLang?: string;
};

export type NativeManifestAsset = {
  path: string;
  sizeBytes: number;
  sha256: string;
  lang?: string;
};

export type NativeEnqueueRequest = {
  downloadId: string;
  instanceId: string;
  origin: string;
  clientId: string;
  seriesId: string;
  season: number;
  episode: number;
  title: string;
  posterUrl?: string;
  subtitleLabel?: string;
  video: NativeManifestAsset;
  subtitles?: NativeManifestAsset[];
};

export interface TorWatchDownloadsPluginInterface extends Plugin {
  isAvailable(): Promise<{ available: boolean }>;
  list(): Promise<{ items: NativeDownloadItem[] }>;
  enqueue(request: NativeEnqueueRequest): Promise<void>;
  pause(options: { downloadId: string }): Promise<void>;
  resume(options: { downloadId: string }): Promise<void>;
  cancel(options: { downloadId: string }): Promise<void>;
  remove(options: { downloadId: string }): Promise<void>;
  storage(): Promise<{ freeBytes: number; usedBytes: number }>;
  saveProgress(options: { downloadId: string; positionS: number; durationS: number; subtitleLang?: string }): Promise<void>;
  loadProgress(options: { downloadId: string }): Promise<{ found: boolean; positionS?: number; durationS?: number; subtitleLang?: string }>;
  localPlayablePath(options: { downloadId: string }): Promise<{ videoPath: string; subtitles: Array<{ lang: string; path: string }> }>;
}
