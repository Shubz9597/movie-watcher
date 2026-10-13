package introdetect

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent/metainfo"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/torrentx"
)

// Service runs detection for downloads (from the staged file) and streams
// (through the server's own /stream), keeping fingerprints and songs.
type Service struct {
	Store      *Store
	DB         *sql.DB // picks: which file a skip-times request is about
	ListenAddr string  // this server's /stream, read through loopback
	HTTP       *http.Client

	measuring chan struct{} // one file measured at a time (CPU, bandwidth)
	mu        sync.Mutex
	flights   map[string]*flight
	anime     map[int]animeIDs // MAL id -> AniList/TMDb ids
	extras    map[string]bool  // torrents whose extras are learned or being learned
}

type flight struct {
	done   chan struct{}
	result Result
	err    error
}

type animeIDs struct {
	anilist, tmdb int
}

// RequestWait bounds how long a skip-times request waits for detection
// still running; the rest continues in the background for the next play.
const RequestWait = 45 * time.Second

const (
	detectTimeout = 6 * time.Minute
	neighbours    = 8
	maxExtras     = 10
	extraSeconds  = 200
)

func NewService(db *sql.DB, listenAddr string) *Service {
	return &Service{
		Store: &Store{DB: db}, DB: db, ListenAddr: listenAddr,
		HTTP:      &http.Client{Timeout: 15 * time.Second},
		measuring: make(chan struct{}, 1),
		flights:   map[string]*flight{},
		anime:     map[int]animeIDs{},
		extras:    map[string]bool{},
	}
}

// ProfileFor is the detection profile of a kind of show; ok is false for
// movies (no recurring opening or ending).
func ProfileFor(showKind string) (Profile, bool) {
	switch showKind {
	case "anime":
		return AnimeProfile, true
	case "tv":
		return TVProfile, true
	}
	return Profile{}, false
}

// ShowKindFor classifies a canonical series id and torrent category.
func ShowKindFor(seriesKey, cat string) string {
	switch {
	case strings.HasPrefix(seriesKey, "tmdb:movie:"), cat == "movie":
		return "movie"
	case strings.HasPrefix(seriesKey, "anilist:"), strings.HasPrefix(seriesKey, "jikan:"), cat == "anime":
		return "anime"
	}
	return "tv"
}

// Source is where a file's torrent can be read (for its creditless extras).
type Source struct {
	Magnet, Cat string
}

// Detect fingerprints the file from input (a path or URL) unless already
// stored, then finds its opening and ending, keeping songs it learns.
func (s *Service) Detect(ctx context.Context, ref Ref, input string, source Source) (Result, error) {
	profile, ok := ProfileFor(ref.ShowKind)
	if !ok {
		return Result{}, nil
	}
	if err := s.fingerprint(ctx, ref, input, profile); err != nil {
		return Result{}, err
	}
	file, _, err := s.Store.LoadFile(ctx, ref.InfoHash, ref.FileIndex)
	if err != nil {
		return Result{}, err
	}
	if source.Magnet != "" && ref.ShowKind == "anime" {
		s.learnExtras(ctx, ref, source)
	}
	themes, err := s.Store.Themes(ctx, ref.SeriesKey)
	if err != nil {
		return Result{}, err
	}
	others, err := s.Store.Neighbours(ctx, ref, neighbours)
	if err != nil {
		return Result{}, err
	}
	result, learned := Detect(file, others, themes, profile)
	for i, theme := range learned {
		theme.Source = "episodes:" + file.Key + ":" + strconv.Itoa(i)
		if _, err := s.Store.SaveTheme(ctx, ref.SeriesKey, theme); err != nil {
			log.Printf("[intro] saving a %s song for %s: %v", theme.Kind, ref.SeriesKey, err)
		}
	}
	log.Printf("[intro] %s S%dE%d %s: intro %s, credits %s", ref.SeriesKey, ref.Season, ref.Episode, file.Key, describe(result.Intro), describe(result.Credits))
	return result, nil
}

func describe(segment *Segment) string {
	if segment == nil {
		return "none"
	}
	return fmt.Sprintf("%.1f-%.1f s (%s)", segment.Start, segment.End, segment.Method)
}

var extraName = regexp.MustCompile(`(?i)(^|[^a-z0-9])(nc ?op|nc ?ed|creditless|op|ed|opening|ending)( ?\d{1,2})?([^a-z0-9]|$)`)

