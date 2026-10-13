package torrentx

import (
	"context"
	"log"
	"path/filepath"

	"github.com/anacrolix/torrent"

	"torrent-streamer/internal/config"
)

// fileDataSlack tolerates metadata and the pieces a file shares with its
// neighbours before treating a file as missing data.
const fileDataSlack = 8 << 20

// EnsureFileData re-verifies a file's pieces when the engine records them
// as complete but the disk holds far less data. The engine's completion
// check compares file sizes only, so a full-size sparse file (its data was
// removed while the completion record survived, and writing a piece shared
// with a neighbouring file recreated it at full length) was served as
// zeros: Dragon Ball Z Kai episode 20 read as 240 MB with 1.8 MB on disk.
// Verifying fails those pieces' hashes, so they are downloaded again. It
// costs one stat per call when the data is there.
func EnsureFileData(ctx context.Context, cat string, t *torrent.Torrent, f *torrent.File) {
	if t == nil || f == nil {
		return
	}
	completed := f.BytesCompleted()
	if completed < fileDataSlack {
		return
	}
	root, err := filepath.Abs(filepath.Join(config.DataRoot(), validCat(cat)))
	if err != nil {
		return
	}
	paths, err := cacheStoragePaths(root, f.Path())
	if err != nil {
		return
	}
	var stored int64
	for _, path := range paths {
		stored = max(stored, allocatedBytes(path))
	}
	if stored < 0 || stored >= completed/2 || completed-stored < fileDataSlack {
		return
	}
	log.Printf("[torrent] %s: %d bytes recorded complete but %d on disk; re-verifying its pieces", f.DisplayPath(), completed, stored)
	for i := f.BeginPieceIndex(); i < f.EndPieceIndex(); i++ {
		if ctx.Err() != nil {
			return
		}
		if piece := t.Piece(i); piece.State().Complete {
			_ = piece.VerifyDataContext(ctx)
		}
	}
	log.Printf("[torrent] %s: re-verified; %d bytes now complete", f.DisplayPath(), f.BytesCompleted())
}
