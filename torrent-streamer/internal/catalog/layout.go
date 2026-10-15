package catalog

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"

	"torrent-streamer/internal/animemap"
)

// A show's seasons and episodes come from one source: Stremio's catalog
// (Cinemeta, TVDB's layout). TMDb splits some shows into broadcast seasons
// (Dragon Ball Z Kai: six), AniList lists each season or arc as its own
// entry, and merging their episode lists by number mixed arcs together.
// Other sources only fill what Cinemeta lacks on an episode it lists:
// ani.zip's images and summaries for anime (same TVDB numbering), TMDb's
// for a season TMDb numbers the same way.

// LayoutStore keeps the last Cinemeta answer per show, so a show keeps its
// seasons while Cinemeta is unreachable.
type LayoutStore interface {
	GetLayout(ctx context.Context, imdb string) ([]byte, bool)
	PutLayout(ctx context.Context, imdb string, payload []byte)
}

// SQLLayouts keeps layouts in Postgres (catalog_layouts).
type SQLLayouts struct{ DB *sql.DB }

func (s *SQLLayouts) GetLayout(ctx context.Context, imdb string) ([]byte, bool) {
	var payload []byte
	if err := s.DB.QueryRowContext(ctx, `SELECT payload FROM catalog_layouts WHERE imdb_id=$1`, imdb).Scan(&payload); err != nil {
		return nil, false
	}
	return payload, true
}

func (s *SQLLayouts) PutLayout(ctx context.Context, imdb string, payload []byte) {
	_, _ = s.DB.ExecContext(context.WithoutCancel(ctx), `
INSERT INTO catalog_layouts (imdb_id, payload, fetched_at) VALUES ($1, $2, now())
ON CONFLICT (imdb_id) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=now()`, imdb, payload)
}

// MemoryLayouts is an in-memory LayoutStore (tests).
type MemoryLayouts struct {
	mu   sync.Mutex
	data map[string][]byte
}

func (m *MemoryLayouts) GetLayout(_ context.Context, imdb string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	payload, ok := m.data[imdb]
	return payload, ok
}

func (m *MemoryLayouts) PutLayout(_ context.Context, imdb string, payload []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.data == nil {
		m.data = map[string][]byte{}
	}
	m.data[imdb] = payload
}

// showLayout is a show as Stremio lists it.
type showLayout struct {
	imdb     string
	seasons  []Season  // specials (0) included
	episodes []Episode // every season, Absolute set on regular episodes
}

func (l showLayout) season(number int) []Episode {
	var out []Episode
	for _, episode := range l.episodes {
		if episode.Season == number {
			out = append(out, episode)
		}
	}
	return out
}

func (l showLayout) hasSeason(number, episodes int) bool {
	for _, season := range l.seasons {
		if season.Number == number {
			return season.EpisodeCount >= episodes
		}
	}
	return false
}

func (s *Service) cinemeta() *Cinemeta {
	for _, provider := range s.providers {
		if c, ok := provider.(*Cinemeta); ok {
			return c
		}
	}
	return nil
}

func (s *Service) animeMap() *animemap.Map {
	if s.options.AnimeMap == nil {
		return nil
	}
	return s.options.AnimeMap()
}

// layout returns the show's Stremio layout: Cinemeta's answer, else the
// saved copy. ok is false when neither knows the show as a series.
func (s *Service) layout(ctx context.Context, imdb string) (showLayout, bool) {
	cinemeta := s.cinemeta()
	if cinemeta == nil || !strings.HasPrefix(imdb, "tt") {
		return showLayout{}, false
	}
	reply := s.fetchCached(ctx, "cinemeta-layout", imdb, func(callCtx context.Context) (any, error) {
		meta, err := cinemeta.fetchMeta(callCtx, imdb, "series")
		if err == nil {
			if payload, encodeErr := json.Marshal(meta); encodeErr == nil && s.options.Layouts != nil {
				s.options.Layouts.PutLayout(callCtx, imdb, payload)
			}
			return meta, nil
		}
		if s.options.Layouts != nil && !errors.Is(err, ErrNotFound) {
			if payload, ok := s.options.Layouts.GetLayout(callCtx, imdb); ok {
				var saved cinemetaMetaResponse
				if json.Unmarshal(payload, &saved) == nil {
					return saved, nil
				}
			}
		}
		return nil, err
	})
	meta, ok := reply.value.(cinemetaMetaResponse)
	if !ok || (reply.err != nil && !reply.stale) {
		return showLayout{}, false
	}
	layout := layoutFromMeta(imdb, meta)
	return layout, len(layout.seasons) > 0
}

