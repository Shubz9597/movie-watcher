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
	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

const (
	defaultCacheTTL  = 3 * time.Minute
	defaultSourceTTL = 20 * time.Minute
	maxSearches      = 4
	maxTorrentSize   = 10 << 20
)

var (
	hexHashPattern    = regexp.MustCompile(`(?i)^[a-f0-9]{40}$`)
	base32HashPattern = regexp.MustCompile(`(?i)^[a-z2-7]{32}$`)
	magnetHashPattern = regexp.MustCompile(`(?i)(?:^|[?&])xt=urn:btih:([a-z0-9]{32,40})(?:&|$)`)
	seasonEpisode     = regexp.MustCompile(`(?i)\bS(\d{1,2})[ ._-]*E(\d{1,3})\b`)
	episodeToken      = regexp.MustCompile(`(?i)\b(?:EP?|Episode|#)[ ._-]*(\d{1,4})\b`)
	packToken         = regexp.MustCompile(`(?i)\b(complete|batch|season[ ._-]*pack|full[ ._-]*season|collection)\b`)
	episodeRange      = regexp.MustCompile(`(?i)\b(?:EP?|Episodes?)?[ ._-]*(\d{1,3})[ ._-]*(?:-|to)[ ._-]*(\d{1,3})\b`)
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
}

type prowlarrLanguage struct {
	Name string `json:"name"`
}

type prowlarrQuery struct {
	query   string
	kind    Kind
	request Request
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
	}, nil
}

// Search concurrently runs bounded title variants and returns renderer-safe results.
func (s *Service) Search(ctx context.Context, request Request) (Response, error) {
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		return Response{}, errors.New("title is required")
	}
	if request.Kind != KindMovie && request.Kind != KindTV && request.Kind != KindAnime {
		return Response{}, errors.New("kind must be movie, tv, or anime")
	}
	keyBytes, err := json.Marshal(request)
	if err != nil {
		return Response{}, fmt.Errorf("encode search key: %w", err)
	}
	key := string(keyBytes)
	if cached, ok := s.cached(key); ok {
		return Response{Query: request, Total: len(cached), Results: cached}, nil
	}

	resultChannel := s.searchFlight.DoChan(key, func() (any, error) {
		if cached, ok := s.cached(key); ok {
			return cached, nil
		}
		releases, queryErr := s.searchAll(ctx, request)
		if queryErr != nil {
			return nil, queryErr
		}
		results := s.normalize(request, releases)
		s.mu.Lock()
		s.pruneExpiredLocked()
		s.cache[key] = cacheEntry{expires: s.now().Add(s.cacheTTL), results: slices.Clone(results)}
		s.mu.Unlock()
		return results, nil
	})
	var flightResult singleflight.Result
	select {
	case <-ctx.Done():
		return Response{}, ctx.Err()
	case flightResult = <-resultChannel:
	}
	if flightResult.Err != nil {
		return Response{}, flightResult.Err
	}
	results, ok := flightResult.Val.([]Result)
	if !ok {
		return Response{}, errors.New("unexpected search result type")
	}
	results = slices.Clone(results)
	return Response{Query: request, Total: len(results), Results: results}, nil
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

