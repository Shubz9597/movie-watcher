package playback

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/anacrolix/torrent"
	"torrent-streamer/internal/torrentx"
)

// TorrentResolver implements Resolver against the existing torrent client.
// It validates (cat, sourceID, fileIndex) and returns fresh bounded readers.
// Errors are bounded and redacted: they name the failure class and never the
// magnet, any filesystem path, or credential material.
type TorrentResolver struct {
	WaitMetadata time.Duration
}

var _ Resolver = (*TorrentResolver)(nil)

// Resolve satisfies the Resolver contract. The sourceID is an info hash —
// the session contract is source-ID based, NOT magnet-based, so a magnet can
// never reach an FFmpeg/ffprobe command line or the logs through this path.
func (r *TorrentResolver) Resolve(ctx context.Context, cat, sourceID string, fileIndex int) (ResolvedSource, error) {
	if !validCategory(cat) {
		return ResolvedSource{}, &Error{Code: "invalid_request", Message: "Unknown category."}
	}
	if err := validateSourceID(sourceID); err != nil {
		return ResolvedSource{}, err
	}
	waitMetadata := r.WaitMetadata
	if waitMetadata <= 0 {
		waitMetadata = 25 * time.Second
	}

	client := torrentx.GetClientFor(cat)
	t, err := torrentx.AddOrGetTorrent(client, "magnet:?xt=urn:btih:"+strings.ToUpper(strings.TrimSpace(sourceID)))
	if err != nil {
		return ResolvedSource{}, &Error{Code: ReasonMalformedSource, Message: "The source could not be opened."}
	}
	waitCtx, cancelWait := context.WithTimeout(ctx, waitMetadata)
	err = torrentx.WaitForInfo(waitCtx, t)
	cancelWait()
	if err != nil {
		return ResolvedSource{}, &Error{Code: ReasonMediaInspectionFail, Message: "The source metadata was not available in time. Try again once more peers respond."}
	}
	torrentx.TouchTorrent(cat, t)

	files := t.Files()
	if len(files) == 0 {
		return ResolvedSource{}, &Error{Code: ReasonMalformedSource, Message: "The selected source contains no files."}
	}
	var chosen *torrent.File
	if fileIndex >= 0 && fileIndex < len(files) {
		chosen = files[fileIndex]
	} else {
		chosen, _ = torrentx.ChooseBestVideoFile(t)
	}
	if chosen == nil {
		return ResolvedSource{}, &Error{Code: ReasonMalformedSource, Message: "The selected source contains no playable video file."}
	}
	chosenIndex := indexOfFile(files, chosen)

	resolved := ResolvedSource{
		Open: func() (io.ReadSeekCloser, error) {
			return chosen.NewReader(), nil
		},
		Name: torrentx.SafeDownloadName(filepath.Base(chosen.Path())),
		Size: chosen.Length(),
	}

	// M1.4 repair: pre-buffer the first data BEFORE handing the reader to
	// ffprobe. Without this, ffprobe reads zeros/empty data from an
	// un-downloaded torrent and fails with media_inspection_failed.
	// The existing /stream endpoint does the same via torrentx.Prebuffer.
	reader := chosen.NewReader()
	reader.SetResponsive()
	prebufferBytes := int64(2 << 20) // 2 MiB — enough for ffprobe headers
	prebuffered := torrentx.Prebuffer(reader, prebufferBytes, 30*time.Second)
	if prebuffered == 0 {
		reader.Close()
		return ResolvedSource{}, &Error{
			Code:  ReasonMediaInspectionFail,
			Message: "Not enough peers to start streaming. Try a different source or wait for more seeders.",
		}
	}
	reader.Close() // the media source re-opens fresh readers per request

	for _, sub := range torrentx.FindSubtitleFilesForVideo(t, chosenIndex) {
		sidecar := sub
		resolved.Sidecars = append(resolved.Sidecars, Sidecar{
			Format:   sidecar.Ext,
			Language: sidecar.Lang,
			Label:    sidecar.Name,
			Open: func() (io.ReadCloser, error) {
				return files[sidecar.Index].NewReader(), nil
			},
		})
	}
	return resolved, nil
}

// validateSourceID accepts only 40-char hex info hashes.
func validateSourceID(sourceID string) error {
	id := strings.TrimSpace(sourceID)
	if len(id) != 40 {
		return &Error{Code: "invalid_request", Message: "The source identifier must be a 40-character info hash."}
	}
	for _, r := range id {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return &Error{Code: "invalid_request", Message: "The source identifier must be a hex info hash."}
		}
	}
	return nil
}

func validCategory(cat string) bool {
	switch strings.ToLower(strings.TrimSpace(cat)) {
	case "movie", "tv", "anime", "misc":
		return true
	default:
		return false
	}
}

func indexOfFile(files []*torrent.File, want *torrent.File) int {
	for i, f := range files {
		if f == want {
			return i
		}
	}
	return -1
}