func layoutFromMeta(imdb string, meta cinemetaMetaResponse) showLayout {
	layout := showLayout{imdb: imdb}
	seen := map[[2]int]bool{}
	for _, video := range meta.Meta.Videos {
		season, number := int(video.Season), int(video.Episode)
		if season < 0 || number <= 0 || seen[[2]int{season, number}] {
			continue
		}
		seen[[2]int{season, number}] = true
		layout.episodes = append(layout.episodes, Episode{
			ID:          "imdb:" + imdb + ":" + strconv.Itoa(season) + ":" + strconv.Itoa(number),
			Season:      season,
			Episode:     number,
			Title:       strings.TrimSpace(video.Name),
			AirDate:     video.Released,
			Still:       string(video.Thumbnail),
			Overview:    cmp.Or(video.Overview, video.Description),
			ProviderIDs: map[string]string{"imdb": imdb},
		})
	}
	sort.SliceStable(layout.episodes, func(i, j int) bool {
		a, b := layout.episodes[i], layout.episodes[j]
		if (a.Season == 0) != (b.Season == 0) {
			return b.Season == 0 // specials after the regular seasons
		}
		if a.Season != b.Season {
			return a.Season < b.Season
		}
		return a.Episode < b.Episode
	})
	bySeason := map[int]*Season{}
	absolute := 0
	for i := range layout.episodes {
		episode := &layout.episodes[i]
		if episode.Season > 0 {
			absolute++
			episode.Absolute = absolute
		}
		season := bySeason[episode.Season]
		if season == nil {
			name := "Season " + strconv.Itoa(episode.Season)
			if episode.Season == 0 {
				name = "Specials"
			}
			season = &Season{Number: episode.Season, Name: name}
			bySeason[episode.Season] = season
		}
		season.EpisodeCount++
		if released := episode.AirDate; len(released) >= 10 && (season.AirDate == "" || released[:10] < season.AirDate) {
			season.AirDate = released[:10]
		}
	}
	for _, season := range bySeason {
		layout.seasons = append(layout.seasons, *season)
	}
	sort.Slice(layout.seasons, func(i, j int) bool { return layout.seasons[i].Number < layout.seasons[j].Number })
	return layout
}

// layoutSeasons is the season list of a show page: Stremio's seasons, with
// TMDb's poster for a season TMDb numbers the same way.
func layoutSeasons(layout showLayout, tmdb []Season) []Season {
	posters := map[int]Season{}
	for _, season := range tmdb {
		posters[season.Number] = season
	}
	out := make([]Season, 0, len(layout.seasons))
	for _, season := range layout.seasons {
		if theirs, ok := posters[season.Number]; ok && theirs.EpisodeCount == season.EpisodeCount {
			season.Poster = theirs.Poster
			if season.Number > 0 && theirs.Name != "" {
				season.Name = theirs.Name
			}
		}
		out = append(out, season)
	}
	return out
}

// tmdbTVNumber is N of "tmdb:tv:N" (0 otherwise).
func tmdbTVNumber(id string) int {
	if !strings.HasPrefix(id, "tmdb:tv:") {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimPrefix(id, "tmdb:tv:"))
	return n
}

// showIMDb finds a show page's IMDb id: remembered, else from its detail.
func (s *Service) showIMDb(ctx context.Context, id string) string {
	if link, ok := s.link(ctx, id); ok && link.ProviderIDs["imdb"] != "" {
		return link.ProviderIDs["imdb"]
	}
	detail := s.Detail(ctx, id)
	if !detail.Found {
		return ""
	}
	return cmp.Or(detail.Title.IMDBID, detail.Title.ProviderIDs["imdb"])
}

// layoutEpisodes answers a show page's season from its Stremio layout,
// filled in from ani.zip (anime) or TMDb (a season numbered alike).
func (s *Service) layoutEpisodes(ctx context.Context, id string, season int) (EpisodeResult, bool) {
	tmdbTV := tmdbTVNumber(id)
	if tmdbTV == 0 {
		return EpisodeResult{}, false
	}
	imdb := s.showIMDb(ctx, id)
	if imdb == "" {
		return EpisodeResult{}, false
	}
	layout, ok := s.layout(ctx, imdb)
	if !ok {
		return EpisodeResult{}, false
	}
	episodes := layout.season(season)
	for i := range episodes {
		episodes[i].TitleID = id
		episodes[i].ID = id + ":" + strconv.Itoa(episodes[i].Season) + ":" + strconv.Itoa(episodes[i].Episode)
	}
	anime := s.animeMap()
	if anime.IsAnime(imdb, tmdbTV) {
		s.fillFromAniZip(ctx, anime, imdb, tmdbTV, season, episodes)
	} else {
		s.fillFromTMDb(ctx, tmdbTV, season, episodes)
	}
	return EpisodeResult{Episodes: episodes, DegradedProviders: []string{}}, true
}

