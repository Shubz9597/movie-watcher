// Package recommendations implements the bounded, deterministic household
// recommendation ranking (feature 002 M4.1,
// specs/002-mobile-shared-ui/contracts/recommendations-api.md):
// favourite titles are seeds; candidates from the existing catalog score the
// number of DISTINCT seeds sharing at least one provider-qualified normalized
// genre; deterministic ordering (score desc, provider popularity rank,
// canonical id); results cached at most 15 minutes keyed by household
// revision + candidate-cache version. No ML, embeddings, profiles, or new
// recommendation infrastructure.
package recommendations

import (
	"context"
	"fmt"
	"hash/fnv"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/library"
)

// Capability advertised through /v1/version ONLY when the complete
// recommendation service is wired (contract §Negotiation).
const Capability = "recommendations.basic.v1"

// MaxLimit is the maximum number of recommendations returned (contract).
const MaxLimit = 20

// CandidatePoolVersion is the recommendation cache's candidate-pool version.
// It participates in the cache key alongside the household revision, so a
// changed candidate pool (provider inputs, ranking-relevant data shape)
// invalidates every cached result when this constant is bumped in the release
// that changes those inputs. It is deliberately a reviewed constant — not a
// hash — so cache churn is a deliberate release decision, not an accident.
const CandidatePoolVersion = 2

const (
	seedLimit      = 20
	candidateLimit = 200
	cacheTTL       = 15 * time.Minute
	// providerCallTimeout bounds each catalog/provider call made while
	// computing; the shared provider client allows 25s plus a retry.
	providerCallTimeout = 8 * time.Second
	// providerConcurrency bounds parallel provider calls per computation.
	providerConcurrency = 6
	reasonSeedGenre     = "seed_genre"
	reasonPopular       = "popular"
	// Per-seed "more like this" bounds: the first few usable favourites each
	// contribute one bounded similar-title page to the candidate pool.
	seedSimilarLimit = 12
	seedSimilarSeeds = 6
)

// SeedSimilarSource resolves per-seed "more like this" candidates (TMDb
// /recommendations) — the personalization layer on top of the global weekly
// trending pool.
type SeedSimilarSource interface {
	SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]catalog.Title, error)
}

// SeedGenreSource resolves genre metadata for one seed canonical id (bounded:
// called at most once per seed per cache build).
type SeedGenreSource interface {
	SeedGenres(ctx context.Context, canonicalID string) ([]string, error)
}

// CandidateSource supplies the bounded popular-candidate pool WITH genres and
// in provider popularity order (rank = slice position).
type CandidateSource interface {
	Candidates(ctx context.Context) ([]catalog.Title, error)
}

// CatalogSeedGenres adapts the existing catalog service to seed-genre
// resolution (one bounded detail call per seed per cache build).
type CatalogSeedGenres struct {
	Catalog *catalog.Service
}

// SeedTitle returns the catalog display title for a seed. Progress signals
// otherwise carry the playback source name (a torrent release name), which
// must never appear in a recommendation reason.
func (a CatalogSeedGenres) SeedTitle(ctx context.Context, canonicalID string) (string, error) {
	result := a.Catalog.Detail(ctx, canonicalID)
	if !result.Found {
		return "", catalog.ErrNotFound
	}
	return result.Title.Title, nil
}

// SeedGenres returns the merged catalog genres for the seed title.
func (a CatalogSeedGenres) SeedGenres(ctx context.Context, canonicalID string) ([]string, error) {
	result := a.Catalog.Detail(ctx, canonicalID)
	if !result.Found {
		return nil, catalog.ErrNotFound
	}
	return result.Title.Genres, nil
}

// CatalogSeedSimilar adapts the TMDb provider to per-seed "more like this"
// candidate resolution.
type CatalogSeedSimilar struct {
	Provider catalog.SeedSimilarProvider
}

// SeedSimilar returns the similar-title page for one seed canonical id.
func (a CatalogSeedSimilar) SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]catalog.Title, error) {
	return a.Provider.SeedSimilar(ctx, canonicalID, limit)
}

// TMDbCrossSimilar adapts TMDb crossover discovery (other media type, shared
// keywords and mapped genres) for tmdb: seeds; other namespaces have none.
type TMDbCrossSimilar struct {
	Provider *catalog.TMDb
}

