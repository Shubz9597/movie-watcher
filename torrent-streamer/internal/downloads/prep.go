package downloads

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"

	"torrent-streamer/internal/torrentx"
)

// Prepper is the D02b preparation pipeline (contracts.md §3–§5): it claims
// preparing jobs with bounded admission, resolves the validated pick through
// the torrent engine, copies the video and every requested subtitle sidecar
// into a staging directory (hashing while copying), and atomically moves
// staging to ready with the manifest in ONE transaction. Prepared bytes live
// under their OWN downloads root — the cache janitor never touches them
// (downloading must not starve streaming and must not be evicted
// mid-transfer).
type Prepper struct {
	Store *Store
	Repo  *torrentx.Repo
	// Subtitles is the optional provider fallback for requested languages
	// the torrent does not carry. Nil means torrent sidecars only.
	Subtitles     SubtitleSource
	DownloadRoot  string        // resolved absolute downloads root
	MaxConcurrent int           // bounded admission (default 1)
	InfoTimeout   time.Duration // metadata wait per job (default 10m)
	PrepTimeout   time.Duration // whole-pipeline budget per job (default 6h)
	StaleClaim    time.Duration // crash-claim recovery window (default 15m)

	workerID string
	mu       sync.Mutex
	running  int
}

// SubtitleQuery describes one provider lookup for a prepared video.
type SubtitleQuery struct {
	SeriesID  string // canonical catalog id, e.g. tmdb:movie:693134
	Season    int
	Episode   int
	Lang      string // lowercase ISO 639-1
	VideoName string // torrent file name, used to prefer matching releases
	Hints     SubtitleHints
}

// SubtitleSource fetches one subtitle file from an external provider.
// It returns the file bytes and a safe lowercase extension ("vtt", "srt").
// ErrSubtitleNotFound means the provider has no match for the language.
type SubtitleSource interface {
	FetchSubtitle(ctx context.Context, q SubtitleQuery) (data []byte, ext string, err error)
}

// ErrSubtitleNotFound reports that no provider subtitle matched.
var ErrSubtitleNotFound = errors.New("no subtitle found for the requested language")

func NewPrepper(store *Store, repo *torrentx.Repo, downloadRoot string, maxConcurrent int) *Prepper {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &Prepper{
		Store:         store,
		Repo:          repo,
		DownloadRoot:  downloadRoot,
		MaxConcurrent: maxConcurrent,
		InfoTimeout:   10 * time.Minute,
		PrepTimeout:   6 * time.Hour,
		StaleClaim:    15 * time.Minute,
		workerID:      randomWorkerID(),
	}
}

func randomWorkerID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "worker-unknown"
	}
	return "worker-" + hex.EncodeToString(b)
}

// ReconcileStartup releases claims held by a previous process (contracts.md
// §3). Returns how many claims were released.
func (p *Prepper) ReconcileStartup(ctx context.Context) (int64, error) {
	return p.Store.ReconcileStartup(ctx)
}

// Run is the maintenance loop: fill admission capacity, then periodically
// sweep stale claims and expired retention. It returns when ctx is done.
func (p *Prepper) Run(ctx context.Context) {
	pump := time.NewTicker(5 * time.Second)
	defer pump.Stop()
	sweep := time.NewTicker(5 * time.Minute)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-pump.C:
			p.Pump(ctx)
		case <-sweep.C:
			p.Sweep(ctx)
		}
	}
}

// Pump claims and starts as many jobs as admission capacity allows.
func (p *Prepper) Pump(ctx context.Context) {
	for {
		p.mu.Lock()
		capacity := p.MaxConcurrent - p.running
		p.mu.Unlock()
		if capacity <= 0 {
			return
		}
		ids, err := p.Store.NextUnclaimedPreparing(ctx, capacity)
		if err != nil {
			log.Printf("[downloads] admission queue: %v", err)
			return
		}
		if len(ids) == 0 {
			return
		}
		started := 0
		for _, id := range ids {
			job, err := p.Store.ClaimPreparing(ctx, id, p.workerID)
			if err != nil {
				continue // lost the race or vanished; the next tick re-checks
			}
			p.mu.Lock()
			p.running++
			p.mu.Unlock()
			started++
			go p.prepare(ctx, job)
		}
		if started == 0 {
			return
		}
	}
}

