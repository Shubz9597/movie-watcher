package httpapi

import (
	"context"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/torrentx"
)

// GET /downloads/source?downloadId&clientId: the file a download was made
// from ({fileName}), e.g. "Episode 125 Turn Into Candy! A Hungry Majin's
// Bizarre Power!.mkv". The phone checks that a pack's file names the episode
// the download is filed under: Dragon Ball Z Kai's pack numbers The Final
// Chapters as the 69-episode international release, so downloads made by
// number were filed 7 episodes off. fileName is "" when the download is
// not one file of a torrent.

var sourceNames = struct {
	sync.Mutex
	byKey map[string]string
}{byKey: map[string]string{}}

func (h SubtitleMatchHandlers) handleDownloadSource(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	q := r.URL.Query()
	if h.Jobs == nil || h.Picks == nil {
		http.Error(w, "downloads unavailable", http.StatusServiceUnavailable)
		return
	}
	job, err := h.Jobs.Get(r.Context(), strings.TrimSpace(q.Get("clientId")), strings.TrimSpace(q.Get("downloadId")))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	pick, ok, err := h.Picks.GetPickByID(r.Context(), job.PickID)
	if err != nil || !ok {
		http.NotFound(w, r)
		return
	}
	name := ""
	if pick.FileIndex != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		name = torrentFileName(ctx, torrentx.Category(pick.SourceKind), pick.Magnet, *pick.FileIndex)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"downloadId": job.ID, "seriesId": job.SeriesID, "season": job.Season, "episode": job.Episode,
		"fileName": name,
	})
}

// torrentFileName reads the torrent's file list (metadata only, no data).
func torrentFileName(ctx context.Context, cat, magnet string, index int) string {
	key := canonicalMagnetHash(magnet) + "#" + strconv.Itoa(index)
	sourceNames.Lock()
	cached, ok := sourceNames.byKey[key]
	sourceNames.Unlock()
	if ok {
		return cached
	}
	cl, err := torrentx.GetClientFor(cat)
	if err != nil {
		return ""
	}
	t, err := torrentx.AddOrGetTorrent(cl, magnet)
	if err != nil || torrentx.WaitForInfo(ctx, t) != nil {
		return ""
	}
	files := t.Files()
	if index < 0 || index >= len(files) {
		return ""
	}
	name := path.Base(files[index].DisplayPath())
	sourceNames.Lock()
	sourceNames.byKey[key] = name
	sourceNames.Unlock()
	return name
}