func (a TMDbCrossSimilar) SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]catalog.Title, error) {
	if !strings.HasPrefix(canonicalID, "tmdb:") {
		return nil, catalog.ErrNotFound
	}
	return a.Provider.CrossTypeSimilar(ctx, canonicalID, limit)
}

// AniListSeedSimilar adapts the AniList provider to per-seed "more like this"
// candidate resolution for anilist: seeds.
type AniListSeedSimilar struct {
	Provider catalog.SeedSimilarProvider
}

// SeedSimilar returns the similar-title page for one seed canonical id.
func (a AniListSeedSimilar) SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]catalog.Title, error) {
	return a.Provider.SeedSimilar(ctx, canonicalID, limit)
}

// NamespaceSeedSimilar routes per-seed similar resolution by the canonical
// namespace: TMDb "more like this" for tmdb: seeds, AniList recommendations
// for anilist: seeds.
type NamespaceSeedSimilar struct {
	TMDb    SeedSimilarSource
	AniList SeedSimilarSource
}

// SeedSimilar dispatches; unknown namespaces yield no candidates (nil, nil).
func (n NamespaceSeedSimilar) SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]catalog.Title, error) {
	switch {
	case strings.HasPrefix(canonicalID, "tmdb:"):
		if n.TMDb == nil {
			return nil, nil
		}
		return n.TMDb.SeedSimilar(ctx, canonicalID, limit)
	case strings.HasPrefix(canonicalID, "anilist:"):
		if n.AniList == nil {
			return nil, nil
		}
		return n.AniList.SeedSimilar(ctx, canonicalID, limit)
	default:
		return nil, nil
	}
}

// TasteSignal is one household taste signal (from internal/taste).
type TasteSignal struct {
	CanonicalID string
	Kind        string
	Label       string // favourited | watch-later | watched | started | downloaded | completed | opened
	Weight      float64
	Title       string
	At          time.Time // when it happened; zero = undated (no decay)
}

// TasteSource supplies the household-wide taste signals (favourites, Watch
// Later, watch progress, opened titles). Nil keeps the legacy favourites-only
// scoring.
type TasteSource interface {
	HouseholdSignals(ctx context.Context) ([]TasteSignal, error)
}

// CatalogCandidates adapts a catalog CandidateProvider (e.g. TMDb) to the
// bounded candidate pool.
type CatalogCandidates struct {
	Provider catalog.CandidateProvider
}

// Candidates returns up to the bounded candidate pool in popularity order.
func (a CatalogCandidates) Candidates(ctx context.Context) ([]catalog.Title, error) {
	return a.Provider.PopularCandidates(ctx, candidateLimit)
}

// Deps wires the recommendation service. Library must be the storage-backed
// library store; Candidates and SeedGenres come from the existing catalog
// providers.
type Deps struct {
	Library    LibrarySource
	Candidates CandidateSource
	SeedGenres SeedGenreSource
	// Optional per-seed personalization: when wired, the first few usable
	// favourites contribute their TMDb/AniList "more like this" titles to the
	// pool, ranked ahead of the global trending pool.
	SeedSimilar SeedSimilarSource
	// Optional crossover: titles of the OTHER media type sharing the seed's
	// themes (movies for a series, series for a movie), mixed into the
	// seed's own similar list.
	CrossSimilar SeedSimilarSource
	// Optional household taste signals (v2): when wired, scoring uses the
	// WEIGHTED taste profile (favourites + Watch Later + watch progress +
	// opened titles) instead of the legacy favourites-only binary points.
	Taste                 TasteSource
	CandidateCacheVersion int
	// Now overrides the clock (tests); defaults to time.Now.
	Now func() time.Time
}

type LibrarySource interface {
	FavouriteSeeds(ctx context.Context, limit int) ([]library.Seed, error)
	ActiveMembershipIDs(ctx context.Context) (map[string]bool, error)
	Revision(ctx context.Context) (int64, error)
}

// Reason is the truthful human-readable justification for one item
// (contract §reason): code "seed_genre" grounds the text in the contributing
// seed; code "popular" marks zero-score filler / fallback picks.
type Reason struct {
	Code            string `json:"code"`
	Text            string `json:"text"`
	SeedCanonicalID string `json:"seedCanonicalId,omitempty"`
}