func (s *Service) searchAll(ctx context.Context, request Request) ([]prowlarrRelease, error) {
	queries := buildQueries(request)
	var (
		mu       sync.Mutex
		releases []prowlarrRelease
		errs     []error
	)
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(maxSearches)
	for _, query := range queries {
		query := query
		group.Go(func() error {
			found, err := s.query(groupCtx, query)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return nil
			}
			releases = append(releases, found...)
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return nil, fmt.Errorf("wait for prowlarr searches: %w", err)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(releases) == 0 && len(errs) > 0 {
		return nil, fmt.Errorf("all prowlarr searches failed: %w", errors.Join(errs...))
	}
	return releases, nil
}

func buildQueries(request Request) []prowlarrQuery {
	titles := append([]string{request.Title}, request.Aliases...)
	seen := make(map[string]struct{}, len(titles))
	queries := make([]prowlarrQuery, 0, min(len(titles), maxSearches))
	for _, title := range titles {
		title = strings.TrimSpace(title)
		key := strings.ToLower(title)
		if title == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		query := title
		if request.Kind == KindMovie && request.Year > 0 {
			query += " " + strconv.Itoa(request.Year)
		}
		if request.Kind == KindAnime {
			episode := request.Episode
			if request.Absolute != nil {
				episode = request.Absolute
			}
			if episode != nil {
				query += fmt.Sprintf(" %02d", *episode)
			}
		}
		queries = append(queries, prowlarrQuery{query: query, kind: request.Kind, request: request})
		if len(queries) == maxSearches {
			break
		}
	}
	if hint := queryLanguageHint(request); hint != "" && len(queries) < maxSearches && len(queries) > 0 {
		hinted := queries[0]
		hinted.query += " " + hint
		queries = append(queries, hinted)
	}
	return queries
}

func (s *Service) query(ctx context.Context, query prowlarrQuery) ([]prowlarrRelease, error) {
	endpoint := s.baseURL.ResolveReference(&url.URL{Path: "/api/v1/search"})
	params := endpoint.Query()
	params.Set("query", query.query)
	params.Set("limit", "100")
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
	var releases []prowlarrRelease
	if err := json.Unmarshal(raw, &releases); err == nil {
		return releases, nil
	}
	var wrapped struct {
		Results []prowlarrRelease `json:"results"`
		Data    []prowlarrRelease `json:"data"`
	}
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		return nil, fmt.Errorf("decode wrapped prowlarr search for %q: %w", query.query, err)
	}
	if wrapped.Results != nil {
		return wrapped.Results, nil
	}
	return wrapped.Data, nil
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
	for _, release := range releases {
		if release.Protocol != "" && !strings.EqualFold(release.Protocol, "torrent") {
			continue
		}
		if request.Kind == KindAnime && !animeReleaseRelevant(request, release.Title) {
			continue
		}
		languageRank, allowed := releaseLanguageRank(request, release)
		if !allowed {
			continue
		}
		hash := normalizeHash(release.InfoHash)
		magnet := strings.TrimSpace(release.MagnetURL)
		if hash == "" {
			hash = hashFromMagnet(magnet)
		}
		if magnet == "" && hash != "" {
			magnet = magnetFromHash(hash)
		}
		sourceID := ""
		if magnet == "" {
			downloadURL, ok := s.safeDownloadURL(release.DownloadURL)
			if !ok {
				continue
			}
			sourceID = s.rememberSource(downloadURL)
		}
		indexer := release.Indexer
		if indexer == "" {
			indexer = release.IndexerName
		}
		result := Result{Title: release.Title, Indexer: indexer, Size: release.Size, Seeders: release.Seeders, Leechers: release.Leechers, MagnetURI: magnet, InfoHash: hash, SourceID: sourceID, PublishDate: release.PublishDate, languageRank: languageRank}
		if request.Episode != nil {
			matched := matchesEpisode(release.Title, request.Season, request.Episode, request.Absolute)
			result.EpisodeMatch = &matched
			result.SeasonPack = detectSeasonPack(release.Title, request.Season, request.Episode)
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
	if request.Episode != nil {
		exact := make([]Result, 0, len(results))
		packs := make([]Result, 0, len(results))
		for _, result := range results {
			if result.EpisodeMatch != nil && *result.EpisodeMatch && result.SeasonPack == nil {
				exact = append(exact, result)
			} else if result.SeasonPack != nil {
				packs = append(packs, result)
			}
		}
		if len(exact) > 0 {
			results = exact
		} else if len(packs) > 0 {
			results = packs
		}
	}
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].languageRank != results[j].languageRank {
			return results[i].languageRank > results[j].languageRank
		}
		if results[i].Seeders != results[j].Seeders {
			return results[i].Seeders > results[j].Seeders
		}
		return results[i].Size < results[j].Size
	})
	return results
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
	if candidate.languageRank != current.languageRank {
		return candidate.languageRank > current.languageRank
	}
	if candidate.Seeders != current.Seeders {
		return candidate.Seeders > current.Seeders
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

func matchesEpisode(title string, season, episode, absolute *int) bool {
	for _, match := range seasonEpisode.FindAllStringSubmatch(title, -1) {
		foundSeason, _ := strconv.Atoi(match[1])
		foundEpisode, _ := strconv.Atoi(match[2])
		if episode != nil && foundEpisode == *episode && (season == nil || foundSeason == *season) {
			return true
		}
	}
	target := episode
	if absolute != nil {
		target = absolute
	}
	if target == nil {
		return false
	}
	for _, match := range episodeToken.FindAllStringSubmatch(title, -1) {
		found, _ := strconv.Atoi(match[1])
		if found == *target {
			return true
		}
	}
	if absolute != nil {
		looseToken := regexp.MustCompile(`(?i)\b0*` + strconv.Itoa(*absolute) + `\b`)
		if looseToken.MatchString(title) {
			return true
		}
	}
	return false
}

func detectSeasonPack(title string, season, episode *int) *SeasonPack {
	if match := packToken.FindStringSubmatch(title); len(match) == 2 {
		return &SeasonPack{Season: season, Reason: "keyword", Keywords: []string{strings.ToLower(match[1])}}
	}
	if episode == nil {
		return nil
	}
	for _, match := range episodeRange.FindAllStringSubmatch(title, -1) {
		start, _ := strconv.Atoi(match[1])
		end, _ := strconv.Atoi(match[2])
		if start <= *episode && *episode <= end {
			return &SeasonPack{Season: season, Reason: "episode-range", Keywords: []string{match[0]}}
		}
	}
	return nil
}
