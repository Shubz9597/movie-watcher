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
	seedLimit       = 20
	candidateLimit  = 200
	cacheTTL        = 15 * time.Minute
	reasonSeedGenre = "seed_genre"
	reasonPopular   = "popular"
	// Per-seed "more like this" bounds: the first few usable favourites each
	// contribute one bounded similar-title page to the candidate pool.
	seedSimilarLimit  = 12
	seedSimilarSeeds  = 3
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
	Label       string // favourited | watch-later | watched | started | completed | opened
	Weight      float64
	Title       string
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
	Library               LibrarySource
	Candidates            CandidateSource
	SeedGenres            SeedGenreSource
	// Optional per-seed personalization: when wired, the first few usable
	// favourites contribute their TMDb/AniList "more like this" titles to the
	// pool, ranked ahead of the global trending pool.
	SeedSimilar           SeedSimilarSource
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
	taste        TasteSource
	candidateVn  int
	now          func() time.Time

	mu    sync.Mutex
	cache *cacheEntry
	stale *cacheEntry // last computed result, served degraded when providers fail
}

// New wires the service; nil Candidates or Library keeps the capability
// unadvertised at the composition root.
func New(deps Deps) *Service {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		library:     deps.Library,
		candidates:  deps.Candidates,
		seedGenres:  deps.SeedGenres,
		seedSimilar: deps.SeedSimilar,
		taste:       deps.Taste,
		candidateVn: deps.CandidateCacheVersion,
		now:         now,
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

// compute builds one ranked result against the given revision.
func (s *Service) compute(ctx context.Context, revision int64) (Result, error) {
	if s.taste != nil {
		return s.computeFromTaste(ctx, revision)
	}
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
		return s.compute(ctx, revision) // legacy favourites-only path
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
		current, exists := best[signal.CanonicalID]
		if !exists || signal.Weight > current.weight {
			best[signal.CanonicalID] = signalInfo{
				id: signal.CanonicalID, kind: signal.Kind, title: signal.Title,
				label: signal.Label, weight: signal.Weight,
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
	resolved := make([]signalInfoWithKeys, 0, len(best))
	for _, signal := range best {
		keys := map[string]bool{}
		genres, err := s.seedGenres.SeedGenres(ctx, signal.id)
		if err == nil {
			namespace := seedNamespace(signal.id)
			for _, genre := range genres {
				if key := genreKey(namespace, genre); key != "" {
					keys[key] = true
				}
			}
		}
		if len(keys) == 0 {
			continue // no usable genre metadata: contributes nothing
		}
		resolved = append(resolved, signalInfoWithKeys{signalInfo: signal, keys: keys})
	}
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
	if s.seedSimilar != nil {
		ordered := append([]signalInfoWithKeys(nil), resolved...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].weight > ordered[j].weight })
		for i, signal := range ordered {
			if i >= seedSimilarSeeds {
				break
			}
			similar, err := s.seedSimilar.SeedSimilar(ctx, signal.id, seedSimilarLimit)
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

	reasonText := map[string]func(string) string{
		"favourited":  func(t string) string { return fmt.Sprintf("Because you favourited %s", t) },
		"watched":     func(t string) string { return fmt.Sprintf("Because you watched %s", t) },
		"watch-later": func(t string) string { return fmt.Sprintf("Because %s is in your Watch Later", t) },
		"started":     func(t string) string { return fmt.Sprintf("Because you started %s", t) },
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
		if entry.score > 0 && entry.reasonSeed != nil {
			item.Reason = Reason{
				Code:            reasonSeedGenre,
				Text:            reasonText[entry.reasonSeed.label](entry.reasonSeed.title),
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