// Item is one recommendation card (contract response shape).
type Item struct {
	CanonicalID string            `json:"canonicalId"`
	Type        string            `json:"type"`
	Title       string            `json:"title"`
	Year        int               `json:"year,omitempty"`
	Artwork     map[string]string `json:"artwork,omitempty"`
	Reason      Reason            `json:"reason"`
}

// Result is the full ranked recommendation payload (handler slices by limit).
type Result struct {
	Revision    int64
	Fallback    bool
	Degraded    bool
	GeneratedAt time.Time
	Items       []Item
}

type cacheEntry struct {
	result      Result
	computedAt  time.Time
	candidateVn int
}

// Service computes and caches household recommendations.
type Service struct {
	library      LibrarySource
	candidates   CandidateSource
	seedGenres   SeedGenreSource
	seedSimilar  SeedSimilarSource
	crossSimilar SeedSimilarSource
	taste        TasteSource
	candidateVn  int
	now          func() time.Time

	mu         sync.Mutex
	cache      *cacheEntry
	stale      *cacheEntry // last computed result, served degraded when providers fail
	refreshing bool        // a background recompute is running
	refreshWG  sync.WaitGroup

	// Last successful "more like this" list per seed: a transient provider
	// failure must not silently drop that title from recommendations.
	similarMu   sync.Mutex
	lastSimilar map[string][]catalog.Title
}

// mixCross interleaves crossover titles into a seed's same-type list: two
// same-type picks, then one crossover, so both appear near the top.
func mixCross(same, cross []catalog.Title) []catalog.Title {
	if len(cross) == 0 {
		return same
	}
	mixed := make([]catalog.Title, 0, len(same)+len(cross))
	for i, j := 0, 0; i < len(same) || j < len(cross); {
		for k := 0; k < 2 && i < len(same); k++ {
			mixed = append(mixed, same[i])
			i++
		}
		if j < len(cross) {
			mixed = append(mixed, cross[j])
			j++
		}
	}
	return mixed
}

// similarFor returns the seed's similar titles, falling back to the last
// successful list when the provider call fails.
func (s *Service) similarFor(ctx context.Context, source SeedSimilarSource, cacheKey, seedID string) ([]catalog.Title, error) {
	similar, err := source.SeedSimilar(ctx, seedID, seedSimilarLimit)
	s.similarMu.Lock()
	defer s.similarMu.Unlock()
	key := cacheKey + "\x00" + seedID
	if err != nil {
		if last, ok := s.lastSimilar[key]; ok {
			return last, nil
		}
		return nil, err
	}
	if s.lastSimilar == nil {
		s.lastSimilar = map[string][]catalog.Title{}
	}
	s.lastSimilar[key] = similar
	return similar, nil
}

// New wires the service; nil Candidates or Library keeps the capability
// unadvertised at the composition root.
func New(deps Deps) *Service {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		library:      deps.Library,
		candidates:   deps.Candidates,
		seedGenres:   deps.SeedGenres,
		seedSimilar:  deps.SeedSimilar,
		crossSimilar: deps.CrossSimilar,
		taste:        deps.Taste,
		candidateVn:  deps.CandidateCacheVersion,
		now:          now,
	}
}

// Recommend returns the deterministic ranked list. The cached result is used
// while the household revision and candidate-cache version are unchanged and
// the entry is younger than 15 minutes; a candidate-source failure serves the
// last computed result truthfully degraded (never blocks Home).
func (s *Service) Recommend(ctx context.Context) (Result, error) {
	revision, err := s.library.Revision(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read household revision: %w", err)
	}
	s.mu.Lock()
	cached := s.cache
	s.mu.Unlock()
	if cached != nil && cached.candidateVn == s.candidateVn && cached.result.Revision == revision && s.now().Sub(cached.computedAt) < cacheTTL {
		return cached.result, nil
	}
	// Stale-while-revalidate: once anything was computed, Home gets it at
	// once and the recompute (dozens of provider calls) runs in the
	// background. Only the very first computation is waited on.
	s.mu.Lock()
	stale := s.stale
	s.mu.Unlock()
	if stale != nil && stale.candidateVn == s.candidateVn {
		s.refreshInBackground(revision)
		return stale.result, nil
	}

	result, err := s.compute(ctx, revision)
	if err != nil {
		// Provider/library failure must never block Home: serve the last
		// computed result truthfully degraded.
		s.mu.Lock()
		stale := s.stale
		s.mu.Unlock()
		if stale != nil {
			degraded := stale.result
			degraded.Degraded = true
			return degraded, nil
		}
		return Result{Revision: revision, Degraded: true, GeneratedAt: s.now(), Items: []Item{}}, nil
	}

	entry := &cacheEntry{result: result, computedAt: s.now(), candidateVn: s.candidateVn}
	s.mu.Lock()
	s.cache = entry
	s.stale = entry
	s.mu.Unlock()
	return result, nil
}