// learnExtras turns a release's creditless openings and endings (OP1.mkv,
// NCED2.mkv...) into the show's songs, once per file.
func (s *Service) learnExtras(ctx context.Context, ref Ref, source Source) {
	// Once per torrent and show: detections of several episodes of a pack
	// run together and would all fetch the same files.
	key := ref.SeriesKey + "|" + ref.InfoHash
	s.mu.Lock()
	if s.extras[key] {
		s.mu.Unlock()
		return
	}
	s.extras[key] = true
	s.mu.Unlock()
	cl, err := torrentx.GetClientFor(source.Cat)
	if err != nil {
		return
	}
	t, err := torrentx.AddOrGetTorrent(cl, source.Magnet)
	if err != nil {
		return
	}
	infoCtx, cancel := context.WithTimeout(ctx, time.Minute)
	err = torrentx.WaitForInfo(infoCtx, t)
	cancel()
	if err != nil {
		return
	}
	learned := 0
	for index, file := range t.Files() {
		if learned >= maxExtras || index == ref.FileIndex || file.Length() > 150<<20 {
			continue
		}
		name := path.Base(file.DisplayPath())
		if !isVideoName(name) {
			continue
		}
		m := extraName.FindStringSubmatch(strings.TrimSuffix(name, path.Ext(name)))
		if m == nil {
			continue
		}
		kind := Intro
		if word := strings.ToLower(strings.ReplaceAll(m[2], " ", "")); strings.HasSuffix(word, "ed") || word == "ending" {
			kind = Credits
		}
		themeSource := "extra:" + ref.InfoHash + ":" + strconv.Itoa(index)
		if has, err := s.Store.HasTheme(ctx, ref.SeriesKey, themeSource); err != nil || has {
			continue
		}
		points, err := MeasureWhole(ctx, ffTool(config.FFmpegPath(), "ffmpeg"), s.StreamURL(source.Cat, source.Magnet, index), extraSeconds)
		if err != nil || len(points) < 10*PointsPerSecond {
			continue
		}
		if added, err := s.Store.SaveTheme(ctx, ref.SeriesKey, Theme{Kind: kind, Points: points, Source: themeSource}); err == nil && added {
			learned++
			log.Printf("[intro] %s: %s song from %s", ref.SeriesKey, kind, name)
		}
	}
}

func isVideoName(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".mkv", ".mp4", ".m4v", ".avi", ".webm", ".ts":
		return true
	}
	return false
}

// StreamURL reads a torrent file through this server's /stream, which
// fetches and prioritises its pieces as playback does.
func (s *Service) StreamURL(cat, magnet string, fileIndex int) string {
	port := "8080"
	if _, p, err := net.SplitHostPort(s.ListenAddr); err == nil && p != "" {
		port = p
	}
	params := url.Values{"cat": {cat}, "fileIndex": {strconv.Itoa(fileIndex)}, "magnet": {magnet}}
	return "http://127.0.0.1:" + port + "/stream?" + params.Encode()
}