// fillFromAniZip gives anime episodes ani.zip's image, summary and title
// (its episodes carry their TVDB season and number, Stremio's numbering).
// Stremio's own thumbnails are TMDb images looked up by Stremio's number,
// which TMDb numbers differently for many anime, so ani.zip's come first.
func (s *Service) fillFromAniZip(ctx context.Context, anime *animemap.Map, imdb string, tmdbTV, season int, episodes []Episode) {
	var aniZip *AniZip
	for _, provider := range s.providers {
		if p, ok := provider.(*AniZip); ok {
			aniZip = p
		}
	}
	if aniZip == nil {
		return
	}
	entries := anime.SeasonEntries(imdb, tmdbTV, season)
	if len(entries) == 0 && season == 0 {
		return
	}
	payloads := make([]aniZipMappings, len(entries))
	var wait sync.WaitGroup
	for i, entry := range entries {
		wait.Go(func() {
			key := "mappings:anilist=" + strconv.Itoa(entry.AniList)
			reply := s.fetchCached(ctx, "anizip", key, func(callCtx context.Context) (any, error) {
				payload, _, err := aniZip.fetchMappings(callCtx, map[string]string{"anilist": strconv.Itoa(entry.AniList)})
				return payload, err
			})
			if payload, ok := reply.value.(aniZipMappings); ok {
				payloads[i] = payload
			}
		})
	}
	wait.Wait()
	byNumber := map[int]aniZipEpisode{}
	for _, payload := range payloads {
		for _, episode := range payload.Episodes {
			if int(episode.SeasonNumber) == season && episode.EpisodeNumber > 0 {
				byNumber[int(episode.EpisodeNumber)] = episode
			}
		}
	}
	for i := range episodes {
		theirs, ok := byNumber[episodes[i].Episode]
		if !ok {
			continue
		}
		if theirs.Image != "" {
			episodes[i].Still = theirs.Image
		}
		if episodes[i].Overview == "" {
			episodes[i].Overview = cmp.Or(theirs.Overview, theirs.Summary)
		}
		if title := preferredTitle(theirs.Title); title != "" && (episodes[i].Title == "" || strings.HasPrefix(episodes[i].Title, "Episode ")) {
			episodes[i].Title = title
		}
		if episodes[i].DurationS == 0 {
			episodes[i].DurationS = int(cmp.Or(theirs.Runtime, theirs.Length) * 60)
		}
	}
}

// fillFromTMDb gives a season TMDb numbers the same way (same episode
// count) TMDb's stills, summaries and runtimes.
func (s *Service) fillFromTMDb(ctx context.Context, tmdbTV, season int, episodes []Episode) {
	var tmdb *TMDb
	for _, provider := range s.providers {
		if p, ok := provider.(*TMDb); ok {
			tmdb = p
		}
	}
	if tmdb == nil || len(episodes) == 0 {
		return
	}
	ids := map[string]string{"tmdb": "tv:" + strconv.Itoa(tmdbTV)}
	reply := s.fetchCached(ctx, tmdb.Name(), episodeIDsKey(ids, season), func(callCtx context.Context) (any, error) {
		return tmdb.Episodes(callCtx, EpisodeRequest{ProviderIDs: ids, Season: season})
	})
	theirs, ok := reply.value.([]Episode)
	if !ok || len(theirs) != len(episodes) {
		return
	}
	byNumber := map[int]Episode{}
	for _, episode := range theirs {
		byNumber[episode.Episode] = episode
	}
	for i := range episodes {
		match, ok := byNumber[episodes[i].Episode]
		if !ok {
			continue
		}
		if match.Still != "" {
			episodes[i].Still = match.Still
		}
		if episodes[i].Overview == "" {
			episodes[i].Overview = match.Overview
		}
		if episodes[i].Title == "" {
			episodes[i].Title = match.Title
		}
		if episodes[i].DurationS == 0 {
			episodes[i].DurationS = match.DurationS
		}
	}
}

