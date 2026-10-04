package catalog

import (
	"context"
	"errors"
	"maps"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// ErrNotFound reports that a provider knows nothing about a requested id
// (as opposed to a transport outage, which is any other error).
var ErrNotFound = errors.New("catalog: not found")

// ErrRateLimited reports a provider rate-limit response (429).
var ErrRateLimited = errors.New("catalog: provider rate limited")

// SearchQuery is a unified catalog search.
type SearchQuery struct {
	Query string
	Type  TitleType // movie|series|anime|"" (all)
	Limit int
}

// DetailRequest carries every known provider external id for a title so each
// adapter can contribute what it understands (e.g. AniZip enriching an
// AniList-keyed title).
type DetailRequest struct {
	ProviderIDs map[string]string
}

// EpisodeRequest carries the known provider ids plus the requested season.
type EpisodeRequest struct {
	ProviderIDs map[string]string
	Season      int
}

// Provider is one catalog source. All operations beyond Name are optional
// capabilities discovered via type assertion; adapters implement exactly what
// the upstream service supports.
type Provider interface {
	Name() string
}

type SearchProvider interface {
	Provider
	Search(ctx context.Context, query SearchQuery) ([]Title, error)
}

// TypedSearchProvider can skip upstreams that cannot contribute to this type.
type TypedSearchProvider interface {
	SupportsSearchType(TitleType) bool
}

// IDProvider reports whether known ids can be used by Detail or Episodes.
// Implementations must treat ids as read-only.
type IDProvider interface {
	SupportsIDs(ids map[string]string) bool
}

type DetailProvider interface {
	Provider
	Detail(ctx context.Context, request DetailRequest) (Title, error)
}

type EpisodeProvider interface {
	Provider
	Episodes(ctx context.Context, request EpisodeRequest) ([]Episode, error)
}

type SectionProvider interface {
	Provider
	Section(ctx context.Context, kind string) ([]Title, error)
}

// PageableSectionProvider optionally serves curated sections beyond their
// first page. Implementations return the page's titles plus the provider's
// total page count when known (0 = unknown).
type PageableSectionProvider interface {
	Provider
	SectionPage(ctx context.Context, kind string, page int) ([]Title, int, error)
}

// GenreSectionProvider optionally serves media-type scoped, paged genre
// sections (renderer genre rails, T042.1).
type GenreSectionProvider interface {
	Provider
	GenreSection(ctx context.Context, mediaType TitleType, genreID, page int) ([]Title, int, error)
}

// NamedGenreSectionProvider optionally serves named genre sections. AniList
// uses stable genre names rather than numeric provider ids.
type NamedGenreSectionProvider interface {
	Provider
	NamedGenreSection(ctx context.Context, genre string, page int) ([]Title, int, error)
}

// Options tunes the service. Zero values select the documented defaults.
type Options struct {
	// ProviderTimeout bounds each single provider call (default 8s).
	ProviderTimeout time.Duration
	// RequestTimeout bounds the complete catalog operation (default 3s).
	RequestTimeout time.Duration
	// FailureTTL prevents repeated calls to an unavailable upstream (default 30s).
	FailureTTL time.Duration
	// CacheTTL bounds fresh-cache age per provider key (default 10m).
	CacheTTL time.Duration
	// CacheMaxEntries bounds the in-memory cache (default 512).
	CacheMaxEntries int
	// SearchLimit caps unified search results (default 50).
	SearchLimit int
	// Now overrides the clock in tests.
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.ProviderTimeout <= 0 {
		o.ProviderTimeout = 8 * time.Second
	}
	if o.RequestTimeout <= 0 {
		o.RequestTimeout = 3 * time.Second
	}
	if o.FailureTTL <= 0 {
		o.FailureTTL = 30 * time.Second
	}
	if o.CacheTTL <= 0 {
		o.CacheTTL = 10 * time.Minute
	}
	if o.CacheMaxEntries <= 0 {
		o.CacheMaxEntries = 512
	}
	if o.SearchLimit <= 0 {
		o.SearchLimit = 50
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Service orchestrates the provider registry: deterministic merge, bounded
// TTL caching, per-provider timeouts, and stale-but-valid degradation
// (spec Edge Case 1: provider outages never fail the whole search).
type Service struct {
	options   Options
	cache     *Cache
	providers []Provider
	failures  *Cache
	flights   singleflight.Group
	slots     chan struct{}
	workMu    sync.Mutex
	work      sync.WaitGroup
	closed    bool
	nextWork  uint64
	cancels   map[uint64]context.CancelFunc
}

// NewService builds the service over the given providers, which are in fixed
// configuration-declared priority order (highest priority first).
func NewService(providers []Provider, options Options) *Service {
	options = options.withDefaults()
	return &Service{
		options:   options,
		cache:     NewCache(options.CacheMaxEntries),
		providers: slices.Clone(providers),
		failures:  NewCache(options.CacheMaxEntries),
		slots:     make(chan struct{}, 8),
		cancels:   make(map[uint64]context.CancelFunc),
	}
}

// Providers exposes the registry in priority order (diagnostics/tests).
func (s *Service) Providers() []Provider { return slices.Clone(s.providers) }

// SearchResult is the degraded-aware unified search outcome.
type SearchResult struct {
	Titles            []Title
	DegradedProviders []string
	CachedAt          map[string]time.Time
}

// Search runs every search-capable provider and merges deterministically.
func (s *Service) Search(ctx context.Context, query SearchQuery) SearchResult {
	ctx, cancel := context.WithTimeout(ctx, s.options.RequestTimeout)
	defer cancel()
	if query.Limit <= 0 || query.Limit > s.options.SearchLimit {
		query.Limit = s.options.SearchLimit
	}
	key := searchCacheKey(query)
	replies := parallelReplies(len(s.providers), func(i int) providerReply {
		provider := s.providers[i]
		searcher, ok := provider.(SearchProvider)
		if !ok {
			return providerReply{}
		}
		if typed, ok := provider.(TypedSearchProvider); ok && !typed.SupportsSearchType(query.Type) {
			return providerReply{}
		}
		return s.fetchCached(ctx, provider.Name(), key, func(callCtx context.Context) (any, error) { return searcher.Search(callCtx, query) })
	})
	groups := make([][]Title, 0, len(replies))
	degraded := []string{}
	cachedAt := map[string]time.Time{}
	for i, reply := range replies {
		provider := s.providers[i].Name()
		if reply.stale || (reply.err != nil && !errors.Is(reply.err, ErrNotFound)) {
			degraded = append(degraded, provider)
		}
		if titles, ok := reply.value.([]Title); ok {
			groups = append(groups, filterByType(titles, query.Type))
		}
		if reply.stale {
			if at, ok := s.cache.FetchedAt(provider, key); ok {
				cachedAt[provider] = at
			}
		}
	}
	sort.Strings(degraded)
	titles := MergeTitles(groups)
	rankSearchTitles(titles, query.Query, groups)
	if len(titles) > query.Limit {
		titles = titles[:query.Limit]
	}
	return SearchResult{Titles: titles, DegradedProviders: degraded, CachedAt: cachedAt}
}

func searchCacheKey(query SearchQuery) string {
	return query.Query + "\x00" + string(query.Type) + "\x00" + strconv.Itoa(query.Limit)
}

func filterByType(titles []Title, want TitleType) []Title {
	if want == "" || want == "all" {
		return titles
	}
	filtered := make([]Title, 0, len(titles))
	for _, title := range titles {
		if title.Type == want {
			filtered = append(filtered, title)
		}
	}
	return filtered
}

// DetailResult is the degraded-aware title-detail outcome.
type DetailResult struct {
	Title             Title
	Found             bool
	NotFound          bool
	DegradedProviders []string
}

// Detail resolves merged metadata for one opaque title id. Provider cross
// links (e.g. an AniList id revealing the MAL id) accumulate across providers
// and not-found providers are retried when the known id set expands.
func (s *Service) Detail(ctx context.Context, id string) DetailResult {
	if _, _, err := ParseTitleID(id); err != nil {
		return DetailResult{NotFound: true}
	}
	ctx, cancel := context.WithTimeout(ctx, s.options.RequestTimeout)
	defer cancel()
	if cached, state, ok := s.cache.Get("merged", "detail:"+id); ok {
		result := cached.(DetailResult)
		if state == cacheStateStale && ctx.Err() == nil {
			s.refreshDetail(ctx, id)
		}
		return result
	}
	result := s.computeDetail(ctx, id)
	s.rememberDetail(id, result)
	return result
}

func (s *Service) computeDetail(ctx context.Context, id string) DetailResult {
	providerName, externalID, err := ParseTitleID(id)
	if err != nil {
		return DetailResult{NotFound: true}
	}
	ids := map[string]string{providerName: externalID}
	replies := make([]providerReply, len(s.providers))
	attempted := make([]string, len(s.providers))
	// Later rounds retry only providers that lacked an id, once another provider
	// has discovered a cross-link. Merge order remains registry priority.
	for round := 0; round < len(s.providers); round++ {
		snapshot := maps.Clone(ids)
		key := "detail:" + episodeIDsKey(snapshot, 0)
		next := parallelReplies(len(s.providers), func(i int) providerReply {
			detailer, ok := s.providers[i].(DetailProvider)
			if !ok || attempted[i] == key || (attempted[i] != "" && !errors.Is(replies[i].err, ErrNotFound)) {
				return replies[i]
			}
			if source, ok := detailer.(IDProvider); ok && !source.SupportsIDs(snapshot) {
				return providerReply{err: ErrNotFound}
			}
			attempted[i] = key
			return s.fetchCached(ctx, detailer.Name(), key, func(callCtx context.Context) (any, error) {
				return detailer.Detail(callCtx, DetailRequest{ProviderIDs: maps.Clone(snapshot)})
			})
		})
		replies = next
		for _, reply := range replies {
			if title, ok := reply.value.(Title); ok && reply.err == nil {
				for namespace, value := range title.ProviderIDs {
					if _, exists := ids[namespace]; !exists {
						ids[namespace] = value
					}
				}
			}
		}
		if maps.Equal(snapshot, ids) || ctx.Err() != nil {
			break
		}
	}
	degraded := []string{}
	var merged Title
	found := false
	for i, reply := range replies {
		if reply.stale || (reply.err != nil && !errors.Is(reply.err, ErrNotFound)) {
			degraded = append(degraded, s.providers[i].Name())
		}
		if title, ok := reply.value.(Title); ok && reply.err == nil {
			if !found {
				merged = title
				found = true
			} else {
				mergeTitle(&merged, title)
			}
		}
	}
	if found && merged.ID == "" {
		merged.ID = id
	}
	sort.Strings(degraded)
	return DetailResult{Title: merged, Found: found, NotFound: !found && len(degraded) == 0, DegradedProviders: degraded}
}

// EpisodeResult is the degraded-aware episode-list outcome.
type EpisodeResult struct {
	Episodes          []Episode
	DegradedProviders []string
}

// Episodes resolves the merged episode list for one title id and season,
// enriching the id set concurrently via detail resolution so cross-linked
// providers (AniZip via AniList ids, Cinemeta via IMDb ids) can contribute.
func (s *Service) Episodes(ctx context.Context, id string, season int) EpisodeResult {
	ctx, cancel := context.WithTimeout(ctx, s.options.RequestTimeout)
	defer cancel()
	if _, _, err := ParseTitleID(id); err != nil {
		return EpisodeResult{Episodes: []Episode{}}
	}
	key := mergedEpisodesKey(id, season)
	if cached, state, ok := s.cache.Get("merged", key); ok {
		if state == cacheStateStale && ctx.Err() == nil {
			s.refreshEpisodes(ctx, id, season)
		}
		return cached.(EpisodeResult)
	}
	result := s.computeEpisodes(ctx, id, season)
	s.rememberEpisodes(id, season, result)
	return result
}

func (s *Service) computeEpisodes(ctx context.Context, id string, season int) EpisodeResult {
	providerName, externalID, err := ParseTitleID(id)
	if err != nil {
		return EpisodeResult{Episodes: []Episode{}}
	}
	ids := map[string]string{providerName: externalID}
	// Fetch episodes from already known ids while detail discovers cross-links.
	// Useful initial episodes survive a metadata provider exhausting the budget.
	var detail DetailResult
	var initial EpisodeResult
	var workers sync.WaitGroup
	workers.Go(func() { detail = s.Detail(ctx, id) })
	workers.Go(func() { initial = s.EpisodesWithIDs(ctx, ids, season, id) })
	workers.Wait()
	enriched := maps.Clone(ids)
	if detail.Found {
		for namespace, value := range detail.Title.ProviderIDs {
			if _, exists := enriched[namespace]; !exists {
				enriched[namespace] = value
			}
		}
	}
	result := initial
	if !maps.Equal(ids, enriched) && ctx.Err() == nil {
		result = s.EpisodesWithIDs(ctx, enriched, season, id)
		result.Episodes = MergeEpisodes([][]Episode{result.Episodes, initial.Episodes})
	}
	// Report metadata failures only when the source can enrich this episode list.
	for _, name := range detail.DegradedProviders {
		for _, provider := range s.providers {
			if provider.Name() != name {
				continue
			}
			if _, ok := provider.(EpisodeProvider); !ok {
				continue
			}
			if source, ok := provider.(IDProvider); ok && !source.SupportsIDs(enriched) {
				continue
			}
			if !containsString(result.DegradedProviders, name) {
				result.DegradedProviders = append(result.DegradedProviders, name)
			}
		}
	}
	sort.Strings(result.DegradedProviders)
	return result
}

// EpisodesWithIDs merges episode lists over the given provider id set.
func (s *Service) EpisodesWithIDs(ctx context.Context, providerIDs map[string]string, season int, titleID string) EpisodeResult {
	ctx, cancel := context.WithTimeout(ctx, s.options.RequestTimeout)
	defer cancel()
	providerIDs = maps.Clone(providerIDs)
	canonical := episodeIDsKey(providerIDs, season)
	replies := parallelReplies(len(s.providers), func(i int) providerReply {
		provider, ok := s.providers[i].(EpisodeProvider)
		if !ok {
			return providerReply{}
		}
		if source, ok := provider.(IDProvider); ok && !source.SupportsIDs(providerIDs) {
			return providerReply{}
		}
		return s.fetchCached(ctx, provider.Name(), canonical, func(callCtx context.Context) (any, error) {
			return provider.Episodes(callCtx, EpisodeRequest{ProviderIDs: maps.Clone(providerIDs), Season: season})
		})
	})
	groups := make([][]Episode, 0, len(replies))
	degraded := []string{}
	for i, reply := range replies {
		if reply.stale || (reply.err != nil && !errors.Is(reply.err, ErrNotFound)) {
			degraded = append(degraded, s.providers[i].Name())
		}
		if episodes, ok := reply.value.([]Episode); ok {
			groups = append(groups, episodes)
		}
	}
	sort.Strings(degraded)
	merged := MergeEpisodes(groups)
	for i := range merged {
		merged[i].TitleID = titleID
	}
	return EpisodeResult{Episodes: merged, DegradedProviders: degraded}
}

func episodeIDsKey(providerIDs map[string]string, season int) string {
	namespaces := make([]string, 0, len(providerIDs))
	for namespace := range providerIDs {
		namespaces = append(namespaces, namespace)
	}
	sort.Strings(namespaces)
	parts := make([]string, 0, len(namespaces))
	for _, namespace := range namespaces {
		parts = append(parts, namespace+"="+providerIDs[namespace])
	}
	return "episodes:" + strings.Join(parts, ";") + "\x00" + strconv.Itoa(season)
}

// SectionResult is the degraded-aware section outcome.
type SectionResult struct {
	SectionID         string
	Kind              string
	Page              int
	TotalPages        int
	TitleIDs          []string
	Titles            []Title
	DegradedProviders []string
	CachedAt          map[string]time.Time
}

// SectionQuery scopes a section request: the curated kind, an optional 1-based
// page, and for genre sections the media type plus either a numeric TMDb genre
// id or a named provider genre (AniList).
type SectionQuery struct {
	Kind    string
	Page    int
	GenreID int
	Genre   string
	Type    TitleType
}

type sectionCacheEntry struct {
	Titles     []Title
	TotalPages int
}

func asSectionCacheEntry(value any) (sectionCacheEntry, bool) {
	switch cached := value.(type) {
	case sectionCacheEntry:
		return cached, true
	case []Title:
		// Compatibility for entries created before total-page caching was
		// introduced within the lifetime of a mixed test/service process.
		return sectionCacheEntry{Titles: cached}, true
	default:
		return sectionCacheEntry{}, false
	}
}

// Section resolves a curated/computed catalog section (page 1, no genre).
func (s *Service) Section(ctx context.Context, kind string) SectionResult {
	return s.SectionQuery(ctx, SectionQuery{Kind: kind, Page: 1})
}

// SectionQuery resolves a (possibly paged/genre-scoped) section across the
// providers that support the requested capability (T042.1). Merge is the
// same deterministic title merge as Search; cachedAt/totalPages aggregate
// deterministically over contributing providers.
func (s *Service) SectionQuery(ctx context.Context, query SectionQuery) SectionResult {
	ctx, cancel := context.WithTimeout(ctx, s.options.RequestTimeout)
	defer cancel()
	page := max(query.Page, 1)
	cacheKey := "section:" + query.Kind + "\x00g" + strconv.Itoa(query.GenreID) + "\x00n" + query.Genre + "\x00t" + string(query.Type) + "\x00p" + strconv.Itoa(page)
	replies := parallelReplies(len(s.providers), func(i int) providerReply {
		provider := s.providers[i]
		var fetch func(context.Context) (any, error)
		switch {
		case query.Genre != "":
			source, ok := provider.(NamedGenreSectionProvider)
			if !ok {
				return providerReply{}
			}
			fetch = func(ctx context.Context) (any, error) {
				titles, total, err := source.NamedGenreSection(ctx, query.Genre, page)
				return sectionCacheEntry{Titles: titles, TotalPages: total}, err
			}
		case query.GenreID > 0:
			source, ok := provider.(GenreSectionProvider)
			if !ok {
				return providerReply{}
			}
			fetch = func(ctx context.Context) (any, error) {
				titles, total, err := source.GenreSection(ctx, query.Type, query.GenreID, page)
				return sectionCacheEntry{Titles: titles, TotalPages: total}, err
			}
		case page > 1:
			source, ok := provider.(PageableSectionProvider)
			if !ok {
				return providerReply{}
			}
			fetch = func(ctx context.Context) (any, error) {
				titles, total, err := source.SectionPage(ctx, query.Kind, page)
				return sectionCacheEntry{Titles: titles, TotalPages: total}, err
			}
		default:
			source, ok := provider.(SectionProvider)
			if !ok {
				return providerReply{}
			}
			fetch = func(ctx context.Context) (any, error) {
				titles, err := source.Section(ctx, query.Kind)
				return sectionCacheEntry{Titles: titles}, err
			}
		}
		return s.fetchCached(ctx, provider.Name(), cacheKey, fetch)
	})
	groups := make([][]Title, 0, len(replies))
	degraded := []string{}
	cachedAt := map[string]time.Time{}
	totalPages := 0
	for i, reply := range replies {
		provider := s.providers[i].Name()
		if reply.stale || (reply.err != nil && !errors.Is(reply.err, ErrNotFound)) {
			degraded = append(degraded, provider)
		}
		if reply.err == nil {
			if entry, ok := asSectionCacheEntry(reply.value); ok {
				groups = append(groups, entry.Titles)
				totalPages = max(totalPages, entry.TotalPages)
			}
		}
		if reply.value != nil {
			if at, ok := s.cache.FetchedAt(provider, cacheKey); ok {
				cachedAt[provider] = at
			}
		}
	}
	merged := MergeTitles(groups)
	ids := make([]string, 0, len(merged))
	for _, title := range merged {
		ids = append(ids, title.ID)
	}
	sort.Strings(degraded)
	return SectionResult{SectionID: query.Kind, Kind: query.Kind, Page: page, TotalPages: totalPages, TitleIDs: ids, Titles: merged, DegradedProviders: degraded, CachedAt: cachedAt}
}