// refreshInBackground recomputes once at a time and installs the result.
func (s *Service) refreshInBackground(revision int64) {
	s.mu.Lock()
	if s.refreshing {
		s.mu.Unlock()
		return
	}
	s.refreshing = true
	s.refreshWG.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.refreshWG.Done()
		defer func() {
			s.mu.Lock()
			s.refreshing = false
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		result, err := s.compute(ctx, revision)
		if err != nil {
			log.Printf("[recommendations] background refresh failed: %v", err)
			return
		}
		entry := &cacheEntry{result: result, computedAt: s.now(), candidateVn: s.candidateVn}
		s.mu.Lock()
		s.cache = entry
		s.stale = entry
		s.mu.Unlock()
	}()
}

// Warm computes the first result in the background so the first Home load
// after a server start does not wait for it.
func (s *Service) Warm() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if _, err := s.Recommend(ctx); err != nil {
			log.Printf("[recommendations] warm-up failed: %v", err)
		}
	}()
}

// compute builds one ranked result against the given revision.
func (s *Service) compute(ctx context.Context, revision int64) (Result, error) {
	if s.taste != nil {
		return s.computeFromTaste(ctx, revision)
	}
	return s.computeFromFavourites(ctx, revision)
}

func (s *Service) computeFromFavourites(ctx context.Context, revision int64) (Result, error) {
	seeds, err := s.library.FavouriteSeeds(ctx, seedLimit)
	if err != nil {
		return Result{}, fmt.Errorf("read favourite seeds: %w", err)
	}
	excluded, err := s.library.ActiveMembershipIDs(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read active memberships: %w", err)
	}

	// Seed genre keys: provider-qualified normalized genres (contract §1).
	type seedInfo struct {
		id    string
		title string
		keys  map[string]bool
	}
	usableSeeds := make([]seedInfo, 0, len(seeds))
	for _, seed := range seeds {
		genres, err := s.seedGenres.SeedGenres(ctx, seed.CanonicalID)
		if err != nil || len(genres) == 0 {
			continue // no usable genre metadata: contributes nothing, still excluded
		}
		namespace := seedNamespace(seed.CanonicalID)
		keys := make(map[string]bool, len(genres))
		for _, genre := range genres {
			key := genreKey(namespace, genre)
			if key != "" {
				keys[key] = true
			}
		}
		if len(keys) > 0 {
			usableSeeds = append(usableSeeds, seedInfo{id: seed.CanonicalID, title: seed.Title, keys: keys})
		}
	}

	// Candidate pool: per-seed "more like this" titles FIRST (the
	// personalization layer — genuinely derived from this household's
	// favourites), then the global weekly trending pool. Rank = pool order,
	// so similar titles win ties against trending filler. Failures are
	// bounded and non-fatal: a failing seed simply contributes nothing.
	pool := make([]catalog.Title, 0, candidateLimit)
	if s.seedSimilar != nil {
		for i, seed := range usableSeeds {
			if i >= seedSimilarSeeds {
				break
			}
			similar, err := s.seedSimilar.SeedSimilar(ctx, seed.id, seedSimilarLimit)
			if err != nil {
				continue
			}
			pool = append(pool, similar...)
		}
	}
	trending, err := s.candidates.Candidates(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read candidate pool: %w", err)
	}
	pool = append(pool, trending...)

	// Deduplicate candidates by canonical id, apply exclusions, and score.
	seen := map[string]bool{}
	type scored struct {
		title      catalog.Title
		rank       int
		score      int
		reasonSeed *seedInfo
	}
	scored_ := make([]scored, 0, len(pool))
	for rank, candidate := range pool {
		if seen[candidate.ID] {
			continue // duplicate candidates deduplicate by canonical id
		}
		seen[candidate.ID] = true
		if excluded[candidate.ID] {
			continue // current favourites AND watch-later titles are excluded
		}
		namespace := seedNamespace(candidate.ID)
		candidateKeys := make(map[string]bool, len(candidate.Genres))
		for _, genre := range candidate.Genres {
			if key := genreKey(namespace, genre); key != "" {
				candidateKeys[key] = true
			}
		}
		score := 0
		var reasonSeed *seedInfo
		for i := range usableSeeds {
			// ONE seed contributes AT MOST ONE point, no matter how many
			// genres overlap; seeds are in most-recent-first order, so the
			// first contributor is the most recent one.
			shared := false
			for key := range usableSeeds[i].keys {
				if candidateKeys[key] {
					shared = true
					break
				}
			}
			if shared {
				score++
				if reasonSeed == nil {
					reasonSeed = &usableSeeds[i]
				}
			}
		}
		scored_ = append(scored_, scored{title: candidate, rank: rank, score: score, reasonSeed: reasonSeed})
	}

	// Deterministic ordering: score desc, provider popularity rank, canonical id.
	sort.SliceStable(scored_, func(i, j int) bool {
		if scored_[i].score != scored_[j].score {
			return scored_[i].score > scored_[j].score
		}
		if scored_[i].rank != scored_[j].rank {
			return scored_[i].rank < scored_[j].rank
		}
		return scored_[i].title.ID < scored_[j].title.ID
	})

	fallback := len(usableSeeds) == 0
	items := make([]Item, 0, len(scored_))
	for _, entry := range scored_ {
		item := Item{
			CanonicalID: entry.title.ID,
			Type:        string(entry.title.Type),
			Title:       entry.title.Title,
			Year:        entry.title.Year,
			Artwork:     entry.title.Artwork,
			Reason:      Reason{Code: reasonPopular, Text: "Popular pick"},
		}
		if !fallback && entry.reasonSeed != nil {
			item.Reason = Reason{
				Code:            reasonSeedGenre,
				Text:            fmt.Sprintf("Because you favourited %s", entry.reasonSeed.title),
				SeedCanonicalID: entry.reasonSeed.id,
			}
		}
		items = append(items, item)
	}
	return Result{Revision: revision, Fallback: fallback, GeneratedAt: s.now(), Items: items}, nil
}

