package janitor

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/torrentx"
)

// cand is a package-level type so it matches pickBest's parameter type.
type cand struct {
	cat  string
	ih   metainfo.Hash
	at   time.Time
	size int64
	name string
}

func Run(ctx context.Context) {
	t := time.NewTicker(2 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			entries, err := torrentx.ListCacheEntries()
			if err != nil {
				log.Printf("[janitor] cannot read cache manifests: %v", err)
				continue
			}

			// Age-based eviction uses durable manifests, so files from torrents
			// loaded by an earlier process are still eligible after restart.
			if config.EvictTTL() > 0 {
				for _, entry := range entries {
					if now.Sub(entry.LastTouched) <= config.EvictTTL() {
						continue
					}
					ih := metainfo.NewHashFromHex(strings.ToUpper(entry.InfoHash))
					if !torrentx.CanDrop(entry.Category, ih) {
						continue
					}
					freed, evictErr := torrentx.EvictCachedInfoHash(entry.Category, ih)
					if evictErr != nil {
						log.Printf("[janitor] failed idle eviction [%s] %s: %v", entry.Category, entry.Name, evictErr)
						continue
					}
					log.Printf("[janitor] evicted idle [%s] %s freed=%d", entry.Category, entry.Name, freed)
				}
			}

			// size-based cap
			max := config.CacheMaxBytes()
			if max <= 0 {
				continue
			}
			used := torrentx.DirSize(config.DataRoot())
			for used > max {
				var cands []cand
				entries, err = torrentx.ListCacheEntries()
				if err != nil {
					log.Printf("[janitor] cannot refresh cache manifests: %v", err)
					break
				}
				for _, entry := range entries {
					ih := metainfo.NewHashFromHex(strings.ToUpper(entry.InfoHash))
					if !torrentx.CanDrop(entry.Category, ih) {
						continue
					}
					cands = append(cands, cand{
						cat:  entry.Category,
						ih:   ih,
						at:   entry.LastTouched,
						size: entry.Size,
						name: entry.Name,
					})
				}
				if len(cands) == 0 {
					log.Printf("[janitor] cache %d > %d but no safe candidate to evict; will retry later", used, max)
					break
				}
				best := pickBest(cands)
				log.Printf("[janitor] evicting [%s] %s ih=%s (age=%s size=%d) | used=%d max=%d",
					best.cat, best.name, best.ih.HexString(),
					time.Since(best.at).Truncate(time.Second), best.size, used, max)
				freed, evictErr := torrentx.EvictCachedInfoHash(best.cat, best.ih)
				if evictErr != nil {
					log.Printf("[janitor] eviction failed [%s] %s: %v", best.cat, best.name, evictErr)
					break
				}
				log.Printf("[janitor] reclaimed %d bytes [%s] %s", freed, best.cat, best.name)
				used = torrentx.DirSize(config.DataRoot())
			}
		}
	}
}

func pickBest(cands []cand) cand {
	best := cands[0]
	for _, x := range cands[1:] {
		older := x.at.Before(best.at)
		closeAge := x.at.Sub(best.at)
		if closeAge < 0 {
			closeAge = -closeAge
		}
		bigger := x.size > best.size
		if older || (closeAge < 2*time.Minute && bigger) {
			best = x
		}
	}
	return best
}
