package search

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/anacrolix/torrent/metainfo"
	"golang.org/x/sync/singleflight"
)

const (
	defaultCacheTTL  = 3 * time.Minute
	defaultSourceTTL = 20 * time.Minute
	maxSearches      = 10
	maxTorrentSize   = 10 << 20
	// Latency is acceptable in exchange for completeness: renowned slow
	// indexers (Nyaa via FlareSolverr + VPN commonly needs 10-20s) must not
	// be cut off mid-search. Budgets align with the /v1/torrents/search
	// handler cap (55s, under the iOS WKWebView ~60s fetch idle limit):
	// per-indexer 20s + one unscoped fallback retry (20s) fits inside it.
	searchBudget  = 55 * time.Second
	indexerBudget = 20 * time.Second
)

// indexerTrust is a bounded reputation bonus for renowned sources (user
// preference: YTS for movies, Nyaa.si/SubsPlease for anime, plus the other
// established general trackers). Matched as normalized substrings of the
// indexer name Prowlarr reports. The bonus breaks near-ties between similar
// swarm health — it can never rescue a dead release over a healthy one.
var indexerTrust = map[string]float64{
	"yts":            12,
	"nyaa":           12,
	"subsplease":     12,
	"tokyotoshokan":  10,
	"eztv":           8,
	"piratebay":      8,
	"1337x":          8,
	"rarbg":          6,
	"torrentgalaxy":  6,
	"magnetdownload": 4,
}

// indexerTrustBonus maps the raw indexer string to its reputation bonus.
func indexerTrustBonus(indexer string) float64 {
	var normalized strings.Builder
	for _, r := range indexer {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			normalized.WriteRune(r)
		} else if r >= 'A' && r <= 'Z' {
			normalized.WriteRune(r + 32)
		}
	}
	name := normalized.String()
	if name == "" {
		return 0
	}
	for token, bonus := range indexerTrust {
		if strings.Contains(name, token) {
			return bonus
		}
	}
	return 0
}

var (
	hexHashPattern    = regexp.MustCompile(`(?i)^[a-f0-9]{40}$`)
	base32HashPattern = regexp.MustCompile(`(?i)^[a-z2-7]{32}$`)
	magnetHashPattern = regexp.MustCompile(`(?i)(?:^|[?&])xt=urn:btih:([a-z0-9]{32,40})(?:&|$)`)
)

type cacheEntry struct {
	expires time.Time
	results []Result
}

type sourceEntry struct {
	expires     time.Time
	downloadURL string
	resolved    *ResolveResult
}

// flexString accepts a JSON string, number, or null. Prowlarr versions
// disagree on field types (this instance returns imdbId as a NUMBER, others
// as a string) — one strict field must never discard an entire response.
type flexString string

func (s *flexString) UnmarshalJSON(data []byte) error {
	trimmed := string(bytes.TrimSpace(data))
	if trimmed == "null" || trimmed == `""` {
		*s = ""
		return nil
	}
	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		*s = flexString(value)
		return nil
	}
	// Number/bool: keep the literal text.
	*s = flexString(trimmed)
	return nil
}

type prowlarrRelease struct {
	Title       string             `json:"title"`
	Indexer     string             `json:"indexer"`
	IndexerName string             `json:"indexerName"`
	Protocol    string             `json:"protocol"`
	Size        int64              `json:"size"`
	Seeders     int                `json:"seeders"`
	Leechers    int                `json:"leechers"`
	MagnetURL   string             `json:"magnetUrl"`
	DownloadURL string             `json:"downloadUrl"`
	InfoHash    string             `json:"infoHash"`
	PublishDate string             `json:"publishDate"`
	Languages   []prowlarrLanguage `json:"languages"`
	ImdbID      flexString         `json:"imdbId"`
	// FileIndex is the episode's file inside a pack (Torrentio knows it).
	FileIndex *int `json:"fileIndex,omitempty"`
}

