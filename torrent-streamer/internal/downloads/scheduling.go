package downloads

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/torrentx"
)

// Scheduling the preparations of a queue (a 61-episode Kai season, say):
//
//   - Every waiting or running job's torrent keeps its data: the cache's
//     clean-up skips it. Before, a job's torrent was protected only while it
//     ran; between two jobs a 60 GB batch over the 20 GB cache had its pack
//     removed while the engine still recorded the pieces complete, and
//     S2E59/60 were packaged as zeros.
//   - Two jobs run at once only from different torrents. The same torrent's
//     next jobs are read ahead instead: their files download in the
//     background while the running one is copied, checked and given
//     subtitles (a minute or two per episode in which nothing downloaded).

// readAheadPerTorrent: how many waiting episodes of a running torrent
// download ahead.
const readAheadPerTorrent = 2

// readAheadMargin: free space kept beyond what read-ahead needs.
const readAheadMargin = 4 << 30

// PreparingSource is a waiting or running job and its source.
type PreparingSource struct {
	JobID      string
	Claimed    bool
	InfoHash   string // lower-case hex
	Magnet     string
	SourceKind string
	FileIndex  *int
}

// PreparingSources lists every preparing job, oldest first.
func (s *Store) PreparingSources(ctx context.Context) ([]PreparingSource, error) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT j.id, j.claimed_by <> '', p.infohash, p.magnet, p.source_kind, p.file_index
FROM download_jobs j JOIN picks p ON p.id = j.pick_id
WHERE j.state = $1
ORDER BY j.created_at`, StatePreparing)
	if err != nil {
		return nil, fmt.Errorf("list preparing sources: %w", err)
	}
	defer rows.Close()
	var out []PreparingSource
	for rows.Next() {
		var src PreparingSource
		var fileIndex sql.NullInt64
		if err := rows.Scan(&src.JobID, &src.Claimed, &src.InfoHash, &src.Magnet, &src.SourceKind, &fileIndex); err != nil {
			return nil, err
		}
		src.InfoHash = strings.ToLower(src.InfoHash)
		if fileIndex.Valid {
			index := int(fileIndex.Int64)
			src.FileIndex = &index
		}
		out = append(out, src)
	}
	return out, rows.Err()
}

func sourceKey(cat, infoHash string) string {
	return torrentx.Category(cat) + "|" + strings.ToLower(infoHash)
}

// protection is the set of torrents waiting or running jobs need.
type protection struct {
	mu   sync.RWMutex
	keys map[string]bool
}

func (p *protection) set(keys map[string]bool) {
	p.mu.Lock()
	p.keys = keys
	p.mu.Unlock()
}

func (p *protection) has(cat string, ih metainfo.Hash) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.keys[sourceKey(cat, ih.HexString())]
}

// schedulePlan is what one admission pass decides.
type schedulePlan struct {
	protected map[string]bool   // torrents waiting or running jobs need
	claim     []string          // jobs to start now
	readAhead []PreparingSource // waiting jobs to fetch in the background
}

// plan: up to capacity jobs to start, none sharing a torrent with a running
// job or with each other (oldest first); the next readAheadPerTorrent
// waiting jobs of each running torrent read ahead.
func plan(sources []PreparingSource, capacity int) schedulePlan {
	out := schedulePlan{protected: map[string]bool{}}
	busy := map[string]bool{}
	for _, src := range sources {
		key := sourceKey(src.SourceKind, src.InfoHash)
		out.protected[key] = true
		if src.Claimed {
			busy[key] = true
		}
	}
	for _, src := range sources {
		if len(out.claim) >= capacity {
			break
		}
		key := sourceKey(src.SourceKind, src.InfoHash)
		if src.Claimed || busy[key] {
			continue
		}
		out.claim = append(out.claim, src.JobID)
		busy[key] = true
	}
	ahead := map[string]int{}
	for _, src := range sources {
		key := sourceKey(src.SourceKind, src.InfoHash)
		if src.Claimed || !busy[key] || src.FileIndex == nil || contains(out.claim, src.JobID) || ahead[key] >= readAheadPerTorrent {
			continue
		}
		ahead[key]++
		out.readAhead = append(out.readAhead, src)
	}
	return out
}

// schedule refreshes the protected torrents, reads ahead and returns the
// jobs to claim now.
func (p *Prepper) schedule(ctx context.Context, capacity int) []string {
	sources, err := p.Store.PreparingSources(ctx)
	if err != nil {
		log.Printf("[downloads] scheduling: %v", err)
		return nil
	}
	decided := plan(sources, capacity)
	p.protect.set(decided.protected)
	for _, src := range decided.readAhead {
		p.readAhead(src)
	}
	return decided.claim
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// readAhead starts a waiting job's file downloading in the background, at
// the engine's normal priority (the running job's reader comes first), when
// its torrent is open and the disk has room.
func (p *Prepper) readAhead(src PreparingSource) {
	cl, err := torrentx.GetClientFor(torrentx.Category(src.SourceKind))
	if err != nil {
		return
	}
	ih, err := torrentx.InfoHashFromSrc(src.Magnet)
	if err != nil {
		return
	}
	t, ok := cl.Torrent(ih)
	if !ok || t.Info() == nil {
		return
	}
	files := t.Files()
	if *src.FileIndex < 0 || *src.FileIndex >= len(files) {
		return
	}
	file := files[*src.FileIndex]
	remaining := file.Length() - file.BytesCompleted()
	if remaining <= 0 {
		return
	}
	p.mu.Lock()
	reserved := p.reserved
	started := p.readingAhead[src.JobID]
	p.mu.Unlock()
	if started {
		return
	}
	if err := checkPreparationSpace(config.DataRoot(), p.DownloadRoot, remaining+reserved+readAheadMargin); err != nil {
		return
	}
	file.Download()
	p.mu.Lock()
	p.readingAhead[src.JobID] = true
	p.mu.Unlock()
	log.Printf("[downloads] job %s: reading ahead %s (%d MB to fetch)", src.JobID, file.DisplayPath(), remaining>>20)
}
