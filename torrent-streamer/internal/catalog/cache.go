package catalog

import (
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

var (
	seasonPartMarker = regexp.MustCompile(`\b(?:season|part|cour)\s*\d+\b`)
	nonAlphanumeric  = regexp.MustCompile(`[^a-z0-9]+`)
)

// titleMatchKey is the exact join key for deterministic merging
// (contracts/v2-catalog-api.md §Merge determinism: normalized title + year + type).
type titleMatchKey struct {
	title string
	year  int
	typ   TitleType
}

func titleKey(t Title) titleMatchKey {
	return titleMatchKey{title: NormalizeTitle(t.Title), year: t.Year, typ: t.Type}
}

func episodeKey(season, episode int) string {
	return "s" + strconv.Itoa(season) + "e" + strconv.Itoa(episode)
}

// MergeTitles merges provider result groups into one deterministic list.
// Groups MUST be ordered by provider priority; within each group results are
// resolved by lexicographic external-ID order, never map iteration order
// (contracts/v2-catalog-api.md). The highest-priority provider wins
// conflicting scalar fields; providerIds and mergedFrom accumulate.
func MergeTitles(groups [][]Title) []Title {
	var merged []Title
	index := make(map[titleMatchKey]int)
	for _, group := range groups {
		for _, candidate := range sortedByID(group) {
			key := titleKey(candidate)
			if position, ok := index[key]; ok {
				mergeTitle(&merged[position], candidate)
				continue
			}
			index[key] = len(merged)
			merged = append(merged, candidate)
		}
	}
	for i := range merged {
		if merged[i].ProviderIDs == nil {
			merged[i].ProviderIDs = map[string]string{}
		}
		if merged[i].MergedFrom == nil {
			merged[i].MergedFrom = []string{}
		}
		if merged[i].Artwork == nil {
			merged[i].Artwork = map[string]string{}
		}
	}
	return merged
}

func sortedByID(group []Title) []Title {
	result := append([]Title(nil), group...)
	sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func mergeTitle(into *Title, from Title) {
	if into.Title == "" {
		into.Title = from.Title
	}
	if into.OriginalTitle == "" {
		into.OriginalTitle = from.OriginalTitle
	}
	if into.Overview == "" {
		into.Overview = from.Overview
	}
	if into.Year == 0 {
		into.Year = from.Year
	}
	if into.IMDBID == "" {
		into.IMDBID = from.IMDBID
	}
	if into.Runtime == 0 {
		into.Runtime = from.Runtime
	}
	if len(into.Genres) == 0 {
		into.Genres = from.Genres
	}
	if into.Artwork == nil {
		into.Artwork = map[string]string{}
	}
	for key, value := range from.Artwork {
		if _, ok := into.Artwork[key]; !ok {
			into.Artwork[key] = value
		}
	}
	if into.ProviderIDs == nil {
		into.ProviderIDs = map[string]string{}
	}
	for key, value := range from.ProviderIDs {
		if _, ok := into.ProviderIDs[key]; !ok {
			into.ProviderIDs[key] = value
		}
	}
	if !containsString(into.MergedFrom, from.mergedFromName()) {
		into.MergedFrom = append(into.MergedFrom, from.mergedFromName())
	}
}

func (t Title) mergedFromName() string {
	if len(t.MergedFrom) > 0 {
		return t.MergedFrom[0]
	}
	provider, _, err := ParseTitleID(t.ID)
	if err != nil {
		return t.ID
	}
	return provider
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// MergeEpisodes merges episode groups for one title/season deterministically,
// keyed on (season, episode); highest-priority provider wins scalar fields.
func MergeEpisodes(groups [][]Episode) []Episode {
	var merged []Episode
	index := make(map[string]int)
	for _, group := range groups {
		for _, candidate := range sortedEpisodesByID(group) {
			key := episodeKey(candidate.Season, candidate.Episode)
			if position, ok := index[key]; ok {
				mergeEpisode(&merged[position], candidate)
				continue
			}
			index[key] = len(merged)
			merged = append(merged, candidate)
		}
	}
	for i := range merged {
		if merged[i].ProviderIDs == nil {
			merged[i].ProviderIDs = map[string]string{}
		}
	}
	return merged
}

func sortedEpisodesByID(group []Episode) []Episode {
	result := append([]Episode(nil), group...)
	sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func mergeEpisode(into *Episode, from Episode) {
	if into.Title == "" {
		into.Title = from.Title
	}
	if into.AirDate == "" {
		into.AirDate = from.AirDate
	}
	if into.Still == "" {
		into.Still = from.Still
	}
	if into.Overview == "" {
		into.Overview = from.Overview
	}
	if into.DurationS == 0 {
		into.DurationS = from.DurationS
	}
	if into.ProviderIDs == nil {
		into.ProviderIDs = map[string]string{}
	}
	for key, value := range from.ProviderIDs {
		if _, ok := into.ProviderIDs[key]; !ok {
			into.ProviderIDs[key] = value
		}
	}
}

// Cache is the bounded in-memory TTL cache backing graceful degradation
// (contracts/v2-catalog-api.md: stale-but-valid entries are served when a
// provider is down; entries are never garbage-collected while in use; the
// cache is bounded by entry count with oldest-expiry eviction).
type Cache struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[string]*cacheEntry
}

type cacheEntry struct {
	value    any
	fetched  time.Time
	expires  time.Time
	provider string
}

func NewCache(maxEntries int) *Cache {
	if maxEntries <= 0 {
		maxEntries = 512
	}
	return &Cache{maxEntries: maxEntries, entries: make(map[string]*cacheEntry)}
}

func (c *Cache) Set(provider, key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if len(c.entries) >= c.maxEntries {
		c.evictOldestLocked(now)
	}
	c.entries[provider+"\x00"+key] = &cacheEntry{value: value, fetched: now, expires: now.Add(ttl), provider: provider}
}

func (c *Cache) evictOldestLocked(now time.Time) {
	var oldestKey string
	var oldest time.Time
	first := true
	for key, entry := range c.entries {
		if !now.Before(entry.expires) {
			delete(c.entries, key)
			continue
		}
		if first || entry.expires.Before(oldest) {
			oldestKey, oldest, first = key, entry.expires, false
		}
	}
	if oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

// Get returns the cached value with its state: fresh (within TTL) or stale
// (beyond TTL, still served for degradation). Missing yields ok=false.
func (c *Cache) Get(provider, key string) (value any, state cacheState, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[provider+"\x00"+key]
	if !found {
		return nil, cacheStateMissing, false
	}
	if time.Now().Before(entry.expires) {
		return entry.value, cacheStateFresh, true
	}
	return entry.value, cacheStateStale, true
}

func (c *Cache) FetchedAt(provider, key string) (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[provider+"\x00"+key]
	if !found {
		return time.Time{}, false
	}
	return entry.fetched, true
}

type cacheState int

const (
	cacheStateMissing cacheState = iota
	cacheStateFresh
	cacheStateStale
)
