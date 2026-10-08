package torrentx

import (
	"context"
	"log"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
)

// A torrent that stays open for hours slowly runs out of peers: connections
// end, and the engine's own DHT search reruns only every 15 minutes (and
// waits 5 more after an error). Measured on a long-running download: 2
// connected peers at 30 KB/s, while a fresh client on the same swarm found
// 104 peers and finished the episode in 50 s. KeepPeersFlowing tops the peer
// list up while a download needs data.

const (
	peerRefreshInterval = time.Minute
	peerRefreshLowWater = 8               // connected peers below this count as starving
	peerRefreshDuration = 2 * time.Minute // how long one extra DHT search runs
)

// KeepPeersFlowing asks every DHT server for fresh peers whenever t has fewer
// than peerRefreshLowWater connected peers, checking every minute until ctx
// ends. Peers found are added to the torrent by the engine.
func KeepPeersFlowing(ctx context.Context, cl *torrent.Client, t *torrent.Torrent, label string) {
	ticker := time.NewTicker(peerRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		stats := t.Stats()
		if stats.ActivePeers >= peerRefreshLowWater {
			continue
		}
		log.Printf("[stats] %s: %d peers connected, %d known; searching DHT for more", label, stats.ActivePeers, stats.TotalPeers)
		for _, server := range cl.DhtServers() {
			_, stop, err := t.AnnounceToDht(server)
			if err != nil {
				continue
			}
			time.AfterFunc(peerRefreshDuration, stop)
		}
	}
}

// mergeMagnetTrackers adds a magnet's trackers to a torrent that is already
// open (it may have been opened from a bare info hash), so a later, fuller
// magnet still contributes its trackers.
func mergeMagnetTrackers(t *torrent.Torrent, src string) {
	magnet, err := metainfo.ParseMagnetUri(src)
	if err != nil || len(magnet.Trackers) == 0 {
		return
	}
	tiers := make([][]string, 0, len(magnet.Trackers))
	for _, tracker := range magnet.Trackers {
		tiers = append(tiers, []string{tracker})
	}
	t.AddTrackers(tiers)
}
