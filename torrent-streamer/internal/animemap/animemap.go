// Package animemap places anime entries in the shows they belong to.
//
// AniList (like MAL and Kitsu) lists every season or arc of an anime as its
// own entry: Dragon Ball Z Kai is two entries, Demon Slayer five. Stremio
// (Cinemeta) and Sonarr list each anime as one show with TVDB's seasons. The
// community anime list (Fribb/anime-lists, used by Plex and Kometa) links
// every entry to that show (IMDb, TVDB and TMDb ids) and to its TVDB season
// and episode offset, so an entry's place in the show is a lookup, not a
// guess. The list is one file, read into memory and refreshed daily.
package animemap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// DefaultURL is the full community list.
const DefaultURL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json"

// refreshEvery is how often the list is fetched again.
const refreshEvery = 24 * time.Hour

// Entry is one AniList/MAL/Kitsu entry and its place in a show.
type Entry struct {
	AniList, MAL, Kitsu, TVDB int
	IMDb                      []string
	TMDbTV, TMDbMovie         int
	Type                      string // TV, MOVIE, ONA, OVA, SPECIAL
	// Season is the entry's TVDB season (0 for specials); HasSeason is false
	// when the entry spans several seasons (One Piece) or is unplaced.
	Season    int
	HasSeason bool
	// EpisodeOffset: the entry's episode N is the season's N+EpisodeOffset.
	EpisodeOffset int
}

// Map indexes the list.
type Map struct {
	byAniList map[int]Entry
	byIMDb    map[string][]Entry
	byTMDbTV  map[int][]Entry
}

type rawEntry struct {
	Type          string          `json:"type"`
	AniList       int             `json:"anilist_id"`
	MAL           int             `json:"mal_id"`
	Kitsu         int             `json:"kitsu_id"`
	TVDB          int             `json:"tvdb_id"`
	IMDb          json.RawMessage `json:"imdb_id"`
	TMDb          json.RawMessage `json:"themoviedb_id"`
	Season        map[string]int  `json:"season"`
	EpisodeOffset map[string]int  `json:"episode_offset"`
}

// Parse reads the list.
func Parse(data []byte) (*Map, error) {
	var raw []rawEntry
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("anime list: %w", err)
	}
	m := &Map{byAniList: map[int]Entry{}, byIMDb: map[string][]Entry{}, byTMDbTV: map[int][]Entry{}}
	for _, r := range raw {
		entry := Entry{AniList: r.AniList, MAL: r.MAL, Kitsu: r.Kitsu, TVDB: r.TVDB, Type: strings.ToUpper(r.Type), IMDb: imdbIDs(r.IMDb)}
		entry.TMDbTV, entry.TMDbMovie = tmdbIDs(r.TMDb)
		if season, ok := r.Season["tvdb"]; ok && r.TVDB > 0 {
			entry.Season, entry.HasSeason = season, true
			entry.EpisodeOffset = r.EpisodeOffset["tvdb"]
		}
		if entry.AniList > 0 {
			m.byAniList[entry.AniList] = entry
		}
		for _, imdb := range entry.IMDb {
			m.byIMDb[imdb] = append(m.byIMDb[imdb], entry)
		}
		if entry.TMDbTV > 0 {
			m.byTMDbTV[entry.TMDbTV] = append(m.byTMDbTV[entry.TMDbTV], entry)
		}
	}
	if len(m.byAniList) == 0 {
		return nil, fmt.Errorf("anime list: no entries")
	}
	return m, nil
}

func imdbIDs(raw json.RawMessage) []string {
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return cleanIMDb(list)
	}
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		return cleanIMDb(strings.Split(one, ","))
	}
	return nil
}

func cleanIMDb(ids []string) []string {
	var out []string
	for _, id := range ids {
		if id = strings.TrimSpace(id); strings.HasPrefix(id, "tt") {
			out = append(out, id)
		}
	}
	return out
}