type prowlarrLanguage struct {
	Name string `json:"name"`
}

type prowlarrQuery struct {
	query     string
	kind      Kind
	request   Request
	indexerID int
}

// Service owns Prowlarr access, caching, concurrency, and lazy grabs.
type Service struct {
	baseURL      *url.URL
	apiKey       string
	httpClient   *http.Client
	now          func() time.Time
	cacheTTL     time.Duration
	sourceTTL    time.Duration
	mu           sync.RWMutex
	cache        map[string]cacheEntry
	sources      map[string]sourceEntry
	searchFlight singleflight.Group
	resolveGroup singleflight.Group

	store              ReleaseStore
	torrentio          *Torrentio
	softDeadline       time.Duration
	refreshing         map[string]bool
	indexerList        []indexerInfo
	indexerListExpires time.Time
}

// NewService creates a Prowlarr search service.
func NewService(baseURL, apiKey string, httpClient *http.Client) (*Service, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse prowlarr url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("prowlarr url must be an absolute http url")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("prowlarr api key is missing")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 25 * time.Second}
	}
	return &Service{
		baseURL: parsed, apiKey: apiKey, httpClient: httpClient, now: time.Now,
		cacheTTL: defaultCacheTTL, sourceTTL: defaultSourceTTL,
		cache: make(map[string]cacheEntry), sources: make(map[string]sourceEntry),
		refreshing: make(map[string]bool), softDeadline: softDeadline,
	}, nil
}

// Resolve performs the one Prowlarr grab authorized by a user's selection.
func (s *Service) Resolve(ctx context.Context, request ResolveRequest) (ResolveResult, error) {
	if magnet := strings.TrimSpace(request.Magnet); strings.HasPrefix(strings.ToLower(magnet), "magnet:?") {
		return ResolveResult{MagnetURI: magnet, InfoHash: hashFromMagnet(magnet)}, nil
	}
	if hash := normalizeHash(request.InfoHash); hash != "" {
		return ResolveResult{MagnetURI: magnetFromHash(hash), InfoHash: hash}, nil
	}
	if request.SourceID == "" {
		return ResolveResult{}, errors.New("source id, magnet uri, or info hash is required")
	}

	resultChannel := s.resolveGroup.DoChan(request.SourceID, func() (any, error) {
		entry, ok := s.source(request.SourceID)
		if !ok {
			return ResolveResult{}, errors.New("source expired; refresh search results and try again")
		}
		if entry.resolved != nil {
			return *entry.resolved, nil
		}
		resolved, resolveErr := s.resolveDownload(ctx, entry.downloadURL)
		if resolveErr != nil {
			return ResolveResult{}, resolveErr
		}
		s.mu.Lock()
		entry.resolved = &resolved
		s.sources[request.SourceID] = entry
		s.mu.Unlock()
		return resolved, nil
	})
	var flightResult singleflight.Result
	select {
	case <-ctx.Done():
		return ResolveResult{}, ctx.Err()
	case flightResult = <-resultChannel:
	}
	if flightResult.Err != nil {
		return ResolveResult{}, flightResult.Err
	}
	resolved, ok := flightResult.Val.(ResolveResult)
	if !ok {
		return ResolveResult{}, errors.New("unexpected resolved source type")
	}
	return resolved, nil
}

func (s *Service) cached(key string) ([]Result, bool) {
	s.mu.RLock()
	entry, ok := s.cache[key]
	s.mu.RUnlock()
	if !ok || !s.now().Before(entry.expires) {
		return nil, false
	}
	return slices.Clone(entry.results), true
}

func (s *Service) source(id string) (sourceEntry, bool) {
	s.mu.RLock()
	entry, ok := s.sources[id]
	s.mu.RUnlock()
	return entry, ok && s.now().Before(entry.expires)
}

