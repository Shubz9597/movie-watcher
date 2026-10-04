// What the server is doing for a download it is still preparing, as the
// one-line status the Downloads row shows (BitTorrent-client style).

export type PreparingProgress = {
  stage: 'queued' | 'metadata' | 'subtitles' | 'downloading' | 'finalizing';
  peers?: number;
  seeders?: number;
  knownPeers?: number;
  bytesDone?: number;
  bytesTotal?: number;
  rateBps?: number;
  queuedAhead?: number;
};

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Fraction of the episode the server has, when it is downloading. */
export function preparingFraction(progress: PreparingProgress | undefined): number | null {
  if (!progress || progress.stage !== 'downloading' || !progress.bytesTotal) return null;
  return Math.min(1, Math.max(0, (progress.bytesDone ?? 0) / progress.bytesTotal));
}

export function describePreparing(progress: PreparingProgress | undefined): string {
  if (!progress) return 'Preparing';
  const peers = progress.peers ?? 0;
  const seeders = progress.seeders ?? 0;
  switch (progress.stage) {
    case 'queued':
      return progress.queuedAhead
        ? `Queued · ${progress.queuedAhead} ahead`
        : 'Queued · starts after the current download';
    case 'metadata':
      if (peers > 0) return `Getting torrent info · ${plural(peers, 'peer')}`;
      if (progress.knownPeers) return `Connecting · ${progress.knownPeers} peers found`;
      return 'Searching DHT and trackers for peers';
    case 'subtitles':
      return 'Fetching subtitles';
    case 'downloading': {
      const fraction = preparingFraction(progress) ?? 0;
      const percent = `${Math.floor(fraction * 100)}%`;
      if (peers === 0) return `Waiting for peers · ${percent}`;
      const swarm = seeders > 0 ? `${plural(peers, 'peer')} (${seeders} seeding)` : plural(peers, 'peer');
      const rate = progress.rateBps ? ` · ${formatRate(progress.rateBps)}` : '';
      return `Server downloading · ${percent}${rate} · ${swarm}`;
    }
    case 'finalizing':
      return 'Verifying file';
  }
  return 'Preparing';
}
