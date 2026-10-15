package catalog

import (
	"cmp"
	"context"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// markAnime types a TMDb show or film the community anime list knows as
// anime, so it opens as anime (its torrent search, skip detection).
func (s *Service) markAnime(titles []Title) []Title {
	anime := s.animeMap()
	if anime == nil {
		return titles
	}
	for i := range titles {
		title := &titles[i]
		if !strings.HasPrefix(title.ID, "tmdb:") {
			continue
		}
		imdb := cmp.Or(title.IMDBID, title.ProviderIDs["imdb"])
		if anime.IsAnime(imdb, tmdbTVNumber(title.ID)) || (strings.HasPrefix(title.ID, "tmdb:movie:") && len(anime.ForIMDb(imdb)) > 0) {
			title.Anime = true
			if title.Type == TypeSeries {
				title.Type = TypeAnime
			}
		}
	}
	return titles
}

// showOf is the show page an entry opens: itself for TMDb titles, the TMDb
// show an AniList season or arc belongs to (or the TMDb film an AniList
// film is), else "".
func (s *Service) showOf(title Title) (showID string, film bool) {
	if strings.HasPrefix(title.ID, "tmdb:") {
		return title.ID, strings.HasPrefix(title.ID, "tmdb:movie:")
	}
	anilist, err := strconv.Atoi(title.ProviderIDs["anilist"])
	if err != nil {
		return "", false
	}
	entry, ok := s.animeMap().AniList(anilist)
	if !ok {
		return "", false
	}
	if entry.Type == "MOVIE" && entry.TMDbMovie > 0 {
		return "tmdb:movie:" + strconv.Itoa(entry.TMDbMovie), true
	}
	if entry.TMDbTV > 0 && entry.Type != "MOVIE" && (!entry.HasSeason || entry.Season > 0) {
		return "tmdb:tv:" + strconv.Itoa(entry.TMDbTV), false
	}
	return "", false
}

// collapseShows lists each show once, at its best-ranked entry: Dragon Ball
// Z Kai's TMDb show and its two AniList seasons are one result, which opens
// the show. An AniList season whose show is not among the results stands
// for it (its card opens the show). A film's AniList entry is dropped only
// when its TMDb film is listed.
func (s *Service) collapseShows(ctx context.Context, titles []Title) []Title {
	out := make([]Title, 0, len(titles))
	at := map[string]int{}
	films := map[string]bool{}
	for _, title := range titles {
		if show, film := s.showOf(title); film && show == title.ID {
			films[show] = true
		}
	}
	for _, title := range titles {
		show, film := s.showOf(title)
		if show == "" || (film && show != title.ID && !films[show]) {
			out = append(out, title)
			continue
		}
		if position, ok := at[show]; ok {
			addAltTitles(&out[position], title)
			continue
		}
		if title.ID != show {
			title = s.entryAsShow(ctx, title, show)
		}
		if s.animeMap() != nil && (title.Anime || title.Type == TypeAnime) {
			// The show page, not an AniList entry page (without the anime
			// list, an AniList page is still the one that knows the show).
			title.ProviderIDs = maps.Clone(title.ProviderIDs)
			for _, namespace := range []string{"anilist", "jikan", "anizip", "kitsu"} {
				delete(title.ProviderIDs, namespace)
			}
			title.MergedFrom = append([]string{"tmdb"}, slices.DeleteFunc(slices.Clone(title.MergedFrom), func(name string) bool { return name == "tmdb" })...)
		}
		at[show] = len(out)
		out = append(out, title)
	}
	return out
}

// entryAsShow turns an AniList entry card into its show's card, named as the
// show when its name is known.
func (s *Service) entryAsShow(ctx context.Context, entry Title, show string) Title {
	card := entry
	card.ID = show
	card.Type = TypeAnime
	card.Anime = true
	card.Series = nil
	card.ProviderIDs = map[string]string{"tmdb": strings.TrimPrefix(show, "tmdb:")}
	if imdb := entry.ProviderIDs["imdb"]; imdb != "" {
		card.ProviderIDs["imdb"] = imdb
	}
	if link, ok := s.link(ctx, show); ok && link.Title != "" {
		card.AltTitles = append(card.AltTitles, entry.Title)
		card.Title = link.Title
		if link.Year > 0 {
			card.Year = link.Year
		}
	}
	return card
}

func addAltTitles(title *Title, other Title) {
	for _, name := range append([]string{other.Title, other.OriginalTitle}, other.AltTitles...) {
		if name != "" && name != title.Title && !slices.Contains(title.AltTitles, name) {
			title.AltTitles = append(title.AltTitles, name)
		}
	}
}