// detectOnce runs Detect for a file once at a time; callers wait at most
// until ctx ends while the detection itself continues for later requests.
func (s *Service) detectOnce(ctx context.Context, ref Ref, input string, source Source) (Result, error) {
	key := fileKey(ref.InfoHash, ref.FileIndex)
	s.mu.Lock()
	f, running := s.flights[key]
	if !running {
		f = &flight{done: make(chan struct{})}
		s.flights[key] = f
		go func() {
			detectCtx, cancel := context.WithTimeout(context.Background(), detectTimeout)
			defer cancel()
			f.result, f.err = s.Detect(detectCtx, ref, input, source)
			if f.err != nil {
				log.Printf("[intro] %s S%dE%d %s: %v", ref.SeriesKey, ref.Season, ref.Episode, key, f.err)
			}
			close(f.done)
			s.mu.Lock()
			delete(s.flights, key)
			s.mu.Unlock()
		}()
	}
	s.mu.Unlock()
	select {
	case <-f.done:
		return f.result, f.err
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// DetectPrepared fingerprints a download from its staged file (before the
// staging directory is renamed away), then finds its opening and ending in
// the background from the stored fingerprints.
func (s *Service) DetectPrepared(ctx context.Context, ref Ref, stagedPath string, source Source) {
	profile, ok := ProfileFor(ref.ShowKind)
	if !ok {
		return
	}
	if err := s.fingerprint(ctx, ref, stagedPath, profile); err != nil {
		log.Printf("[intro] download %s S%dE%d: %v", ref.SeriesKey, ref.Season, ref.Episode, err)
		return
	}
	go func() {
		background, cancel := context.WithTimeout(context.Background(), detectTimeout)
		defer cancel()
		_, _ = s.detectOnce(background, ref, "", source)
	}()
}

// fingerprint measures and stores a file unless it is stored already.
func (s *Service) fingerprint(ctx context.Context, ref Ref, input string, profile Profile) error {
	if _, stored, err := s.Store.LoadFile(ctx, ref.InfoHash, ref.FileIndex); err != nil || stored {
		return err
	}
	if input == "" {
		return errors.New("no fingerprints stored and no file to measure")
	}
	select {
	case s.measuring <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	head, tail, duration, err := Measure(ctx, ffTool(config.FFmpegPath(), "ffmpeg"), ffTool(config.FFprobePath(), "ffprobe"), input, profile)
	<-s.measuring
	if err != nil {
		return fmt.Errorf("measure: %w", err)
	}
	file := File{Key: fileKey(ref.InfoHash, ref.FileIndex), Season: ref.Season, Episode: ref.Episode, Duration: duration, Head: head, Tail: tail}
	return s.Store.SaveFile(ctx, ref, file)
}

// ForSkipRequest finds the file a /skip-segments request is about (the
// latest pick for the episode, streamed or downloaded) and returns what
// detection found, waiting at most RequestWait.
func (s *Service) ForSkipRequest(ctx context.Context, q url.Values) (Result, bool) {
	kind := strings.ToLower(q.Get("kind"))
	if kind != "anime" && kind != "tv" {
		return Result{}, false
	}
	season, _ := strconv.Atoi(q.Get("season"))
	episode, _ := strconv.Atoi(q.Get("episode"))
	if abs, err := strconv.Atoi(q.Get("absoluteEpisode")); kind == "anime" && err == nil && abs > 0 {
		episode = abs
	}
	if episode <= 0 {
		return Result{}, false
	}
	var series []string
	if kind == "tv" {
		if id := q.Get("tmdbId"); id != "" {
			series = append(series, "tmdb:tv:"+id)
		}
	} else if mal, err := strconv.Atoi(q.Get("malId")); err == nil && mal > 0 {
		ids := s.animeIDs(ctx, mal)
		if ids.anilist > 0 {
			series = append(series, "anilist:"+strconv.Itoa(ids.anilist))
		}
		if ids.tmdb > 0 {
			series = append(series, "tmdb:tv:"+strconv.Itoa(ids.tmdb))
		}
		season = 0 // anime picks number episodes per entry
	}
	if len(series) == 0 {
		return Result{}, false
	}
	pick, ok := s.latestPick(ctx, series, season, episode)
	if !ok {
		return Result{}, false
	}
	ref := Ref{InfoHash: pick.infoHash, FileIndex: pick.fileIndex, SeriesKey: pick.seriesID, Season: pick.season, Episode: pick.episode,
		ShowKind: ShowKindFor(pick.seriesID, kind)}
	if ref.ShowKind == "movie" {
		return Result{}, false
	}
	waitCtx, cancel := context.WithTimeout(ctx, RequestWait)
	defer cancel()
	result, err := s.detectOnce(waitCtx, ref, s.StreamURL(pick.cat, pick.magnet, pick.fileIndex), Source{Magnet: pick.magnet, Cat: pick.cat})
	return result, err == nil
}

type pickRow struct {
	seriesID, magnet, cat, infoHash string
	season, episode, fileIndex      int
}

func (s *Service) latestPick(ctx context.Context, series []string, season, episode int) (pickRow, bool) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT series_id, season, episode, magnet, COALESCE(file_index, -1), COALESCE(source_kind, '')
FROM picks WHERE series_id = ANY($1) AND episode = $2 AND ($3 = 0 OR season = $3) AND magnet <> ''
ORDER BY updated_at DESC LIMIT 1`, series, episode, season)
	if err != nil {
		return pickRow{}, false
	}
	defer rows.Close()
	if !rows.Next() {
		return pickRow{}, false
	}
	var p pickRow
	var sourceKind string
	if err := rows.Scan(&p.seriesID, &p.season, &p.episode, &p.magnet, &p.fileIndex, &sourceKind); err != nil || p.fileIndex < 0 {
		return pickRow{}, false
	}
	p.cat = torrentx.Category(sourceKind)
	m, err := metainfo.ParseMagnetUri(p.magnet)
	if err != nil {
		return pickRow{}, false
	}
	p.infoHash = strings.ToLower(m.InfoHash.HexString())
	return p, true
}

// animeIDs maps a MAL id to AniList and TMDb ids through ani.zip (cached).
func (s *Service) animeIDs(ctx context.Context, mal int) animeIDs {
	s.mu.Lock()
	ids, ok := s.anime[mal]
	s.mu.Unlock()
	if ok {
		return ids
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ani.zip/mappings?mal_id="+strconv.Itoa(mal), nil)
	if err != nil {
		return animeIDs{}
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return animeIDs{}
	}
	defer resp.Body.Close()
	var payload struct {
		Mappings struct {
			AniList json.Number `json:"anilist_id"`
			TMDB    json.Number `json:"themoviedb_id"`
		} `json:"mappings"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&payload) != nil {
		return animeIDs{}
	}
	anilist, _ := strconv.Atoi(string(payload.Mappings.AniList))
	tmdb, _ := strconv.Atoi(strings.Trim(string(payload.Mappings.TMDB), `"`))
	ids = animeIDs{anilist: anilist, tmdb: tmdb}
	s.mu.Lock()
	s.anime[mal] = ids
	s.mu.Unlock()
	return ids
}

func ffTool(configured, name string) string {
	if configured != "" {
		return configured
	}
	if found, err := exec.LookPath(name); err == nil {
		return found
	}
	return name
}