// Sweep releases crashed claims and flips expired ready jobs, deleting their
// files with containment checks. Bounded work per tick.
func (p *Prepper) Sweep(ctx context.Context) {
	if n, err := p.Store.ResetStaleClaims(ctx, p.StaleClaim); err != nil {
		log.Printf("[downloads] stale claim sweep: %v", err)
	} else if n > 0 {
		log.Printf("[downloads] released %d stale claims", n)
	}
	ids, err := p.Store.ExpireDue(ctx, time.Now().UTC(), 50)
	if err != nil {
		log.Printf("[downloads] retention sweep: %v", err)
		return
	}
	for _, id := range ids {
		if err := p.Store.DeleteAssets(ctx, id); err != nil {
			log.Printf("[downloads] asset cleanup %s: %v", id, err)
			continue
		}
		if err := os.RemoveAll(p.readyDir(id)); err != nil {
			log.Printf("[downloads] file cleanup %s: %v", id, err)
		} else {
			log.Printf("[downloads] retention: removed expired job %s assets", id)
		}
	}
}

// readyDir resolves a job's ready directory. Only paths directly under
// <root>/ready/<jobID> are ever touched; filepath.Base prevents any path
// trickery through the job id (never a recursive delete outside the
// resolved root).
func (p *Prepper) readyDir(jobID string) string {
	return filepath.Join(p.DownloadRoot, "ready", filepath.Base(jobID))
}

func (p *Prepper) stagingDir(jobID string) string {
	return filepath.Join(p.DownloadRoot, "staging", filepath.Base(jobID))
}

