import type { TorrentHealth } from '../types';

type Props = {
  health: TorrentHealth;
};

function formatBytes(bytes?: number) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value <= 0) return '0 KB/s';
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

export function TorrentHealthMenu({ health }: Props) {
  const activePeers = Math.max(0, Number(health.activePeers) || 0);
  const seeders = Math.max(0, Number(health.connectedSeeders) || 0);
  const totalPeers = Math.max(activePeers, Number(health.totalPeers) || 0);
  const pendingPeers = Math.max(0, Number(health.pendingPeers) || 0);
  const targetBytes = Math.max(0, Number(health.targetBytes) || 0);
  const contiguousAhead = Math.max(0, Number(health.contiguousAhead) || 0);
  const fileLength = Math.max(0, Number(health.fileLength) || 0);
  const completedBytes = Math.max(0, Number(health.completedBytes) || 0);
  const downloadSpeed = Math.max(0, Number(health.downloadSpeed) || 0);
  const bufferPercentage = targetBytes > 0 ? Math.min(100, Math.max(0, (contiguousAhead / targetBytes) * 100)) : 0;
  const downloadedPercentage = fileLength > 0 ? Math.min(100, Math.max(0, (completedBytes / fileLength) * 100)) : 0;
  const pollingError = health.pollingError === true;
  const tone = pollingError ? 'warning' : activePeers > 0 ? 'healthy' : 'connecting';
  const stateLabel = pollingError ? 'Updating' : activePeers > 0 ? 'Live' : 'Connecting';
  const advice = pollingError
    ? 'Waiting for the next torrent update...'
    : activePeers > 0
      ? downloadSpeed > 0 ? 'Downloading while you watch.' : 'Connected with playback data buffered.'
      : 'Connecting to the torrent network...';

  return (
    <div className="track-menu health-menu" id="healthMenu" role="dialog" aria-label="Torrent health">
      <div className="health-head">
        <div>
          <div className="health-title">Torrent health</div>
          <div className="health-advice" id="healthAdvice">
            {advice}
          </div>
        </div>
        <div className="health-state" id="healthState" data-tone={tone}>{stateLabel}</div>
      </div>
      <div className="health-grid">
        <div className="health-metric">
          <div className="health-label">Connected peers</div>
          <div className="health-value" id="healthPeers">{activePeers || '--'}</div>
          <div className="health-detail" id="healthPeerDetail">{totalPeers ? `${totalPeers} known, ${pendingPeers} pending` : 'Searching'}</div>
        </div>
        <div className="health-metric">
          <div className="health-label">Connected seeders</div>
          <div className="health-value" id="healthSeeders">{seeders || '--'}</div>
          <div className="health-detail">Sending complete pieces</div>
        </div>
        <div className="health-metric">
          <div className="health-label">Download speed</div>
          <div className="health-value" id="healthSpeed">{formatBytes(downloadSpeed)}</div>
          <div className="health-detail">Current rate</div>
        </div>
        <div className="health-metric">
          <div className="health-label">Buffer ahead</div>
          <div className="health-value" id="healthBuffer">{Math.round(bufferPercentage)}%</div>
          <div className="health-detail" id="healthBufferDetail">Building buffer</div>
        </div>
      </div>
      <div className="health-progress">
        <div className="health-progress-copy"><span>File available · live</span><output id="healthDownloaded">{Math.round(downloadedPercentage)}%</output></div>
        <div className="health-progress-track"><div className="health-progress-fill" id="healthProgressFill" style={{ width: `${downloadedPercentage}%` }} /></div>
      </div>
    </div>
  );
}
