package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

// Search flow: memory cache, then the persistent release cache (served at
// once, refreshed in the background when stale), then a live Prowlarr
// search that returns as soon as the fast and primary indexers answered and
// finishes the slow ones in the background.

// ReleaseStore persists raw indexer releases between restarts. Only
// magnet/info-hash releases are stored: indexer download URLs carry the
// Prowlarr API key and are never written.
type ReleaseStore interface {
	LoadReleases(ctx context.Context, key string) (payload []byte, fetchedAt time.Time, ok bool, err error)
	SaveReleases(ctx context.Context, key string, payload []byte) error
}

const (
	storeFreshTTL = 30 * time.Minute
	storeStaleTTL = 72 * time.Hour
	// softDeadline: after this, a search returns what it has once the
	// kind's primary indexers answered; stragglers finish in the background.
	softDeadline     = 5 * time.Second
	indexerListTTL   = time.Minute
	maxQueryVariants = 3
)

// SetStore enables the persistent release cache.
func (s *Service) SetStore(store ReleaseStore) { s.store = store }

// Search returns ranked, renderer-safe results for one request.
func (s *Service) Search(ctx context.Context, request Request) (Response, error) {
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		return Response{}, errors.New("title is required")
	}
	if request.Kind != KindMovie && request.Kind != KindTV && request.Kind != KindAnime {
		return Response{}, errors.New("kind must be movie, tv, or anime")
	}
	key := searchKey(request)
	if cached, ok := s.cached(key); ok {
		s.prefetchNextEpisode(request)
		return Response{Query: request, Total: len(cached), Results: cached}, nil
	}

	resultChannel := s.searchFlight.DoChan(key, func() (any, error) {
		if cached, ok := s.cached(key); ok {
			return cached, nil
		}
		if releases, fetchedAt, ok := s.loadStored(ctx, key); ok {
			results := s.normalize(request, releases)
			s.remember(key, results)
			if s.now().Sub(fetchedAt) > storeFreshTTL {
				s.refreshInBackground(request, key)
			}
			return results, nil
		}
		releases, err := s.searchAll(ctx, request, key)
		if err != nil {
			return nil, err
		}
		results := s.normalize(request, releases)
		s.remember(key, results)
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
	s.prefetchNextEpisode(request)
	results = slices.Clone(results)
	return Response{Query: request, Total: len(results), Results: results}, nil
}

// searchKey identifies a request by what it asks for, not by the alias list
// a client happened to send, so prefetches and persisted results line up.
func searchKey(request Request) string {
	value := func(pointer *int) string {
		if pointer == nil {
			return "-"
		}
		return strconv.Itoa(*pointer)
	}
	return strings.Join([]string{
		"v2", string(request.Kind), normalizeAnimeTitle(request.Title), strconv.Itoa(request.Year),
		value(request.Season), value(request.Episode), value(request.Absolute),
		string(normalizeLanguage(request.OriginalLanguage)), normalizeIMDBID(request.IMDBID),
	}, "|")
}

func (s *Service) remember(key string, results []Result) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredLocked()
	s.cache[key] = cacheEntry{expires: s.now().Add(s.cacheTTL), results: slices.Clone(results)}
}

func (s *Service) loadStored(ctx context.Context, key string) ([]prowlarrRelease, time.Time, bool) {
	if s.store == nil {
		return nil, time.Time{}, false
	}
	payload, fetchedAt, ok, err := s.store.LoadReleases(ctx, key)
	if err != nil || !ok || s.now().Sub(fetchedAt) > storeStaleTTL {
		return nil, time.Time{}, false
	}
	var releases []prowlarrRelease
	if json.Unmarshal(payload, &releases) != nil || len(releases) == 0 {
		return nil, time.Time{}, false
	}
	return releases, fetchedAt, true
}

func (s *Service) saveStored(key string, releases []prowlarrRelease) {
	if s.store == nil {
		return
	}
	keep := make([]prowlarrRelease, 0, len(releases))
	for _, release := range releases {
		if normalizeHash(release.InfoHash) == "" && !strings.HasPrefix(strings.ToLower(release.MagnetURL), "magnet:?") {
			continue // grab URLs carry the indexer API key
		}
		release.DownloadURL = ""
		keep = append(keep, release)
	}
	if len(keep) == 0 {
		return
	}
	payload, err := json.Marshal(keep)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.store.SaveReleases(ctx, key, payload); err != nil {
		log.Printf("[search] save release cache: %v", err)
	}
}

// refreshInBackground re-runs a stale search once; concurrent callers share it.
func (s *Service) refreshInBackground(request Request, key string) {
	s.mu.Lock()
	if s.refreshing[key] {
		s.mu.Unlock()
		return
	}
	s.refreshing[key] = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.refreshing, key)
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), searchBudget)
		defer cancel()
		if releases, err := s.searchAll(ctx, request, key); err == nil {
			s.remember(key, s.normalize(request, releases))
		}
	}()
}