// placeEntry puts an anime entry (an AniList season or arc) in its show,
// by the community anime list; ok is false when the list does not know it.
// A placement the show's Stremio layout contradicts is dropped.
func (s *Service) placeEntry(ctx context.Context, providerName, externalID string) (*SeriesLink, bool) {
	if providerName != "anilist" {
		return nil, false
	}
	anilist, err := strconv.Atoi(externalID)
	if err != nil {
		return nil, false
	}
	entry, ok := s.animeMap().AniList(anilist)
	if !ok {
		return nil, false
	}
	if entry.TMDbTV <= 0 || entry.Type == "MOVIE" {
		return nil, true // a film, or a show TMDb does not list: its own page
	}
	link := &SeriesLink{ID: "tmdb:tv:" + strconv.Itoa(entry.TMDbTV), Season: entry.Season, EpisodeOffset: entry.EpisodeOffset}
	if !entry.HasSeason {
		link.Season, link.EpisodeOffset, link.Absolute = 1, 0, true
	}
	if link.Season <= 0 {
		return nil, true // specials stay pages of their own
	}
	if len(entry.IMDb) > 0 {
		if layout, ok := s.layout(ctx, entry.IMDb[0]); ok && !link.Absolute && !layout.hasSeason(link.Season, link.EpisodeOffset+1) {
			return nil, true
		}
	}
	return link, true
}

// applyLayout gives a show page Stremio's seasons and marks anime.
func (s *Service) applyLayout(ctx context.Context, id string, title *Title) {
	imdb := cmp.Or(title.IMDBID, title.ProviderIDs["imdb"])
	tmdbTV := tmdbTVNumber(id)
	anime := s.animeMap()
	if strings.HasPrefix(id, "tmdb:") || strings.HasPrefix(id, "imdb:") {
		movie := 0
		if strings.HasPrefix(id, "tmdb:movie:") {
			movie, _ = strconv.Atoi(strings.TrimPrefix(id, "tmdb:movie:"))
		}
		title.Anime = anime.IsAnime(imdb, tmdbTV) || (movie > 0 && len(anime.ForIMDb(imdb)) > 0)
	}
	if tmdbTV == 0 || imdb == "" {
		return
	}
	if layout, ok := s.layout(ctx, imdb); ok {
		title.Seasons = layoutSeasons(layout, title.Seasons)
	}
}

// Placement is where an AniList entry sits in its show.
type Placement struct {
	Show          string // tmdb:tv:N
	Season        int
	EpisodeOffset int
	Absolute      bool // the entry spans seasons: its episode N is the show's Nth
}

// EntryPlacement places an "anilist:N" series id in its show (ok false for
// any other id, or an entry the anime list cannot place).
func (s *Service) EntryPlacement(ctx context.Context, seriesID string) (Placement, bool) {
	externalID, found := strings.CutPrefix(seriesID, "anilist:")
	if !found {
		return Placement{}, false
	}
	link, known := s.placeEntry(ctx, "anilist", externalID)
	if !known || link == nil {
		return Placement{}, false
	}
	return Placement{Show: link.ID, Season: link.Season, EpisodeOffset: link.EpisodeOffset, Absolute: link.Absolute}, true
}

// PlaceEpisode moves an AniList entry's episode (its own numbering) to its
// show's season and episode. An entry spanning seasons needs the show's
// layout to find its Nth episode.
func (s *Service) PlaceEpisode(ctx context.Context, seriesID string, episode int) (show string, season, number int, ok bool) {
	placement, ok := s.EntryPlacement(ctx, seriesID)
	if !ok || episode <= 0 {
		return "", 0, 0, false
	}
	if !placement.Absolute {
		return placement.Show, placement.Season, episode + placement.EpisodeOffset, true
	}
	imdb := s.showIMDb(ctx, placement.Show)
	layout, found := s.layout(ctx, imdb)
	if !found {
		return "", 0, 0, false
	}
	for _, candidate := range layout.episodes {
		if candidate.Absolute == episode {
			return placement.Show, candidate.Season, candidate.Episode, true
		}
	}
	return "", 0, 0, false
}

// EntrySeason is the show season an AniList entry fills from episode
// offset+1 (ok false for an entry spanning seasons, or not placeable).
func (s *Service) EntrySeason(ctx context.Context, seriesID string) (show string, season, offset int, ok bool) {
	placement, found := s.EntryPlacement(ctx, seriesID)
	if !found || placement.Absolute {
		return "", 0, 0, false
	}
	return placement.Show, placement.Season, placement.EpisodeOffset, true
}

// IsAnimeShow reports a tmdb:tv:N show the anime list knows.
func (s *Service) IsAnimeShow(id string) bool {
	tmdbTV := tmdbTVNumber(id)
	return tmdbTV > 0 && len(s.animeMap().ForTMDbTV(tmdbTV)) > 0
}

// EntryShow is the show an AniList entry belongs to, also when the entry
// spans several of its seasons.
func (s *Service) EntryShow(ctx context.Context, seriesID string) (string, bool) {
	placement, found := s.EntryPlacement(ctx, seriesID)
	if !found {
		return "", false
	}
	return placement.Show, true
}
