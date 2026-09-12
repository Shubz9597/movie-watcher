package catalog

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
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
}

// NewService builds the service over the given providers, which are in fixed
// configuration-declared priority order (highest priority first).
func NewService(providers []Provider, options Options) *Service {
	return &Service{options: options.withDefaults(), cache: NewCache(options.CacheMaxEntries), providers: providers}
}

// Providers exposes the registry in priority order (diagnostics/tests).
func (s *Service) Providers() []Provider { return s.providers }

// SearchResult is the degraded-aware unified search outcome.
type SearchResult struct {
	Titles            []Title
	DegradedProviders []string
	CachedAt          map[string]time.Time
}

// Search runs every search-capable provider and merges deterministically.
func (s *Service) Search(ctx context.Context, query SearchQuery) SearchResult {
	if query.Limit <= 0 || query.Limit > s.options.SearchLimit {
		query.Limit = s.options.SearchLimit
	}
	groups := make([][]Title, 0, len(s.providers))
	degraded := []string{}
	cachedAt := map[string]time.Time{}
	for _, provider := range s.providers {
		searcher, ok := provider.(SearchProvider)
		if !ok {
			continue
		}
		if cached, state, ok := s.cache.Get(provider.Name(), searchCacheKey(query)); ok && state == cacheStateFresh {
			groups = append(groups, filterByType(cached.([]Title), query.Type))
			continue
		}
		titles, err := callProvider(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Title, error) {
			return searcher.Search(ctx, query)
		})
		if err != nil {
			degraded = append(degraded, provider.Name())
			if stale, state, ok := s.cache.Get(provider.Name(), searchCacheKey(query)); ok && state == cacheStateStale {
				groups = append(groups, stale.([]Title))
				if at, ok := s.cache.FetchedAt(provider.Name(), searchCacheKey(query)); ok {
					cachedAt[provider.Name()] = at
				}
			}
			continue
		}
		s.cache.Set(provider.Name(), searchCacheKey(query), titles, s.options.CacheTTL)
		groups = append(groups, filterByType(titles, query.Type))
	}
	sort.Strings(degraded)
	return SearchResult{Titles: MergeTitles(groups), DegradedProviders: degraded, CachedAt: cachedAt}
}

func searchCacheKey(query SearchQuery) string {
	return query.Query + "\x00" + string(query.Type)
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
// and not-found providers are retried once with the enriched id set.
func (s *Service) Detail(ctx context.Context, id string) DetailResult {
	providerName, externalID, err := ParseTitleID(id)
	if err != nil {
		return DetailResult{NotFound: true}
	}
	ids := map[string]string{providerName: externalID}
	degraded := []string{}
	notFound := true
	var merged Title
	var retryable []DetailProvider
	idsAtAttempt := map[string]int{}

	for _, provider := range s.providers {
		detailer, ok := provider.(DetailProvider)
		if !ok {
			continue
		}
		title, err := s.detailFromProvider(ctx, detailer, ids)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				retryable = append(retryable, detailer)
				idsAtAttempt[detailer.Name()] = len(ids)
				continue
			}
			degraded = append(degraded, provider.Name())
			if stale, state, ok := s.cache.Get(provider.Name(), "detail:"+id); ok && state == cacheStateStale {
				notFound = false
				staleTitle := stale.(Title)
				if merged.ID == "" {
					merged = staleTitle
				} else {
					mergeTitle(&merged, staleTitle)
				}
			}
			continue
		}
		s.cache.Set(provider.Name(), "detail:"+id, title, s.options.CacheTTL)
		notFound = false
		if merged.ID == "" {
			merged = title
		} else {
			mergeTitle(&merged, title)
		}
	}

	// Retry providers that reported not-found with the enriched id set.
	for _, detailer := range retryable {
		if len(ids) <= idsAtAttempt[detailer.Name()] {
			continue
		}
		title, err := s.detailFromProvider(ctx, detailer, ids)
		if err != nil {
			continue
		}
		notFound = false
		if merged.ID == "" {
			merged = title
		} else {
			mergeTitle(&merged, title)
		}
	}
	if merged.ID == "" && !notFound {
		merged.ID = id
	}
	if merged.ID != "" {
		notFound = false
	}
	sort.Strings(degraded)
	return DetailResult{Title: merged, Found: merged.ID != "", NotFound: notFound && len(degraded) == 0, DegradedProviders: degraded}
}

func (s *Service) detailFromProvider(ctx context.Context, detailer DetailProvider, ids map[string]string) (Title, error) {
	title, err := callProvider(ctx, s.options.ProviderTimeout, func(ctx context.Context) (Title, error) {
		return detailer.Detail(ctx, DetailRequest{ProviderIDs: ids})
	})
	if err != nil {
		return Title{}, err
	}
	for namespace, value := range title.ProviderIDs {
		if _, ok := ids[namespace]; !ok {
			ids[namespace] = value
		}
	}
	return title, nil
}

// EpisodeResult is the degraded-aware episode-list outcome.
type EpisodeResult struct {
	Episodes          []Episode
	DegradedProviders []string
}

// Episodes resolves the merged episode list for one title id and season,
// enriching the id set via a detail resolution first so cross-linked
// providers (AniZip via AniList ids, Cinemeta via IMDb ids) can contribute.
func (s *Service) Episodes(ctx context.Context, id string, season int) EpisodeResult {
	providerName, externalID, err := ParseTitleID(id)
	if err != nil {
		return EpisodeResult{Episodes: []Episode{}}
	}
	detail := s.Detail(ctx, id)
	ids := map[string]string{providerName: externalID}
	if detail.Found {
		for namespace, value := range detail.Title.ProviderIDs {
			if _, ok := ids[namespace]; !ok {
				ids[namespace] = value
			}
		}
	}
	return s.EpisodesWithIDs(ctx, ids, season, id)
}