// computeFromTaste is the v2 weighted-scoring path driven by the household
// taste profile (favourites + Watch Later + watch progress + opened titles).
// Candidates (per-seed "more like this" first, then the weekly trending pool)
// score against the WEIGHTED genre map; reasons stay truthful per the
// highest-weight contributing signal. Completed titles join the exclusion
// set. Falls back to the legacy favourites-only path when the profile is
// unreadable.
func (s *Service) computeFromTaste(ctx context.Context, revision int64) (Result, error) {
	signals, err := s.taste.HouseholdSignals(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		result, fallbackErr := s.computeFromFavourites(ctx, revision)
		result.Degraded = true
		return result, fallbackErr
	}

	// Deduplicate signals per canonical id (max weight wins: a favourited
	// title that is also in Watch Later or was started contributes once).
	type signalInfo struct {
		id     string
		kind   string
		title  string
		label  string
		weight float64
	}
	best := map[string]signalInfo{}
	var completed []string
	for _, signal := range signals {
		if signal.CanonicalID == "" || signal.Label == "" {
			continue
		}
		if signal.Label == "completed" {
			completed = append(completed, signal.CanonicalID)
			continue
		}
		weight := signal.Weight * recencyFactor(s.now(), signal.At)
		current, exists := best[signal.CanonicalID]
		if !exists || weight > current.weight {
			best[signal.CanonicalID] = signalInfo{
				id: signal.CanonicalID, kind: signal.Kind, title: signal.Title,
				label: signal.Label, weight: weight,
			}
		}
	}
	if len(best) == 0 {
		return Result{Revision: revision, Fallback: true, GeneratedAt: s.now(), Items: []Item{}}, nil
	}

	// Genre keys per signal title (one bounded detail call per unique id per
	// cache build — favourites/watch-later ids already resolve this way).
	type signalInfoWithKeys struct {
		signalInfo
		keys map[string]bool
	}
	// Each title needs its genres and display title (catalog detail calls);
	// resolve them concurrently, each call bounded so one hung provider
	// request cannot stall Home.
	signalList := make([]signalInfo, 0, len(best))
	for _, signal := range best {
		signalList = append(signalList, signal)
	}
	sort.Slice(signalList, func(i, j int) bool { return signalList[i].id < signalList[j].id })
	resolved := make([]signalInfoWithKeys, len(signalList))
	forEachBounded(len(signalList), func(index int) {
		signal := signalList[index]
		callCtx, cancel := context.WithTimeout(ctx, providerCallTimeout)
		defer cancel()
		keys := map[string]bool{}
		genres, err := s.seedGenres.SeedGenres(callCtx, signal.id)
		if err == nil {
			namespace := seedNamespace(signal.id)
			for _, genre := range genres {
				if key := genreKey(namespace, genre); key != "" {
					keys[key] = true
				}
			}
		}
		if len(keys) == 0 {
			// Genres only drive overlap scoring; the title still contributes
			// its "more like this" lists (a flaky detail lookup must not drop
			// a household title from recommendations).
			log.Printf("[recommendations] genres for %s unavailable; using its similar lists only: %v", signal.id, err)
		}
		if titled, ok := s.seedGenres.(interface {
			SeedTitle(ctx context.Context, canonicalID string) (string, error)
		}); ok {
			if title, err := titled.SeedTitle(callCtx, signal.id); err == nil && strings.TrimSpace(title) != "" {
				signal.title = title
			}
		}
		resolved[index] = signalInfoWithKeys{signalInfo: signal, keys: keys}
	})
	if len(resolved) == 0 {
		return Result{Revision: revision, Fallback: true, GeneratedAt: s.now(), Items: []Item{}}, nil
	}

	// Weighted genre map for scoring: one genre accumulates the weights of
	// every signal that shares it (a genre favourited AND watched weighs
	// more than one merely visited).
	weightOf := map[string]float64{}
	for _, signal := range resolved {
		for key := range signal.keys {
			weightOf[key] += signal.weight
		}
	}

	// Candidate pool: per-seed "more like this" for the strongest signals
	// FIRST (genuinely personal), then the global weekly trending pool.
	pool := make([]catalog.Title, 0, candidateLimit)
	// seedsFor lists every signal whose "more like this" lists contain a
	// candidate — its truthful reason, not whichever signal weighs most among
	// shared genres. A title
	// that several of the household's titles point at is a consensus pick
	// about the household as a whole, not one title's provider list.
	seedsFor := map[string][]*signalInfoWithKeys{}
	if s.seedSimilar != nil {
		ordered := append([]signalInfoWithKeys(nil), resolved...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].weight > ordered[j].weight })
		// Fetch every seed's lists concurrently, then merge in weight order.
		seedCount := min(len(ordered), seedSimilarSeeds)
		similarLists := make([][]catalog.Title, seedCount)
		forEachBounded(seedCount, func(i int) {
			callCtx, cancel := context.WithTimeout(ctx, providerCallTimeout)
			defer cancel()
			similar, err := s.similarFor(callCtx, s.seedSimilar, "same", ordered[i].id)
			if err != nil {
				log.Printf("[recommendations] similar titles for %s unavailable: %v", ordered[i].id, err)
			}
			if s.crossSimilar != nil {
				if cross, crossErr := s.similarFor(callCtx, s.crossSimilar, "cross", ordered[i].id); crossErr == nil {
					similar = mixCross(similar, cross)
				}
			}
			similarLists[i] = similar
		})
		for i := 0; i < seedCount; i++ {
			similar := similarLists[i]
			if len(similar) == 0 {
				continue
			}
			for _, candidate := range similar {
				listed := false
				for _, existing := range seedsFor[candidate.ID] {
					if existing.id == ordered[i].id {
						listed = true
						break
					}
				}
				if !listed {
					seedsFor[candidate.ID] = append(seedsFor[candidate.ID], &ordered[i])
				}
			}
			pool = append(pool, similar...)
		}
	}
	trending, err := s.candidates.Candidates(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read candidate pool: %w", err)
	}
	pool = append(pool, trending...)

	excluded := map[string]bool{}
	for _, id := range completed {
		excluded[id] = true
	}

	// Score: each candidate sums the profile weights of its overlapping
	// genres; the reason attributes the highest-weight contributing signal.
	seen := map[string]bool{}
	type scored struct {
		title      catalog.Title
		rank       int
		score      float64
		reasonSeed *signalInfoWithKeys
		alsoSeed   *signalInfoWithKeys // second supporting title (consensus picks)
		supported  bool                // listed by at least one household title
		explore    bool                // exploration slot (not tied to one title)
	}
	scored_ := make([]scored, 0, len(pool))
	for rank, candidate := range pool {
		if seen[candidate.ID] {
			continue
		}
		seen[candidate.ID] = true
		if excluded[candidate.ID] {
			continue
		}
		namespace := seedNamespace(candidate.ID)
		var score float64
		var reasonSeed *signalInfoWithKeys
		for _, signal := range resolved {
			shared := false
			for _, genre := range candidate.Genres {
				if key := genreKey(namespace, genre); key != "" && signal.keys[key] {
					shared = true
					break
				}
			}
			if shared {
				score += signal.weight
				if reasonSeed == nil || signal.weight > reasonSeed.weight {
					reasonSeed = &signal
				}
			}
		}
		// "More like this" support from each listing title outranks genre
		// overlap alone, and accumulates across titles (consensus).
		var alsoSeed *signalInfoWithKeys
		if supporters := seedsFor[candidate.ID]; len(supporters) > 0 {
			ranked := append([]*signalInfoWithKeys(nil), supporters...)
			sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].weight > ranked[j].weight })
			for _, seed := range ranked {
				score += seed.weight
			}
			reasonSeed = ranked[0]
			if len(ranked) > 1 {
				alsoSeed = ranked[1]
			}
		}
		// Daily variety: a small, date-seeded jitter reorders near-equal
		// picks each day without overturning clear preferences.
		score += dailyJitter(s.now(), candidate.ID) * 0.3
		scored_ = append(scored_, scored{title: candidate, rank: rank, score: score, reasonSeed: reasonSeed, alsoSeed: alsoSeed, supported: len(seedsFor[candidate.ID]) > 0})
	}

	// Deterministic ordering: score desc, provider popularity rank, canonical id.
	sort.SliceStable(scored_, func(i, j int) bool {
		if scored_[i].score != scored_[j].score {
			return scored_[i].score > scored_[j].score
		}
		if scored_[i].rank != scored_[j].rank {
			return scored_[i].rank < scored_[j].rank
		}
		return scored_[i].title.ID < scored_[j].title.ID
	})

	// Diversity: rotate between the shows behind the recommendations so one
	// heavy signal (e.g. a Watch Later title) cannot crowd out the rest;
	// each show's own candidates keep their score order, popular picks last.
	{
		groups := map[string][]scored{}
		order := []string{}
		var consensus, explore []scored
		for _, entry := range scored_ {
			switch {
			case entry.alsoSeed != nil:
				consensus = append(consensus, entry) // already score-ordered
			case entry.supported && entry.reasonSeed != nil:
				key := entry.reasonSeed.id
				if _, seen := groups[key]; !seen {
					order = append(order, key)
				}
				groups[key] = append(groups[key], entry)
			default:
				// Not listed by any household title: exploration pool,
				// already ordered by profile genre affinity, then popularity.
				entry.explore = true
				explore = append(explore, entry)
			}
		}
		// Consensus picks (backed by several household titles) lead; then
		// titles rotate, with one exploration pick after every four.
		interleaved := append(make([]scored, 0, len(scored_)), consensus...)
		sinceExplore := 0
		for progress := true; progress; {
			progress = false
			for _, key := range order {
				if len(groups[key]) == 0 {
					continue
				}
				interleaved = append(interleaved, groups[key][0])
				groups[key] = groups[key][1:]
				progress = true
				sinceExplore++
				if sinceExplore >= exploreEvery && len(explore) > 0 {
					interleaved = append(interleaved, explore[0])
					explore = explore[1:]
					sinceExplore = 0
				}
			}
		}
		scored_ = append(interleaved, explore...)
	}

	reasonText := map[string]func(string) string{
		"favourited":  func(t string) string { return fmt.Sprintf("Because you favourited %s", t) },
		"watched":     func(t string) string { return fmt.Sprintf("Because you watched %s", t) },
		"watch-later": func(t string) string { return fmt.Sprintf("Because %s is in your Watch Later", t) },
		"started":     func(t string) string { return fmt.Sprintf("Because you started %s", t) },
		"downloaded":  func(t string) string { return fmt.Sprintf("Because you downloaded %s", t) },
		"opened":      func(t string) string { return fmt.Sprintf("Because you opened %s", t) },
	}
	items := make([]Item, 0, len(scored_))
	for _, entry := range scored_ {
		item := Item{
			CanonicalID: entry.title.ID,
			Type:        string(entry.title.Type),
			Title:       entry.title.Title,
			Year:        entry.title.Year,
			Artwork:     entry.title.Artwork,
			Reason:      Reason{Code: reasonPopular, Text: "Popular pick"},
		}
		if entry.explore {
			// Exploration: well-regarded outside the household's own lists.
			item.Reason = Reason{Code: reasonPopular, Text: "Something different"}
		} else if entry.score > 0 && entry.reasonSeed != nil {
			primary := shortTitle(entry.reasonSeed.title)
			text := reasonText[entry.reasonSeed.label](primary)
			if entry.alsoSeed != nil && entry.alsoSeed.title != entry.alsoSeed.id {
				if other := shortTitle(entry.alsoSeed.title); !strings.EqualFold(other, primary) {
					text = fmt.Sprintf("Because you like %s and %s", primary, other)
				} else {
					text = fmt.Sprintf("Because you like %s", primary) // same franchise
				}
			}
			// An unresolved title is only an id: never show it to people.
			if entry.reasonSeed.title == entry.reasonSeed.id {
				text = "Picked for you"
			}
			item.Reason = Reason{
				Code:            reasonSeedGenre,
				Text:            text,
				SeedCanonicalID: entry.reasonSeed.id,
			}
		}
		items = append(items, item)
	}
	return Result{Revision: revision, Fallback: false, GeneratedAt: s.now(), Items: items}, nil
}