// prepare runs the full pipeline for one claimed job.
func (p *Prepper) prepare(ctx context.Context, job Job) {
	defer func() {
		p.mu.Lock()
		p.running--
		p.mu.Unlock()
	}()
	staged := p.stagingDir(job.ID)
	ready := p.readyDir(job.ID)
	discard := func() { _ = os.RemoveAll(staged) }
	fail := func(reason string, err error) {
		discard()
		log.Printf("[downloads] job %s failed (%s): %v", job.ID, reason, err)
		if ferr := p.Store.FailPreparing(ctx, job.ID, reason); ferr != nil && ferr != ErrNotCancellable {
			log.Printf("[downloads] job %s failure recording: %v", job.ID, ferr)
		}
	}

	jobCtx, cancel := context.WithTimeout(ctx, p.PrepTimeout)
	defer cancel()

	// 1. Resolve the validated pick (opaque source identity; no user URLs).
	pick, ok, err := p.Repo.GetPickByID(jobCtx, job.PickID)
	if err != nil {
		fail(ReasonPreparationFailed, err)
		return
	}
	if !ok {
		fail(ReasonSourceUnavailable, fmt.Errorf("pick %d missing", job.PickID))
		return
	}

	// 2. Hold the active reference BEFORE adding, so the engine never drops
	// the torrent mid-preparation (protection against idle/size eviction).
	cat := torrentx.Category(pick.SourceKind)
	ih, err := torrentx.InfoHashFromSrc(pick.Magnet)
	if err != nil {
		fail(ReasonSourceUnavailable, err)
		return
	}
	torrentx.IncActive(cat, ih)
	defer torrentx.DecActive(cat, ih)

	cl := torrentx.GetClientFor(cat)
	t, err := torrentx.AddOrGetTorrent(cl, pick.Magnet)
	if err != nil {
		fail(ReasonSourceUnavailable, err)
		return
	}
	infoCtx, cancelInfo := context.WithTimeout(jobCtx, p.InfoTimeout)
	if err := torrentx.WaitForInfo(infoCtx, t); err != nil {
		cancelInfo()
		fail(ReasonSourceUnavailable, err)
		return
	}
	cancelInfo()

	// 3. Choose the video file: the validated pick's file index, else the
	// engine's best-video heuristic. No silent source replacement.
	files := t.Files()
	if len(files) == 0 {
		fail(ReasonPreparationFailed, fmt.Errorf("torrent has no files"))
		return
	}
	fileIdx := -1
	if pick.FileIndex != nil && *pick.FileIndex >= 0 && *pick.FileIndex < len(files) {
		fileIdx = *pick.FileIndex
	} else if _, idx := torrentx.ChooseBestVideoFile(t); idx >= 0 {
		fileIdx = idx
	}
	if fileIdx < 0 {
		fail(ReasonPreparationFailed, fmt.Errorf("no video file in torrent"))
		return
	}
	file := files[fileIdx]
	file.Download()

	// 4. Subtitle sidecars, resolved BEFORE the long video copy so a missing
	// language fails in seconds, not hours. Torrent-internal files win;
	// otherwise the provider fallback supplies the best-matching release.
	// A requested language nobody can provide fails the job with
	// subtitles_unavailable (the client offers Continue without subtitles —
	// never silently ready, contracts.md §4).
	if err := os.MkdirAll(staged, 0o755); err != nil {
		fail(ReasonInsufficientServerSpace, err)
		return
	}
	var subtitleAssets []AssetRow
	if len(job.RequestedSubtitles) > 0 {
		requested := requestedSet(job.RequestedSubtitles)
		matched := map[string]torrentx.SubtitleFile{}
		for _, sub := range torrentx.FindSubtitleFilesForVideo(t, fileIdx) {
			lang := strings.ToLower(sub.Lang)
			if requested[lang] && matched[lang].Index == 0 && matched[lang].Path == "" {
				matched[lang] = sub
			}
		}
		for _, lang := range job.RequestedSubtitles {
			url := "/v1/downloads/jobs/" + job.ID + "/assets/subtitles/" + lang
			if sub, ok := matched[lang]; ok {
				name := "subtitles." + lang + "." + sub.Ext
				size, sha, err := p.copyTo(jobCtx, files[sub.Index], filepath.Join(staged, name))
				if err != nil {
					fail(ReasonPreparationFailed, err)
					return
				}
				subtitleAssets = append(subtitleAssets, AssetRow{
					Kind: AssetKindSubtitle, Lang: lang, URLPath: url,
					DiskPath:  "ready/" + filepath.Base(job.ID) + "/" + name,
					SizeBytes: size, SHA256: sha,
				})
				continue
			}
			if p.Subtitles == nil {
				fail(ReasonSubtitlesUnavailable, fmt.Errorf("requested subtitle language %q not in torrent", lang))
				return
			}
			data, subExt, err := p.Subtitles.FetchSubtitle(jobCtx, SubtitleQuery{
				SeriesID: job.SeriesID, Season: job.Season, Episode: job.Episode, Lang: lang,
				VideoName: filepath.Base(file.Path()), Hints: job.SubtitleHints,
			})
			if err != nil || len(data) == 0 {
				fail(ReasonSubtitlesUnavailable, fmt.Errorf("subtitle %q: %v", lang, err))
				return
			}
			if subExt != "vtt" && subExt != "srt" {
				subExt = "vtt"
			}
			name := "subtitles." + lang + "." + subExt
			size, sha, err := writeHashed(filepath.Join(staged, name), data)
			if err != nil {
				fail(ReasonInsufficientServerSpace, err)
				return
			}
			subtitleAssets = append(subtitleAssets, AssetRow{
				Kind: AssetKindSubtitle, Lang: lang, URLPath: url,
				DiskPath:  "ready/" + filepath.Base(job.ID) + "/" + name,
				SizeBytes: size, SHA256: sha,
			})
		}
	}

	// 5. Stage the video (hash while copying; ctx cancellation aborts).
	ext := strings.ToLower(filepath.Ext(file.Path()))
	if !isSafeExt(ext) {
		fail(ReasonPreparationFailed, fmt.Errorf("unexpected video extension %q", ext))
		return
	}
	videoDisk := "ready/" + filepath.Base(job.ID) + "/video" + ext
	videoURL := "/v1/downloads/jobs/" + job.ID + "/assets/video"
	videoSize, videoSHA, err := p.copyTo(jobCtx, file, filepath.Join(staged, "video"+ext))
	if err != nil {
		fail(ReasonPreparationFailed, err)
		return
	}
	if videoSize != file.Length() {
		fail(ReasonPreparationFailed, fmt.Errorf("incomplete copy: %d of %d bytes", videoSize, file.Length()))
		return
	}

	assets := []AssetRow{{
		Kind: AssetKindVideo, URLPath: videoURL, DiskPath: videoDisk,
		SizeBytes: videoSize, SHA256: videoSHA,
	}}
	assets = append(assets, subtitleAssets...)

	// 6. Atomic finalize: rename staging to ready on the same volume, then
	// ONE transaction attaches the assets and flips the state. If the job
	// was cancelled meanwhile, the transaction refuses and we discard.
	if err := os.MkdirAll(filepath.Join(p.DownloadRoot, "ready"), 0o755); err != nil {
		fail(ReasonInsufficientServerSpace, err)
		return
	}
	if err := os.Rename(staged, ready); err != nil {
		fail(ReasonPreparationFailed, err)
		return
	}
	manifest := buildManifest(job.ID, assets, time.Now().UTC())
	if err := p.Store.MarkReady(ctx, job.ID, manifest, assets, time.Now().UTC()); err != nil {
		_ = os.RemoveAll(ready)
		_ = p.Store.DeleteAssets(ctx, job.ID)
		if err == ErrNotCancellable {
			log.Printf("[downloads] job %s was cancelled during preparation; staged bytes discarded", job.ID)
			return
		}
		log.Printf("[downloads] job %s finalize: %v", job.ID, err)
		return
	}
	log.Printf("[downloads] job %s ready (%d bytes video, %d sidecars)", job.ID, videoSize, len(manifest.Subtitles))
}

