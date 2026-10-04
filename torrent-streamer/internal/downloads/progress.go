package downloads

import (
	"sync"
	"time"

	"github.com/anacrolix/torrent"
)

// Preparation stages a client can show while a job is preparing, in order.
const (
	StageQueued      = "queued"      // waiting for a preparation slot
	StageMetadata    = "metadata"    // finding peers (DHT, trackers) and the torrent's file list
	StageSubtitles   = "subtitles"   // fetching requested subtitles
	StageDownloading = "downloading" // the server is downloading the episode
	StageFinalizing  = "finalizing"  // verifying and publishing the package
)

// Progress is a live snapshot of one preparing job. Peer counts come from the
// torrent engine; BytesDone/BytesTotal cover the episode's file only.
type Progress struct {
	Stage      string `json:"stage"`
	Peers      int    `json:"peers"`
	Seeders    int    `json:"seeders"`
	KnownPeers int    `json:"knownPeers"`
	BytesDone  int64  `json:"bytesDone,omitempty"`
	BytesTotal int64  `json:"bytesTotal,omitempty"`
	RateBps    int64  `json:"rateBps,omitempty"`
}

type progressEntry struct {
	stage   string
	torrent *torrent.Torrent
	file    *torrent.File

	// Download rate, smoothed over successive reads.
	lastBytes int64
	lastAt    time.Time
	rate      float64
}

// progressRegistry holds the jobs this process is preparing. Progress is
// in-memory only: after a restart a job reads as queued until it is claimed
// again.
var progressRegistry = struct {
	sync.Mutex
	jobs map[string]*progressEntry
}{jobs: map[string]*progressEntry{}}

func setProgressStage(jobID, stage string, t *torrent.Torrent, file *torrent.File) {
	progressRegistry.Lock()
	defer progressRegistry.Unlock()
	entry := progressRegistry.jobs[jobID]
	if entry == nil {
		entry = &progressEntry{}
		progressRegistry.jobs[jobID] = entry
	}
	entry.stage = stage
	if t != nil {
		entry.torrent = t
	}
	if file != nil {
		entry.file = file
	}
}

func clearProgress(jobID string) {
	progressRegistry.Lock()
	delete(progressRegistry.jobs, jobID)
	progressRegistry.Unlock()
}

// JobProgress reports a preparing job's live progress; ok is false when this
// process is not working on it (still queued, or finished).
func JobProgress(jobID string) (Progress, bool) {
	return jobProgressAt(jobID, time.Now())
}

func jobProgressAt(jobID string, now time.Time) (Progress, bool) {
	progressRegistry.Lock()
	defer progressRegistry.Unlock()
	entry := progressRegistry.jobs[jobID]
	if entry == nil {
		return Progress{}, false
	}
	progress := Progress{Stage: entry.stage}
	if entry.torrent != nil {
		stats := entry.torrent.Stats()
		progress.Peers, progress.Seeders, progress.KnownPeers = stats.ActivePeers, stats.ConnectedSeeders, stats.TotalPeers
	}
	if entry.file != nil {
		progress.BytesDone, progress.BytesTotal = entry.file.BytesCompleted(), entry.file.Length()
		progress.RateBps = entry.sampleRate(progress.BytesDone, now)
	}
	return progress, true
}

// sampleRate turns successive byte counts into a smoothed bytes/second.
func (entry *progressEntry) sampleRate(bytes int64, now time.Time) int64 {
	if !entry.lastAt.IsZero() {
		if elapsed := now.Sub(entry.lastAt).Seconds(); elapsed >= 0.5 {
			instant := float64(bytes-entry.lastBytes) / elapsed
			if instant < 0 {
				instant = 0
			}
			if entry.rate == 0 {
				entry.rate = instant
			} else {
				entry.rate = 0.6*entry.rate + 0.4*instant
			}
			entry.lastBytes, entry.lastAt = bytes, now
		}
	} else {
		entry.lastBytes, entry.lastAt = bytes, now
	}
	return int64(entry.rate)
}