// seedNamespace extracts the provider namespace from a canonical id
// ("tmdb:tv:123" → "tmdb") for the provider-qualified genre key.
func seedNamespace(canonicalID string) string {
	if idx := strings.Index(canonicalID, ":"); idx > 0 {
		return canonicalID[:idx]
	}
	return canonicalID
}

// genreKey builds the provider-qualified normalized genre key. An empty
// normalized genre yields no key.
func genreKey(namespace, genre string) string {
	normalized := strings.Join(strings.Fields(strings.ToLower(genre)), " ")
	if normalized == "" {
		return ""
	}
	return namespace + ":" + normalized
}

// exploreEvery places one exploration pick after this many personal picks.
const exploreEvery = 4

// recencyFactor decays a signal's weight with age: half every 60 days, never
// below a quarter (old favourites still count). Undated signals keep full
// weight.
func recencyFactor(now, at time.Time) float64 {
	if at.IsZero() || !at.Before(now) {
		return 1
	}
	days := now.Sub(at).Hours() / 24
	factor := math.Pow(0.5, days/60)
	if factor < 0.25 {
		return 0.25
	}
	return factor
}

// dailyJitter is a stable per-day pseudo-random value in [0,1) for a title,
// so the list varies from day to day but not between requests.
func dailyJitter(now time.Time, id string) float64 {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(now.UTC().Format("2006-01-02") + "\x00" + id))
	return float64(hash.Sum32()%1000) / 1000
}

// shortTitle trims a seed title to its main name for reasons: subtitles after
// ":" or " - " and franchise suffixes are dropped ("Demon Slayer -Kimetsu no
// Yaiba- The Movie: Mugen Train" → "Demon Slayer"), keeping at least three
// characters of the original.
func shortTitle(title string) string {
	short := strings.TrimSpace(title)
	for _, separator := range []string{":", " - ", " -", " – "} {
		if index := strings.Index(short, separator); index >= 3 {
			short = strings.TrimSpace(short[:index])
		}
	}
	if len([]rune(short)) > 40 {
		short = string([]rune(short)[:38]) + "…"
	}
	if short == "" {
		return title
	}
	return short
}

// forEachBounded runs fn(0..n-1) with at most providerConcurrency at once.
func forEachBounded(n int, fn func(int)) {
	var wg sync.WaitGroup
	slots := make(chan struct{}, providerConcurrency)
	for i := 0; i < n; i++ {
		wg.Add(1)
		slots <- struct{}{}
		go func(index int) {
			defer wg.Done()
			defer func() { <-slots }()
			fn(index)
		}(i)
	}
	wg.Wait()
}
