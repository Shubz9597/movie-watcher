package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Torrentio is a public, keyless index of torrents by IMDb id. It answers in
// well under a second from a pre-built index, so film and TV searches ask it
// first; Prowlarr remains the fallback when it fails or has nothing usable.
type Torrentio struct {
	BaseURL   string // e.g. https://torrentio.strem.fun
	AniZipURL string // AniList → Kitsu id mappings; default https://api.ani.zip
	HTTP      *http.Client

	kitsuMu sync.Mutex
	kitsu   map[int]kitsuEntry
}

type kitsuEntry struct {
	id      int
	expires time.Time
}

const torrentioTimeout = 8 * time.Second

// userAgent identifies TorWatch: Torrentio's Cloudflare front answers Go's
// default "Go-http-client" agent with 403.
const userAgent = "TorWatch/1.0"

var (
	torrentioSeeders = regexp.MustCompile(`👤\s*(\d+)`)
	torrentioSize    = regexp.MustCompile(`💾\s*([\d.]+)\s*(TB|GB|MB|KB)`)
	torrentioSource  = regexp.MustCompile(`⚙️\s*(.+)$`)
)

type torrentioStream struct {
	Title    string   `json:"title"`
	InfoHash string   `json:"infoHash"`
	FileIdx  *int     `json:"fileIdx"`
	Sources  []string `json:"sources"`
}

// SetTorrentio enables Torrentio as the first source for films and TV.
func (s *Service) SetTorrentio(source *Torrentio) { s.torrentio = source }

// path returns the stream path for a request, or "" when Torrentio cannot
// answer it. Anime is looked up by Kitsu id (one entry per season or arc,
// like AniList), falling back to IMDb season/episode.
func (t *Torrentio) path(ctx context.Context, request Request) string {
	if request.Kind == KindAnime {
		if kitsu := t.kitsuID(ctx, request.AniListID); kitsu > 0 {
			if request.Episode == nil && request.Absolute == nil {
				return fmt.Sprintf("/stream/movie/kitsu:%d.json", kitsu)
			}
			episode := request.Episode
			if episode == nil {
				episode = request.Absolute
			}
			return fmt.Sprintf("/stream/series/kitsu:%d:%d.json", kitsu, *episode)
		}
		imdb := normalizeIMDBID(request.IMDBID)
		if imdb == "" || request.Season == nil || request.Episode == nil || *request.Season < 1 || *request.Episode < 1 {
			return ""
		}
		return fmt.Sprintf("/stream/series/%s:%d:%d.json", imdb, *request.Season, *request.Episode)
	}
	return torrentioPath(request)
}