func tmdbIDs(raw json.RawMessage) (tv, movie int) {
	var typed map[string]json.RawMessage
	if json.Unmarshal(raw, &typed) != nil {
		return 0, 0
	}
	number := func(value json.RawMessage) int {
		var n int
		if json.Unmarshal(value, &n) == nil {
			return n
		}
		var list []int // some movies list several ids
		if json.Unmarshal(value, &list) == nil && len(list) > 0 {
			return list[0]
		}
		return 0
	}
	return number(typed["tv"]), number(typed["movie"])
}

// AniList returns an entry by AniList id.
func (m *Map) AniList(id int) (Entry, bool) {
	if m == nil {
		return Entry{}, false
	}
	entry, ok := m.byAniList[id]
	return entry, ok
}

// ForIMDb returns the entries of a show (or film) by IMDb id.
func (m *Map) ForIMDb(imdb string) []Entry {
	if m == nil {
		return nil
	}
	return m.byIMDb[imdb]
}

// ForTMDbTV returns the entries of a show by TMDb tv id.
func (m *Map) ForTMDbTV(id int) []Entry {
	if m == nil {
		return nil
	}
	return m.byTMDbTV[id]
}

// IsAnime reports whether a show or film is anime (has an entry).
func (m *Map) IsAnime(imdb string, tmdbTV int) bool {
	return len(m.ForIMDb(imdb)) > 0 || len(m.ForTMDbTV(tmdbTV)) > 0
}

// SeasonEntries returns a show's entries in one TVDB season, ordered by
// episode offset (a split-cour season has two).
func (m *Map) SeasonEntries(imdb string, tmdbTV int, season int) []Entry {
	entries := m.ForIMDb(imdb)
	if len(entries) == 0 {
		entries = m.ForTMDbTV(tmdbTV)
	}
	var out []Entry
	for _, entry := range entries {
		if entry.HasSeason && entry.Season == season && entry.AniList > 0 {
			out = append(out, entry)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].EpisodeOffset < out[j-1].EpisodeOffset; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Source keeps the current list: read from disk at start, fetched again
// daily. Its methods are safe before the first load (nothing is found).
type Source struct {
	path, url string
	client    *http.Client
	current   atomic.Pointer[Map]
}

// NewSource keeps the list at path (directory created as needed).
func NewSource(path, url string, client *http.Client) *Source {
	if url == "" {
		url = DefaultURL
	}
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return &Source{path: path, url: url, client: client}
}

// Current returns the loaded list (nil-safe: a nil *Map finds nothing).
func (s *Source) Current() *Map {
	if s == nil {
		return nil
	}
	return s.current.Load()
}

// Set replaces the list (tests).
func (s *Source) Set(m *Map) { s.current.Store(m) }

// Start loads the saved copy, then fetches a new one when it is a day old
// (and every day after) until ctx ends.
func (s *Source) Start(ctx context.Context) {
	age := time.Duration(1<<62 - 1)
	if data, err := os.ReadFile(s.path); err == nil {
		if m, err := Parse(data); err == nil {
			s.current.Store(m)
			if info, err := os.Stat(s.path); err == nil {
				age = time.Since(info.ModTime())
			}
		} else {
			log.Printf("[catalog] saved anime list unreadable: %v", err)
		}
	}
	go func() {
		wait := time.Duration(0)
		if age < refreshEvery {
			wait = refreshEvery - age
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			if err := s.refresh(ctx); err != nil {
				log.Printf("[catalog] anime list refresh failed: %v", err)
				wait = time.Hour
				continue
			}
			wait = refreshEvery
		}
	}()
}

func (s *Source) refresh(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return err
	}
	m, err := Parse(data)
	if err != nil {
		return err
	}
	s.current.Store(m)
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err == nil {
		tmp := s.path + ".tmp"
		if os.WriteFile(tmp, data, 0o644) == nil {
			_ = os.Rename(tmp, s.path)
		}
	}
	log.Printf("[catalog] anime list loaded: %d entries", len(m.byAniList))
	return nil
}
