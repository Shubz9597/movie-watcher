package catalog

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// AniList catalog provider (public GraphQL API; no credentials).
type AniList struct {
	base string
	http *http.Client
}

type AniListOptions struct {
	BaseURL string // default https://graphql.anilist.co
	HTTP    *http.Client
}

func NewAniList(options AniListOptions) *AniList {
	base := options.BaseURL
	if base == "" {
		base = "https://graphql.anilist.co"
	}
	return &AniList{base: strings.TrimRight(base, "/"), http: options.HTTP}
}

func (p *AniList) Name() string { return "anilist" }

const aniListMediaFields = `
fragment media on Media {
  id
  idMal
  title { english romaji native userPreferred }
  startDate { year month day }
  description(asHtml: false)
  averageScore
  popularity
  countryOfOrigin
  format
  genres
  coverImage { extraLarge large medium }
  bannerImage
  externalLinks { site url }
  episodes
  duration
}
`

type aniListPage struct {
	Data struct {
		Page struct {
			PageInfo struct {
				LastPage int `json:"lastPage"`
			} `json:"pageInfo"`
			Media []aniListMedia `json:"media"`
		} `json:"page"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type aniListMedia struct {
	ID    int64 `json:"id"`
	IDMal int64 `json:"idMal"`
	Title struct {
		English       string `json:"english"`
		Romaji        string `json:"romaji"`
		Native        string `json:"native"`
		UserPreferred string `json:"userPreferred"`
	} `json:"title"`
	StartDate struct {
		Year  int `json:"year"`
		Month int `json:"month"`
		Day   int `json:"day"`
	} `json:"startDate"`
	Description     string   `json:"description"`
	AverageScore    int      `json:"averageScore"`
	Popularity      int      `json:"popularity"`
	CountryOfOrigin string   `json:"countryOfOrigin"`
	Genres          []string `json:"genres"`
	CoverImage      struct {
		ExtraLarge string `json:"extraLarge"`
		Large      string `json:"large"`
		Medium     string `json:"medium"`
	} `json:"coverImage"`
	BannerImage   string `json:"bannerImage"`
	ExternalLinks []struct {
		Site string `json:"site"`
		URL  string `json:"url"`
	} `json:"externalLinks"`
	Format   string `json:"format"`
	Episodes int    `json:"episodes"`
	Duration int    `json:"duration"`
}

func (p *AniList) query(ctx context.Context, query string, variables map[string]any) (aniListPage, error) {
	var payload aniListPage
	err := postJSON(ctx, p.http, p.base, map[string]any{"query": query, "variables": variables}, &payload)
	if err != nil {
		return aniListPage{}, err
	}
	if len(payload.Errors) > 0 {
		return aniListPage{}, fmt.Errorf("anilist query failed: %s", payload.Errors[0].Message)
	}
	return payload, nil
}

func (p *AniList) Search(ctx context.Context, query SearchQuery) ([]Title, error) {
	perPage := query.Limit
	if perPage <= 0 {
		perPage = 24
	}
	payload, err := p.query(ctx, "query ($q: String, $perPage: Int) { Page(page: 1, perPage: $perPage) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ...media } } } "+aniListMediaFields,
		map[string]any{"q": query.Query, "perPage": perPage})
	if err != nil {
		return nil, err
	}
	titles := make([]Title, 0, len(payload.Data.Page.Media))
	for _, media := range payload.Data.Page.Media {
		titles = append(titles, p.toTitle(media))
	}
	return titles, nil
}

func (p *AniList) Detail(ctx context.Context, request DetailRequest) (Title, error) {
	externalID := request.ProviderIDs["anilist"]
	if externalID == "" {
		return Title{}, ErrNotFound
	}
	id, err := strconv.ParseInt(externalID, 10, 64)
	if err != nil {
		return Title{}, ErrNotFound
	}
	var payload struct {
		Data struct {
			Media aniListMedia `json:"Media"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	err = postJSON(ctx, p.http, p.base, map[string]any{
		"query":     "query ($id: Int) { Media(id: $id, type: ANIME) { ...media } } " + aniListMediaFields,
		"variables": map[string]any{"id": id},
	}, &payload)
	if err != nil {
		if err == ErrNotFound {
			return Title{}, ErrNotFound
		}
		return Title{}, err
	}
	if len(payload.Errors) > 0 {
		return Title{}, fmt.Errorf("anilist query failed: %s", payload.Errors[0].Message)
	}
	if payload.Data.Media.ID == 0 {
		return Title{}, ErrNotFound
	}
	return p.toTitle(payload.Data.Media), nil
}

func (p *AniList) Section(ctx context.Context, kind string) ([]Title, error) {
	titles, _, err := p.SectionPage(ctx, kind, 1)
	return titles, err
}

// SectionPage implements PageableSectionProvider (T042.1): anime trending/
// popular sections beyond page 1. AniList paging is page/perPage based, so
// no total page count is available; the service treats 0 as unknown.
func (p *AniList) SectionPage(ctx context.Context, kind string, page int) ([]Title, int, error) {
	sort := ""
	switch kind {
	case "trending":
		sort = "TRENDING_DESC"
	case "popular":
		sort = "POPULARITY_DESC"
	default:
		return nil, 0, ErrNotFound
	}
	payload, err := p.query(ctx, "query ($sort: [MediaSort], $perPage: Int, $page: Int) { Page(page: $page, perPage: $perPage) { media(type: ANIME, sort: $sort) { ...media } } } "+aniListMediaFields,
		map[string]any{"sort": []string{sort}, "perPage": 20, "page": page})
	if err != nil {
		return nil, 0, err
	}
	titles := make([]Title, 0, len(payload.Data.Page.Media))
	for _, media := range payload.Data.Page.Media {
		titles = append(titles, p.toTitle(media))
	}
	return titles, 0, nil
}

// NamedGenreSection implements NamedGenreSectionProvider using AniList's
// genre_in GraphQL filter. Genres are passed as variables, never interpolated
// into the query document.
func (p *AniList) NamedGenreSection(ctx context.Context, genre string, page int) ([]Title, int, error) {
	payload, err := p.query(ctx, "query ($genres: [String], $perPage: Int, $page: Int) { Page(page: $page, perPage: $perPage) { pageInfo { lastPage } media(type: ANIME, genre_in: $genres, isAdult: false, sort: [POPULARITY_DESC, SCORE_DESC]) { ...media } } } "+aniListMediaFields,
		map[string]any{"genres": []string{genre}, "perPage": 20, "page": page})
	if err != nil {
		return nil, 0, err
	}
	titles := make([]Title, 0, len(payload.Data.Page.Media))
	for _, media := range payload.Data.Page.Media {
		titles = append(titles, p.toTitle(media))
	}
	return titles, payload.Data.Page.PageInfo.LastPage, nil
}

// SeedSimilar returns AniList's own "recommendations" for one anime — the
// per-seed personalization candidates for anilist: seeds (TMDb cannot
// resolve those ids). Recommendations are AniList's community-ranked
// next-watch titles for this media, mapped onto the shared Title shape.
func (p *AniList) SeedSimilar(ctx context.Context, canonicalID string, limit int) ([]Title, error) {
	const prefix = "anilist:"
	if !strings.HasPrefix(canonicalID, prefix) {
		return nil, ErrNotFound
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(canonicalID, prefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, ErrNotFound
	}
	var payload struct {
		Data struct {
			Media struct {
				Recommendations struct {
					Nodes []struct {
						MediaRecommendation *aniListMedia `json:"mediaRecommendation"`
					} `json:"nodes"`
				} `json:"recommendations"`
			} `json:"Media"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	err = postJSON(ctx, p.http, p.base, map[string]any{
		"query": "query ($id: Int) { Media(id: $id, type: ANIME) { recommendations(perPage: 12, sort: RATING_DESC) { nodes { mediaRecommendation { ...media } } } } } " + aniListMediaFields,
		"variables": map[string]any{"id": id},
	}, &payload)
	if err != nil {
		return nil, err
	}
	if len(payload.Errors) > 0 {
		return nil, fmt.Errorf("anilist query failed: %s", payload.Errors[0].Message)
	}
	titles := make([]Title, 0, limit)
	for _, node := range payload.Data.Media.Recommendations.Nodes {
		if node.MediaRecommendation == nil {
			continue
		}
		titles = append(titles, p.toTitle(*node.MediaRecommendation))
		if len(titles) >= limit {
			break
		}
	}
	return titles, nil
}

func (p *AniList) toTitle(media aniListMedia) Title {
	title := media.Title.English
	if title == "" {
		title = media.Title.UserPreferred
	}
	if title == "" {
		title = media.Title.Romaji
	}
	if title == "" {
		title = media.Title.Native
	}
	artwork := map[string]string{}
	if media.CoverImage.Large != "" {
		artwork["poster"] = media.CoverImage.Large
	} else if media.CoverImage.ExtraLarge != "" {
		artwork["poster"] = media.CoverImage.ExtraLarge
	}
	if media.BannerImage != "" {
		artwork["background"] = media.BannerImage
	} else if media.CoverImage.ExtraLarge != "" {
		artwork["background"] = media.CoverImage.ExtraLarge
	}
	providerIDs := map[string]string{"anilist": strconv.FormatInt(media.ID, 10)}
	if media.IDMal > 0 {
		providerIDs["jikan"] = strconv.FormatInt(media.IDMal, 10)
	}
	externalLinks := map[string]string{}
	for _, link := range media.ExternalLinks {
		if link.Site != "" && link.URL != "" {
			externalLinks[link.Site] = link.URL
		}
	}
	result := Title{
		ID:            "anilist:" + strconv.FormatInt(media.ID, 10),
		Type:          TypeAnime,
		Title:         title,
		OriginalTitle: media.Title.Native,
		Year:          media.StartDate.Year,
		Overview:      stripHTML(media.Description),
		Artwork:       artwork,
		ProviderIDs:   providerIDs,
		MergedFrom:    []string{"anilist"},
		Runtime:       media.Duration,
		Genres:        media.Genres,
		ExternalLinks: externalLinks,
	}
	// Anime surfaces a single season with the known episode count so clients
	// can render episode skeletons without extra provider calls (T042.1).
	// Movie-format entries keep no season list.
	if media.Format != "MOVIE" && media.Episodes > 0 {
		result.Seasons = []Season{{Number: 1, Name: "Season 1", EpisodeCount: media.Episodes}}
	}
	return result
}

// stripHTML mirrors the renderer's cleanAnimeDescription: drop tags and
// entities, collapse whitespace.
func stripHTML(description string) string {
	if description == "" {
		return ""
	}
	var out strings.Builder
	for i := 0; i < len(description); i++ {
		switch {
		case description[i] == '<':
			for i < len(description) && description[i] != '>' {
				i++
			}
		case description[i] == '&' && strings.IndexByte(description[i:], ';') >= 0 && strings.IndexByte(description[i:], ';') < 12:
			end := i + strings.IndexByte(description[i:], ';')
			out.WriteByte(' ')
			i = end
		default:
			out.WriteByte(description[i])
		}
	}
	return strings.TrimSpace(out.String())
}