// kitsuID maps an AniList id to Kitsu through ani.zip (cached a day, misses
// included, so a missing mapping costs one lookup).
func (t *Torrentio) kitsuID(ctx context.Context, anilistID int) int {
	if anilistID <= 0 {
		return 0
	}
	t.kitsuMu.Lock()
	if entry, ok := t.kitsu[anilistID]; ok && time.Now().Before(entry.expires) {
		t.kitsuMu.Unlock()
		return entry.id
	}
	t.kitsuMu.Unlock()
	base := t.AniZipURL
	if base == "" {
		base = "https://api.ani.zip"
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	id := 0
	req, err := http.NewRequestWithContext(lookupCtx, http.MethodGet, fmt.Sprintf("%s/mappings?anilist_id=%d", strings.TrimRight(base, "/"), anilistID), nil)
	if err != nil {
		return 0
	}
	req.Header.Set("User-Agent", userAgent)
	client := t.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0 // transient: not cached, retried next search
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		var payload struct {
			Mappings struct {
				KitsuID flexString `json:"kitsu_id"`
			} `json:"mappings"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload) == nil {
			id, _ = strconv.Atoi(string(payload.Mappings.KitsuID))
		}
	}
	t.kitsuMu.Lock()
	if t.kitsu == nil {
		t.kitsu = map[int]kitsuEntry{}
	}
	t.kitsu[anilistID] = kitsuEntry{id: id, expires: time.Now().Add(24 * time.Hour)}
	t.kitsuMu.Unlock()
	return id
}

// torrentioPath is the film/TV stream path: both need an IMDb id, and TV an
// episode.
func torrentioPath(request Request) string {
	imdb := normalizeIMDBID(request.IMDBID)
	if imdb == "" {
		return ""
	}
	switch request.Kind {
	case KindMovie:
		return "/stream/movie/" + imdb + ".json"
	case KindTV:
		if request.Season == nil || request.Episode == nil || *request.Season < 1 || *request.Episode < 1 {
			return ""
		}
		return fmt.Sprintf("/stream/series/%s:%d:%d.json", imdb, *request.Season, *request.Episode)
	}
	return ""
}

// Releases fetches Torrentio's streams for the request as indexer releases.
func (t *Torrentio) Releases(ctx context.Context, request Request) ([]prowlarrRelease, error) {
	path := t.path(ctx, request)
	if path == "" {
		return nil, errors.New("torrentio: request not supported")
	}
	ctx, cancel := context.WithTimeout(ctx, torrentioTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(t.BaseURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	client := t.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("torrentio: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("torrentio: status %d", resp.StatusCode)
	}
	var payload struct {
		Streams []torrentioStream `json:"streams"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("torrentio: decode: %w", err)
	}
	releases := make([]prowlarrRelease, 0, len(payload.Streams))
	for _, stream := range payload.Streams {
		if release, ok := releaseFromTorrentio(stream); ok {
			releases = append(releases, release)
		}
	}
	return dedupeTorrentioFiles(releases), nil
}

// torrentioExtras marks bonus files Torrentio sometimes maps to an episode
// (disc menus, creditless openings, specials).
var torrentioExtras = regexp.MustCompile(`(?i)(^|/)(menu|extras?|bonus|specials?|ncop|nced|sample|scans?|特典映像|特典)(/|[\s\[._-])`)

// dedupeTorrentioFiles keeps one stream per torrent. When Torrentio lists a
// torrent several times (one per candidate file), the single non-extras file
// wins; if that is ambiguous the file index is dropped and the client picks
// the episode from the file list.
func dedupeTorrentioFiles(releases []prowlarrRelease) []prowlarrRelease {
	byHash := map[string][]int{}
	order := make([]string, 0, len(releases))
	for index, release := range releases {
		if _, seen := byHash[release.InfoHash]; !seen {
			order = append(order, release.InfoHash)
		}
		byHash[release.InfoHash] = append(byHash[release.InfoHash], index)
	}
	out := make([]prowlarrRelease, 0, len(order))
	for _, hash := range order {
		indexes := byHash[hash]
		if len(indexes) == 1 {
			out = append(out, releases[indexes[0]])
			continue
		}
		var episodes []int
		for _, index := range indexes {
			if !torrentioExtras.MatchString(releases[index].PackFile) {
				episodes = append(episodes, index)
			}
		}
		if len(episodes) == 1 {
			out = append(out, releases[episodes[0]])
			continue
		}
		release := releases[indexes[0]]
		release.FileIndex = nil
		out = append(out, release)
	}
	return out
}

// releaseFromTorrentio reads one stream. Its title is "release name" then,
// for packs, the file path, then "👤 seeders 💾 size ⚙️ site", then a row of
// language flags. Only the release name is a release title: the flags list
// every language any file carries and must not reach the audio rules.
func releaseFromTorrentio(stream torrentioStream) (prowlarrRelease, bool) {
	hash := normalizeHash(stream.InfoHash)
	lines := strings.Split(stream.Title, "\n")
	name := strings.TrimSpace(lines[0])
	if hash == "" || name == "" {
		return prowlarrRelease{}, false
	}
	release := prowlarrRelease{Title: name, Protocol: "torrent", InfoHash: hash, Indexer: "Torrentio", FileIndex: stream.FileIdx, IDMatched: true}
	// Multi-file torrents name the episode's file on the second line.
	if len(lines) > 2 && !strings.Contains(lines[1], "👤") {
		release.PackFile = strings.TrimSpace(lines[1])
	}
	for _, line := range lines[1:] {
		if !strings.Contains(line, "👤") {
			continue
		}
		if match := torrentioSeeders.FindStringSubmatch(line); match != nil {
			release.Seeders, _ = strconv.Atoi(match[1])
		}
		if match := torrentioSize.FindStringSubmatch(line); match != nil {
			release.Size = parseTorrentioSize(match[1], match[2])
		}
		if match := torrentioSource.FindStringSubmatch(line); match != nil {
			release.Indexer = "Torrentio · " + strings.TrimSpace(match[1])
		}
	}
	magnet := url.Values{}
	magnet.Set("xt", "urn:btih:"+hash)
	magnet.Set("dn", name)
	for _, source := range stream.Sources {
		if tracker, ok := strings.CutPrefix(source, "tracker:"); ok && publicTracker(tracker) {
			magnet.Add("tr", tracker)
		}
	}
	release.MagnetURL = "magnet:?" + magnet.Encode()
	return release, true
}

// publicTracker keeps tracker URLs the torrent engine may contact: udp/http/
// https on a public host. A tampered response must not make the server
// announce to localhost or devices on the home network.
func publicTracker(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "udp" && parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast())
	}
	return true
}

func parseTorrentioSize(value, unit string) int64 {
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || number < 0 {
		return 0
	}
	scale := map[string]float64{"KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}[unit]
	return int64(number * scale)
}

// fetchReleases asks Torrentio first for films, TV and anime; Prowlarr answers when
// Torrentio is off, fails (403, timeout, outage) or has nothing that passes
// the release rules.
func (s *Service) fetchReleases(ctx context.Context, request Request, key string) ([]prowlarrRelease, error) {
	if s.torrentio != nil && s.torrentio.path(ctx, request) != "" {
		releases, err := s.torrentio.Releases(ctx, request)
		switch {
		case err != nil:
			log.Printf("[search] torrentio unavailable, using prowlarr: %v", err)
		case len(s.normalize(request, releases)) == 0:
			log.Printf("[search] torrentio had no usable releases for %q, using prowlarr", request.Title)
		default:
			s.saveStored(key, releases)
			s.remember(key, s.normalize(request, releases))
			return releases, nil
		}
	}
	return s.searchAll(ctx, request, key)
}
