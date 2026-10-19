package downloads

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/config"
)

// A video's own subtitle tracks as WebVTT, kept on disk by info hash, file
// and track. The phone draws a torrent's own subtitles from this text (one
// look everywhere); reading it needs the whole video. A download is read
// once while it is prepared, so its subtitles are there at once even after
// the server's copy is gone (otherwise the server re-reads the torrent,
// which took longer than the phone waited). Streams are saved after their
// first read.

// ownTrackRoot is outside the torrent folders the cache janitor evicts.
func ownTrackRoot() string { return filepath.Join(config.DataRoot(), "subtitle-tracks") }

// NormalizeInfoHash returns a magnet's info hash as lowercase hex (magnets
// carry hex or base32), or "" when it is neither.
func NormalizeInfoHash(hash string) string {
	hash = strings.TrimSpace(hash)
	if len(hash) == 40 {
		if _, err := hex.DecodeString(hash); err == nil {
			return strings.ToLower(hash)
		}
	}
	if len(hash) == 32 {
		if raw, err := base32.StdEncoding.DecodeString(strings.ToUpper(hash)); err == nil {
			return hex.EncodeToString(raw)
		}
	}
	return ""
}

func ownTrackPath(infoHash string, fileIndex, ordinal int) string {
	sum := sha256.Sum256([]byte(infoHash + "\x00" + strconv.Itoa(fileIndex) + "\x00" + strconv.Itoa(ordinal)))
	return filepath.Join(ownTrackRoot(), hex.EncodeToString(sum[:16])+".vtt")
}

// SavedOwnTrack returns a saved track's WebVTT.
func SavedOwnTrack(infoHash string, fileIndex, ordinal int) ([]byte, bool) {
	infoHash = NormalizeInfoHash(infoHash)
	if infoHash == "" {
		return nil, false
	}
	data, err := os.ReadFile(ownTrackPath(infoHash, fileIndex, ordinal))
	if err != nil || len(data) == 0 {
		return nil, false
	}
	return data, true
}

// SaveOwnTrack keeps a track's WebVTT (written whole, then renamed).
func SaveOwnTrack(infoHash string, fileIndex, ordinal int, data []byte) error {
	infoHash = NormalizeInfoHash(infoHash)
	if infoHash == "" || len(data) == 0 {
		return fmt.Errorf("nothing to save")
	}
	path := ownTrackPath(infoHash, fileIndex, ordinal)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// SaveOwnTracks reads every text subtitle track of a video on disk into the
// store (styled and picture tracks stay with the player). It never fails a
// download; it returns how many tracks it saved.
func SaveOwnTracks(ctx context.Context, video, infoHash string, fileIndex int) int {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	tracks, err := probeEmbeddedSubtitlesWithin(ctx, video, 30*time.Second)
	if err != nil {
		return 0
	}
	saved := 0
	for ordinal := range tracks {
		if _, ok := SavedOwnTrack(infoHash, fileIndex, ordinal); ok {
			saved++
			continue
		}
		data, _, err := ExtractSubtitleTrack(ctx, video, ordinal)
		if err != nil {
			continue
		}
		if err := SaveOwnTrack(infoHash, fileIndex, ordinal, data); err != nil {
			log.Printf("[subtitles] could not keep track %d of %s#%d: %v", ordinal, infoHash, fileIndex, err)
			continue
		}
		saved++
	}
	return saved
}
