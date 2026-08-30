export type PlayerState = {
  ready?: boolean;
  videoFormat?: string;
  time: number;
  duration: number;
  paused: boolean;
  volume: number;
  mute: boolean;
  buffering: boolean;
  audioDelay: number;
  subtitleDelay: number;
};

export type PlaybackIdentity = {
  title?: string;
  kind?: string;
  year?: number;
  posterUrl?: string | null;
  season?: number;
  episode?: number;
  episodeCode?: string;
  episodeLabel?: string;
};

export type SkipSegment = {
  type: 'recap' | 'intro' | 'credits';
  start: number;
  end: number;
};

export type SubtitleTrack = {
  source?: 'torrent' | 'opensub' | string;
  lang?: string;
  fileName?: string;
  format?: string;
  downloadCount?: number;
  trusted?: boolean;
  hearingImpaired?: boolean;
  movieHashMatched?: boolean;
  url: string;
};

export type SubtitleState = {
  status: 'loading' | 'ready' | 'error';
  source: string;
  tracks: SubtitleTrack[];
  message?: string;
  providerConfigured?: boolean;
};

export type TorrentHealth = {
  sourceId?: string;
  infoHash?: string;
  sampledAt?: number;
  activePeers?: number;
  connectedSeeders?: number;
  totalPeers?: number;
  pendingPeers?: number;
  contiguousAhead?: number;
  targetBytes?: number;
  fileLength?: number;
  completedBytes?: number;
  downloadedBytes?: number;
  downloadSpeed?: number;
  pollingError?: boolean;
  polledAt?: number;
};

export type PlayerBridge = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
};