// buildManifest assembles the ready-package manifest from the finalized
// assets (contracts.md §4): one video, one entry per sidecar, expiry at the
// retention default.
func buildManifest(jobID string, assets []AssetRow, now time.Time) Manifest {
	m := Manifest{
		ManifestVersion: ManifestVersion,
		JobID:           jobID,
		Revision:        now.Unix(),
		ExpiresAt:       now.Add(DefaultRetention).Format(time.RFC3339),
	}
	for _, a := range assets {
		asset := Asset{Path: a.URLPath, SizeBytes: a.SizeBytes, SHA256: a.SHA256}
		switch a.Kind {
		case AssetKindVideo:
			asset.Kind = AssetKindVideo
			m.Video = asset
		case AssetKindSubtitle:
			asset.Kind = AssetKindSubtitle
			asset.Lang = a.Lang
			m.Subtitles = append(m.Subtitles, asset)
		}
	}
	return m
}

func requestedSet(langs []string) map[string]bool {
	set := make(map[string]bool, len(langs))
	for _, l := range langs {
		set[strings.ToLower(l)] = true
	}
	return set
}

func isSafeExt(ext string) bool {
	if len(ext) < 2 || len(ext) > 8 || ext[0] != '.' {
		return false
	}
	for _, r := range ext[1:] {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// copyTo streams exactly one torrent file into dest with SHA-256 computed on
// the fly. Some multi-file torrents expose a reader that can continue into the
// next file, so the declared file length is an explicit hard boundary here.
// Context cancellation closes the reader to unblock a stalled read.
func (p *Prepper) copyTo(ctx context.Context, file *torrent.File, dest string) (int64, string, error) {
	reader := file.NewReader()
	defer reader.Close()
	// Unblock on cancellation: closing the reader makes a stalled Read fail.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			_ = reader.Close()
		case <-stop:
		}
	}()
	reader.SetResponsive()
	out, err := os.Create(dest)
	if err != nil {
		return 0, "", err
	}
	defer out.Close()
	return copyExact(ctx, out, reader, file.Length(), filepath.Base(dest))
}

func copyExact(ctx context.Context, out io.Writer, reader io.Reader, expected int64, name string) (int64, string, error) {
	hasher := sha256.New()
	var lastLog int64
	buf := make([]byte, 512<<10)
	var written int64
	reader = io.LimitReader(reader, expected)
	for {
		if err := ctx.Err(); err != nil {
			return written, "", err
		}
		n, rerr := reader.Read(buf)
		if n > 0 {
			nw, werr := out.Write(buf[:n])
			if nw > 0 {
				_, _ = hasher.Write(buf[:nw])
				written += int64(nw)
			}
			if werr != nil {
				return written, "", werr
			}
			if nw != n {
				return written, "", io.ErrShortWrite
			}
			if written/(256<<20) > lastLog {
				lastLog = written / (256 << 20)
				log.Printf("[downloads] staging %s: %d MB", name, written>>20)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return written, "", rerr
		}
		if n == 0 {
			// The engine may report (0, nil) while waiting for peers; avoid a
			// busy spin (same treatment as torrentx.Prebuffer).
			time.Sleep(200 * time.Millisecond)
		}
	}
	if written != expected {
		return written, "", fmt.Errorf("incomplete copy: %d of %d bytes", written, expected)
	}
	return written, hex.EncodeToString(hasher.Sum(nil)), nil
}

// writeHashed writes provider bytes into staging and returns their size and
// SHA-256, matching copyTo's integrity contract for torrent assets.
func writeHashed(dst string, data []byte) (int64, string, error) {
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return 0, "", err
	}
	sum := sha256.Sum256(data)
	return int64(len(data)), hex.EncodeToString(sum[:]), nil
}
