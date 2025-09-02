package janitor

import (
	"context"
	"log"
	"time"

	"github.com/anacrolix/torrent"
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

			// age-based drop
			if config.EvictTTL() > 0 {
				torrentx.ForEachClient(func(cat string, c *torrent.Client) {
					for _, tt := range c.Torrents() {
						if last, ok := torrentx.GetLastTouch(cat, tt.InfoHash()); ok && now.Sub(last) > config.EvictTTL() {
							if !torrentx.CanDrop(cat, tt.InfoHash()) {
								continue
							}
							log.Printf("[janitor] dropping idle [%s] %s", cat, tt.Name())
							tt.Drop()
							torrentx.ClearTouch(cat, tt.InfoHash())
						}
					}
				})
			}

			// size-based cap
			max := config.CacheMaxBytes()
			if max <= 0 {
				continue
			}
			used := torrentx.DirSize(config.DataRoot())
			for used > max {
				var cands []cand

				torrentx.ForEachClient(func(cat string, c *torrent.Client) {
					for _, tt := range c.Torrents() {
						ih := tt.InfoHash()
						if !torrentx.CanDrop(cat, ih) {
							continue
						}
						at, _ := torrentx.GetLastTouch(cat, ih)
						var sz int64
						for _, f := range tt.Files() {
							sz += f.Length()
						}
						cands = append(cands, cand{
							cat:  cat,
							ih:   ih,
							at:   at,
							size: sz,
							name: tt.Name(),
						})
					}
				})
				if len(cands) == 0 {
					log.Printf("[janitor] cache %d > %d but no safe candidate to evict; will retry later", used, max)
					break
				}
				best := pickBest(cands)
				torrentx.ForEachClient(func(cat string, c *torrent.Client) {
					if cat != best.cat {
						return
					}
					for _, tt := range c.Torrents() {
						if tt.InfoHash() == best.ih {
							log.Printf("[janitor] evicting [%s] %s ih=%s (age=%s size=%d) | used=%d max=%d",
								best.cat, best.name, best.ih.HexString(),
								time.Since(best.at).Truncate(time.Second), best.size, used, max)
							tt.Drop()
							return
						}
					}
				})
				torrentx.ClearTouch(best.cat, best.ih)
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