// prefetchNextEpisode warms the next episode's sources while this one plays.
func (s *Service) prefetchNextEpisode(request Request) {
	if request.Episode == nil || s.store == nil {
		return
	}
	next := request
	episode := *request.Episode + 1
	next.Episode = &episode
	if request.Absolute != nil {
		absolute := *request.Absolute + 1
		next.Absolute = &absolute
	}
	key := searchKey(next)
	if _, ok := s.cached(key); ok {
		return
	}
	if _, fetchedAt, ok, err := s.store.LoadReleases(context.Background(), key); err == nil && ok && s.now().Sub(fetchedAt) < storeFreshTTL {
		return
	}
	s.refreshInBackground(next, key)
}

// searchCollector gathers one search's indexer answers. A search may return
// before every indexer answered; the collector keeps running and stores the
// complete set when the last one finishes.
type searchCollector struct {
	mu             sync.Mutex
	releases       []prowlarrRelease
	errs           []error
	primaryPending int
	changed        chan struct{}
	done           chan struct{}
}

func (c *searchCollector) add(found []prowlarrRelease, err error, primary bool) {
	c.mu.Lock()
	if err != nil {
		c.errs = append(c.errs, err)
	} else {
		c.releases = append(c.releases, found...)
	}
	if primary {
		c.primaryPending--
	}
	c.mu.Unlock()
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

func (c *searchCollector) snapshot() ([]prowlarrRelease, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.releases), c.primaryPending
}

func (s *Service) searchAll(ctx context.Context, request Request, key string) ([]prowlarrRelease, error) {
	// The searches outlive this request when it returns early; their budget
	// is the search budget, not the caller's context.
	runCtx, cancelRun := context.WithTimeout(context.WithoutCancel(ctx), searchBudget)
	indexers, err := s.enabledIndexers(runCtx)
	if err != nil {
		cancelRun()
		return nil, err
	}
	routed := make([]indexerInfo, 0, len(indexers))
	for _, indexer := range indexers {
		if indexerServes(indexer.Name, request) {
			routed = append(routed, indexer)
		}
	}
	if len(routed) == 0 {
		routed = indexers
	}
	variants := buildQueries(request)
	collector := &searchCollector{changed: make(chan struct{}, 1), done: make(chan struct{})}
	type plannedQuery struct {
		query   prowlarrQuery
		primary bool
	}
	var planned []plannedQuery
	// The primary title goes to every indexer before any alias is tried.
	for _, variant := range variants {
		for _, indexer := range routed {
			query := variant
			query.indexerID = indexer.ID
			primary := primaryIndexer(indexer.Name, request)
			if primary {
				collector.primaryPending++
			}
			planned = append(planned, plannedQuery{query, primary})
		}
	}

	go func() {
		defer cancelRun()
		defer close(collector.done)
		group, groupCtx := errgroup.WithContext(runCtx)
		group.SetLimit(maxSearches)
		for _, item := range planned {
			if groupCtx.Err() != nil {
				collector.add(nil, groupCtx.Err(), item.primary)
				continue
			}
			group.Go(func() error {
				indexerCtx, cancel := context.WithTimeout(groupCtx, indexerBudget)
				defer cancel()
				found, err := s.query(indexerCtx, item.query)
				collector.add(found, err, item.primary)
				return nil
			})
		}
		_ = group.Wait()
		releases, _ := collector.snapshot()
		if len(releases) == 0 && len(variants) > 0 {
			// Per-indexer queries fail hard when one tracker is down
			// ("all selected indexers being unavailable"); an unscoped query
			// lets Prowlarr skip the broken one.
			retry := variants[0]
			retry.indexerID = 0
			found, retryErr := s.query(runCtx, retry)
			collector.mu.Lock()
			if retryErr != nil {
				collector.errs = append(collector.errs, retryErr)
			} else {
				collector.releases = append(collector.releases, found...)
			}
			collector.mu.Unlock()
			releases, _ = collector.snapshot()
		}
		if len(releases) > 0 {
			s.saveStored(key, releases)
			s.remember(key, s.normalize(request, releases))
		}
	}()

	soft := time.NewTimer(s.softDeadline)
	defer soft.Stop()
	softPassed := false
	for {
		select {
		case <-collector.done:
			releases, _ := collector.snapshot()
			if len(releases) == 0 {
				collector.mu.Lock()
				errs := slices.Clone(collector.errs)
				collector.mu.Unlock()
				if len(errs) > 0 {
					return nil, fmt.Errorf("all prowlarr searches failed: %w", errors.Join(errs...))
				}
			}
			return releases, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-soft.C:
			softPassed = true
		case <-collector.changed:
		}
		if softPassed {
			if releases, primaryPending := collector.snapshot(); primaryPending <= 0 && len(releases) > 0 {
				return releases, nil
			}
		}
	}
}

type indexerInfo struct {
	ID   int
	Name string
}