// EpisodesWithIDs merges episode lists over the given provider id set.
func (s *Service) EpisodesWithIDs(ctx context.Context, providerIDs map[string]string, season int, titleID string) EpisodeResult {
	request := EpisodeRequest{ProviderIDs: providerIDs, Season: season}
	// Cache keys for this merged-id set: canonical key is the sorted id set.
	canonical := episodeIDsKey(providerIDs, season)
	groups := make([][]Episode, 0, len(s.providers))
	degraded := []string{}
	for _, provider := range s.providers {
		episodeProvider, ok := provider.(EpisodeProvider)
		if !ok {
			continue
		}
		if cached, state, ok := s.cache.Get(provider.Name(), canonical); ok && state == cacheStateFresh {
			groups = append(groups, cached.([]Episode))
			continue
		}
		episodes, err := callProvider(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Episode, error) {
			return episodeProvider.Episodes(ctx, request)
		})
		if err != nil {
			degraded = append(degraded, provider.Name())
			if stale, state, ok := s.cache.Get(provider.Name(), canonical); ok && state == cacheStateStale {
				groups = append(groups, stale.([]Episode))
			}
			continue
		}
		s.cache.Set(provider.Name(), canonical, episodes, s.options.CacheTTL)
		groups = append(groups, episodes)
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
	page := query.Page
	if page < 1 {
		page = 1
	}
	cacheKey := "section:" + query.Kind + "\x00g" + strconv.Itoa(query.GenreID) + "\x00n" + query.Genre + "\x00t" + string(query.Type) + "\x00p" + strconv.Itoa(page)
	groups := make([][]Title, 0, len(s.providers))
	degraded := []string{}
	cachedAt := map[string]time.Time{}
	totalPages := 0
	for _, provider := range s.providers {
		var titles []Title
		var providerTotal int
		var err error
		if query.Genre != "" {
			genreProvider, ok := provider.(NamedGenreSectionProvider)
			if !ok {
				continue
			}
			if cached, state, ok := s.cache.Get(provider.Name(), cacheKey); ok && state == cacheStateFresh {
				if entry, valid := asSectionCacheEntry(cached); valid {
					groups = append(groups, entry.Titles)
					totalPages = max(totalPages, entry.TotalPages)
					continue
				}
			}
			titles, providerTotal, err = callProviderPaged(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Title, int, error) {
				return genreProvider.NamedGenreSection(ctx, query.Genre, page)
			})
		} else if query.GenreID > 0 {
			genreProvider, ok := provider.(GenreSectionProvider)
			if !ok {
				continue
			}
			if cached, state, ok := s.cache.Get(provider.Name(), cacheKey); ok && state == cacheStateFresh {
				if entry, valid := asSectionCacheEntry(cached); valid {
					groups = append(groups, entry.Titles)
					totalPages = max(totalPages, entry.TotalPages)
					continue
				}
			}
			titles, providerTotal, err = callProviderPaged(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Title, int, error) {
				return genreProvider.GenreSection(ctx, query.Type, query.GenreID, page)
			})
		} else if page > 1 {
			paged, ok := provider.(PageableSectionProvider)
			if !ok {
				continue
			}
			if cached, state, ok := s.cache.Get(provider.Name(), cacheKey); ok && state == cacheStateFresh {
				if entry, valid := asSectionCacheEntry(cached); valid {
					groups = append(groups, entry.Titles)
					totalPages = max(totalPages, entry.TotalPages)
					continue
				}
			}
			titles, providerTotal, err = callProviderPaged(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Title, int, error) {
				return paged.SectionPage(ctx, query.Kind, page)
			})
		} else {
			sectionProvider, ok := provider.(SectionProvider)
			if !ok {
				continue
			}
			if cached, state, ok := s.cache.Get(provider.Name(), cacheKey); ok && state == cacheStateFresh {
				if entry, valid := asSectionCacheEntry(cached); valid {
					groups = append(groups, entry.Titles)
					totalPages = max(totalPages, entry.TotalPages)
					if at, ok := s.cache.FetchedAt(provider.Name(), cacheKey); ok {
						cachedAt[provider.Name()] = at
					}
					continue
				}
			}
			titles, err = callProvider(ctx, s.options.ProviderTimeout, func(ctx context.Context) ([]Title, error) {
				return sectionProvider.Section(ctx, query.Kind)
			})
		}
		if err != nil {
			degraded = append(degraded, provider.Name())
			if stale, state, ok := s.cache.Get(provider.Name(), cacheKey); ok && state == cacheStateStale {
				if entry, valid := asSectionCacheEntry(stale); valid {
					groups = append(groups, entry.Titles)
					totalPages = max(totalPages, entry.TotalPages)
					if at, ok := s.cache.FetchedAt(provider.Name(), cacheKey); ok {
						cachedAt[provider.Name()] = at
					}
				}
			}
			continue
		}
		s.cache.Set(provider.Name(), cacheKey, sectionCacheEntry{Titles: titles, TotalPages: providerTotal}, s.options.CacheTTL)
		groups = append(groups, titles)
		if providerTotal > totalPages {
			totalPages = providerTotal
		}
		if at, ok := s.cache.FetchedAt(provider.Name(), cacheKey); ok {
			cachedAt[provider.Name()] = at
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

// callProvider bounds one provider call with the configured timeout.
func callProvider[T any](ctx context.Context, timeout time.Duration, call func(ctx context.Context) (T, error)) (T, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return call(callCtx)
}

// callProviderPaged bounds one paged provider call (titles + total pages).
func callProviderPaged[T any](ctx context.Context, timeout time.Duration, call func(ctx context.Context) (T, int, error)) (T, int, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return call(callCtx)
}