func (s *Service) query(ctx context.Context, query prowlarrQuery) ([]prowlarrRelease, error) {
	endpoint := s.baseURL.ResolveReference(&url.URL{Path: "/api/v1/search"})
	params := endpoint.Query()
	params.Set("query", query.query)
	params.Set("limit", "100")
	if query.indexerID > 0 {
		params.Set("indexerIds", strconv.Itoa(query.indexerID))
	}
	switch query.kind {
	case KindMovie:
		params.Set("type", "movie")
		for _, category := range []string{"2000", "2040", "2045", "2050", "2080"} {
			params.Add("categories", category)
		}
		if imdb := normalizeIMDBID(query.request.IMDBID); imdb != "" {
			params.Set("imdbId", imdb)
		}
	case KindTV:
		params.Set("type", "tvsearch")
		for _, category := range []string{"5000", "5010", "5020", "5030", "5040", "5050", "5060", "5070", "5080"} {
			params.Add("categories", category)
		}
		setEpisodeParams(params, query.request)
	case KindAnime:
		params.Set("type", "search")
		params.Add("categories", "5070")
		params.Set("limit", "75")
	}
	endpoint.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create prowlarr request: %w", err)
	}
	req.Header.Set("X-Api-Key", s.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("search prowlarr for %q: %w", query.query, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("search prowlarr for %q: status %d: %s", query.query, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var raw json.RawMessage
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode prowlarr search for %q: %w", query.query, err)
	}
	// Prowlarr returns either an array (including a successful empty array)
	// or a wrapper object. Decide the shape before decoding releases.
	if trimmed := strings.TrimSpace(string(raw)); strings.HasPrefix(trimmed, "{") {
		var wrapped struct {
			Results []prowlarrRelease `json:"results"`
			Data    []prowlarrRelease `json:"data"`
		}
		if err := json.Unmarshal(raw, &wrapped); err != nil {
			return nil, fmt.Errorf("decode wrapped prowlarr search: %w", err)
		}
		if wrapped.Results != nil {
			return wrapped.Results, nil
		}
		return wrapped.Data, nil
	}
	var releases []prowlarrRelease
	decodeErr := json.Unmarshal(raw, &releases)
	if decodeErr != nil {
		// Lenient fallback: decode release-by-release so ONE malformed field
		// can never discard the whole indexer response. This was observed in
		// the wild: a Prowlarr build returning numeric imdbId rejected every
		// healthy response and produced zero results everywhere.
		var rawReleases []json.RawMessage
		if rawErr := json.Unmarshal(raw, &rawReleases); rawErr == nil {
			for _, rawRelease := range rawReleases {
				var release prowlarrRelease
				if err := json.Unmarshal(rawRelease, &release); err == nil {
					releases = append(releases, release)
				}
			}
		}
		if len(releases) == 0 {
			return nil, fmt.Errorf("decode prowlarr search for %q: %w", query.query, decodeErr)
		}
		log.Printf("[search] lenient decode kept %d releases for %q (strict decode failed: %v)", len(releases), query.query, decodeErr)
	}
	return releases, nil
}

func setEpisodeParams(params url.Values, request Request) {
	if request.Season != nil {
		params.Set("season", strconv.Itoa(*request.Season))
	}
	if request.Episode != nil {
		params.Set("episode", strconv.Itoa(*request.Episode))
	}
	if imdb := normalizeIMDBID(request.IMDBID); imdb != "" {
		params.Set("imdbId", imdb)
	}
	if request.TVDBID > 0 {
		params.Set("tvdbId", strconv.Itoa(request.TVDBID))
	}
}

func (s *Service) normalize(request Request, releases []prowlarrRelease) []Result {
	results := make([]Result, 0, len(releases))
	resultByKey := make(map[string]int, len(releases)*2)
	episodeRequested := request.Episode != nil || request.Absolute != nil
	known := buildKnownTitles(request)
	for _, release := range releases {
		if release.Protocol != "" && !strings.EqualFold(release.Protocol, "torrent") {
			continue
		}
		// One Sonarr-style decision per release: exact title, season/episode
		// coverage, quality and audio. Rejected releases never reach ranking.
		decision := decideRelease(request, known, release)
		if decision.reject {
			continue
		}
		hash := normalizeHash(release.InfoHash)
		rawMagnet := strings.TrimSpace(release.MagnetURL)
		magnet := ""
		if strings.HasPrefix(strings.ToLower(rawMagnet), "magnet:?") {
			magnet = rawMagnet
		}
		if hash == "" {
			hash = hashFromMagnet(magnet)
		}
		if magnet == "" && hash != "" {
			magnet = magnetFromHash(hash)
		}
		sourceID := ""
		if magnet != "" {
			// Every rendered source gets a short-lived opaque id. Playback keeps
			// the existing magnet/info-hash fields for backwards compatibility,
			// while downloads can refer to the exact user-selected result without
			// sending a magnet or an indexer URL back across the API boundary.
			sourceID = s.rememberResolvedSource(ResolveResult{MagnetURI: magnet, InfoHash: hash})
		} else {
			downloadCandidate := strings.TrimSpace(release.DownloadURL)
			// Some Prowlarr/indexer combinations put their HTTP grab endpoint in
			// magnetUrl. It is not a magnet and must be resolved server-side.
			if downloadCandidate == "" {
				downloadCandidate = rawMagnet
			}
			downloadURL, ok := s.safeDownloadURL(downloadCandidate)
			if !ok {
				continue
			}
			sourceID = s.rememberSource(downloadURL)
		}
		indexer := release.Indexer
		if indexer == "" {
			indexer = release.IndexerName
		}
		result := Result{Title: release.Title, Indexer: indexer, Size: release.Size, Seeders: release.Seeders, Leechers: release.Leechers, MagnetURI: magnet, InfoHash: hash, SourceID: sourceID, PublishDate: release.PublishDate, FileIndex: release.FileIndex,
			languageRank: decision.languageRank, verified: decision.class == classVerified, packTier: int(decision.pack), qualityTier: decision.qualityTier}
		applyBadges(&result, request, decision)
		if episodeRequested {
			matched := decision.episodeMatch
			result.EpisodeMatch = &matched
			if decision.pack != packNone {
				result.SeasonPack = &SeasonPack{Season: request.Season, Reason: decision.packReason, Keywords: []string{decision.packReason}}
			}
		}
		keys := resultIdentityKeys(result)
		duplicateIndex := -1
		for _, key := range keys {
			if index, ok := resultByKey[key]; ok {
				duplicateIndex = index
				break
			}
		}
		if duplicateIndex >= 0 {
			if betterResult(result, results[duplicateIndex]) {
				results[duplicateIndex] = result
			}
			for _, key := range keys {
				resultByKey[key] = duplicateIndex
			}
			continue
		}
		resultIndex := len(results)
		results = append(results, result)
		for _, key := range keys {
			resultByKey[key] = resultIndex
		}
	}
	if episodeRequested {
		// NO fallback: when an episode was requested, releases with NO
		// matching evidence are dropped instead of surfacing the whole raw
		// indexer dump. If nothing at all matched, the answer is "no
		// episode results" — never unrelated releases.
		matched := make([]Result, 0, len(results))
		for _, result := range results {
			if (result.EpisodeMatch != nil && *result.EpisodeMatch) || result.verified {
				matched = append(matched, result)
			}
		}
		if len(matched) == 0 {
			return []Result{}
		}
		results = matched
	}
	// Dead swarms (seeders <= 0) are dropped when enough live alternatives
	// exist; otherwise they stay, ranked last.
	alive := 0
	for _, result := range results {
		if result.Seeders > 0 {
			alive++
		}
	}
	if alive >= 5 && alive < len(results) {
		kept := results[:0]
		for _, result := range results {
			if result.Seeders > 0 {
				kept = append(kept, result)
			}
		}
		results = kept
	}
	// Ranking: live swarms first, then verified evidence, then what the
	// torrent covers (exact episode, then packs), quality, original audio,
	// and finally swarm size; indexer trust only breaks near ties.
	sort.SliceStable(results, func(i, j int) bool {
		a, b := results[i], results[j]
		if (a.Seeders > 0) != (b.Seeders > 0) {
			return a.Seeders > 0
		}
		// A one- or two-seeder torrent barely streams; healthy swarms of any
		// coverage come first.
		if healthy(a) != healthy(b) {
			return healthy(a)
		}
		if a.verified != b.verified {
			return a.verified
		}
		if a.packTier != b.packTier {
			return a.packTier < b.packTier
		}
		if a.qualityTier != b.qualityTier {
			return a.qualityTier < b.qualityTier
		}
		if (a.languageRank >= 2) != (b.languageRank >= 2) {
			return a.languageRank >= 2
		}
		return betterSwarm(a, b)
	})
	return results
}

// torrentHealthScore is swarm size on a log scale (10 points per doubling)
// plus the bounded indexer-trust bonus; it picks the better copy of a
// duplicated release.
func torrentHealthScore(result Result) float64 {
	return seederScore(result.Seeders)*10 + indexerTrustBonus(result.Indexer)
}

func healthy(result Result) bool { return result.Seeders >= 3 }

// betterSwarm orders by seeders. Indexer trust (YTS, Nyaa...) only decides
// when the swarms are within about 15% of each other.
func betterSwarm(a, b Result) bool {
	if gap := seederScore(a.Seeders) - seederScore(b.Seeders); gap > 0.2 || gap < -0.2 {
		return gap > 0
	}
	if ta, tb := indexerTrustBonus(a.Indexer), indexerTrustBonus(b.Indexer); ta != tb {
		return ta > tb
	}
	if a.Seeders != b.Seeders {
		return a.Seeders > b.Seeders
	}
	return a.Size < b.Size
}

func resultIdentityKeys(result Result) []string {
	keys := make([]string, 0, 2)
	if result.InfoHash != "" {
		keys = append(keys, "hash:"+result.InfoHash)
	}
	if result.Size > 0 {
		var normalized strings.Builder
		for _, character := range strings.ToLower(result.Title) {
			if unicode.IsLetter(character) || unicode.IsNumber(character) {
				normalized.WriteRune(character)
			} else {
				normalized.WriteByte(' ')
			}
		}
		name := strings.Join(strings.Fields(normalized.String()), " ")
		if name != "" {
			keys = append(keys, "release:"+name+"\x00"+strconv.FormatInt(result.Size, 10))
		}
	}
	if len(keys) == 0 {
		keys = append(keys, "source:"+strings.ToLower(strings.TrimSpace(result.Title))+"\x00"+strings.ToLower(result.Indexer))
	}
	return keys
}

func betterResult(candidate, current Result) bool {
	if candidateScore, currentScore := torrentHealthScore(candidate), torrentHealthScore(current); candidateScore != currentScore {
		return candidateScore > currentScore
	}
	if (candidate.MagnetURI != "") != (current.MagnetURI != "") {
		return candidate.MagnetURI != ""
	}
	return candidate.InfoHash != "" && current.InfoHash == ""
}

func (s *Service) safeDownloadURL(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || raw == "" {
		return "", false
	}
	resolved := s.baseURL.ResolveReference(parsed)
	if !strings.EqualFold(resolved.Scheme, s.baseURL.Scheme) || !strings.EqualFold(resolved.Host, s.baseURL.Host) {
		return "", false
	}
	if !strings.Contains(strings.ToLower(resolved.Path), "/download") {
		return "", false
	}
	return resolved.String(), true
}

func (s *Service) rememberSource(downloadURL string) string {
	digest := sha256.Sum256([]byte(downloadURL))
	id := hex.EncodeToString(digest[:16])
	s.mu.Lock()
	s.pruneExpiredLocked()
	s.sources[id] = sourceEntry{expires: s.now().Add(s.sourceTTL), downloadURL: downloadURL}
	s.mu.Unlock()
	return id
}

func (s *Service) rememberResolvedSource(resolved ResolveResult) string {
	digest := sha256.Sum256([]byte(resolved.MagnetURI))
	id := hex.EncodeToString(digest[:16])
	s.mu.Lock()
	s.pruneExpiredLocked()
	s.sources[id] = sourceEntry{expires: s.now().Add(s.sourceTTL), resolved: &resolved}
	s.mu.Unlock()
	return id
}

func (s *Service) pruneExpiredLocked() {
	now := s.now()
	for key, entry := range s.cache {
		if !now.Before(entry.expires) {
			delete(s.cache, key)
		}
	}
	for id, entry := range s.sources {
		if !now.Before(entry.expires) {
			delete(s.sources, id)
		}
	}
}

func (s *Service) resolveDownload(ctx context.Context, rawURL string) (ResolveResult, error) {
	current := rawURL
	client := *s.httpClient
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	for redirects := 0; redirects < 4; redirects++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current, nil)
		if err != nil {
			return ResolveResult{}, fmt.Errorf("create prowlarr download request: %w", err)
		}
		req.Header.Set("X-Api-Key", s.apiKey)
		resp, err := client.Do(req)
		if err != nil {
			return ResolveResult{}, fmt.Errorf("download selected torrent: %w", err)
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			resp.Body.Close()
			if strings.HasPrefix(strings.ToLower(location), "magnet:?") {
				hash := hashFromMagnet(location)
				return ResolveResult{MagnetURI: location, InfoHash: hash}, nil
			}
			next, ok := s.safeDownloadURL(location)
			if !ok {
				return ResolveResult{}, errors.New("prowlarr returned an unsafe download redirect")
			}
			current = next
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			return ResolveResult{}, fmt.Errorf("download selected torrent: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		contents, readErr := io.ReadAll(io.LimitReader(resp.Body, maxTorrentSize+1))
		resp.Body.Close()
		if readErr != nil {
			return ResolveResult{}, fmt.Errorf("read selected torrent: %w", readErr)
		}
		if len(contents) > maxTorrentSize {
			return ResolveResult{}, errors.New("selected torrent file exceeds 10 MiB")
		}
		meta, err := metainfo.Load(bytes.NewReader(contents))
		if err != nil {
			return ResolveResult{}, fmt.Errorf("parse selected torrent: %w", err)
		}
		hash := strings.ToUpper(meta.HashInfoBytes().HexString())
		return ResolveResult{MagnetURI: magnetFromHash(hash), InfoHash: hash}, nil
	}
	return ResolveResult{}, errors.New("too many Prowlarr download redirects")
}

func normalizeIMDBID(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "tt")
	if value == "" {
		return ""
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return ""
		}
	}
	return "tt" + value
}

func normalizeHash(value string) string {
	value = strings.TrimSpace(value)
	if hexHashPattern.MatchString(value) {
		return strings.ToUpper(value)
	}
	if base32HashPattern.MatchString(value) {
		decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(value))
		if err == nil && len(decoded) == 20 {
			return strings.ToUpper(hex.EncodeToString(decoded))
		}
	}
	return ""
}

func hashFromMagnet(magnet string) string {
	match := magnetHashPattern.FindStringSubmatch(magnet)
	if len(match) != 2 {
		return ""
	}
	decoded, err := url.QueryUnescape(match[1])
	if err != nil {
		return ""
	}
	return normalizeHash(decoded)
}

func magnetFromHash(hash string) string {
	return "magnet:?xt=urn:btih:" + hash
}