func (s *Service) enabledIndexers(ctx context.Context) ([]indexerInfo, error) {
	s.mu.RLock()
	if s.indexerList != nil && s.now().Before(s.indexerListExpires) {
		list := slices.Clone(s.indexerList)
		s.mu.RUnlock()
		return list, nil
	}
	s.mu.RUnlock()

	endpoint := s.baseURL.ResolveReference(&url.URL{Path: "/api/v1/indexer"})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create indexer list request: %w", err)
	}
	req.Header.Set("X-Api-Key", s.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list prowlarr indexers: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list prowlarr indexers: status %d", resp.StatusCode)
	}
	var indexers []struct {
		ID       int    `json:"id"`
		Name     string `json:"name"`
		Enable   bool   `json:"enable"`
		Protocol string `json:"protocol"`
		Priority int    `json:"priority"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&indexers); err != nil {
		return nil, fmt.Errorf("decode prowlarr indexers: %w", err)
	}
	sort.SliceStable(indexers, func(i, j int) bool { return indexers[i].Priority < indexers[j].Priority })
	list := make([]indexerInfo, 0, len(indexers))
	for _, indexer := range indexers {
		if indexer.Enable && indexer.ID > 0 && indexer.Protocol == "torrent" {
			list = append(list, indexerInfo{ID: indexer.ID, Name: indexer.Name})
		}
	}
	if len(list) == 0 {
		return nil, errors.New("no enabled torrent indexers in prowlarr")
	}
	s.mu.Lock()
	s.indexerList, s.indexerListExpires = slices.Clone(list), s.now().Add(indexerListTTL)
	s.mu.Unlock()
	return list, nil
}

// Indexer routing: specialist trackers only get the kind they carry; general
// trackers (and any indexer the operator added) get every kind.
var (
	animeOnlyIndexers = []string{"nyaa", "animetosho", "subsplease", "tokyotosho", "anidex", "bangumi", "shana", "dmhy", "mikan", "acgrip"}
	movieOnlyIndexers = []string{"yts"}
	tvOnlyIndexers    = []string{"eztv"}
)

func indexerKey(name string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func indexerMatches(name string, list []string) bool {
	key := indexerKey(name)
	for _, candidate := range list {
		if strings.Contains(key, candidate) {
			return true
		}
	}
	return false
}

func indexerServes(name string, request Request) bool {
	animeFilm := request.Kind == KindAnime && request.Episode == nil && request.Season == nil
	switch {
	case indexerMatches(name, animeOnlyIndexers):
		return request.Kind == KindAnime
	case indexerMatches(name, movieOnlyIndexers):
		return request.Kind == KindMovie || animeFilm
	case indexerMatches(name, tvOnlyIndexers):
		return request.Kind == KindTV
	}
	return true
}

// primaryIndexer marks the indexers a search waits for before returning
// early: the most accurate source for the kind.
func primaryIndexer(name string, request Request) bool {
	switch request.Kind {
	case KindAnime:
		// Anime Tosho mirrors Nyaa and stays reachable where nyaa.si is
		// filtered, so a search never waits on a blocked Nyaa.
		return indexerMatches(name, []string{"animetosho"})
	case KindMovie:
		return indexerMatches(name, movieOnlyIndexers)
	}
	return false
}

// buildQueries picks the title variants worth sending: the primary title
// and, for anime, up to two Latin-script aliases (romaji names are what anime
// trackers file releases under). Film and TV releases use the primary
// English title; foreign-language alternative titles only cost requests.
func buildQueries(request Request) []prowlarrQuery {
	titles := []string{request.Title}
	if request.Kind == KindAnime || !isLatinScript(request.Title) {
		known := buildKnownTitles(request)
		arcs := map[string]bool{}
		for _, arc := range known.arcs {
			arcs[strings.Join(sortedTokens(arc), " ")] = true
		}
		for _, alias := range request.Aliases {
			tokens := map[string]bool{}
			for _, word := range significantTokens(stripAnimeSeason(alias)) {
				tokens[word] = true
			}
			if isLatinScript(alias) && !arcs[strings.Join(sortedTokens(tokens), " ")] {
				titles = append(titles, alias)
			}
		}
	}
	seen := map[string]bool{}
	queries := make([]prowlarrQuery, 0, maxQueryVariants+1)
	for _, title := range titles {
		title = strings.TrimSpace(title)
		key := normalizeAnimeTitle(title)
		if title == "" || seen[key] {
			continue
		}
		seen[key] = true
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
		if len(queries) == maxQueryVariants {
			break
		}
	}
	if hint := queryLanguageHint(request); hint != "" && len(queries) > 0 {
		hinted := queries[0]
		hinted.query += " " + hint
		queries = append(queries, hinted)
	}
	return queries
}

func isLatinScript(value string) bool {
	for _, r := range accentFold.Replace(value) {
		if r > 0x024F && r != '’' && r != '‘' && r != '“' && r != '”' && r != '–' && r != '—' {
			return false
		}
	}
	return true
}

func sortedTokens(tokens map[string]bool) []string {
	list := make([]string, 0, len(tokens))
	for token := range tokens {
		list = append(list, token)
	}
	sort.Strings(list)
	return list
}
