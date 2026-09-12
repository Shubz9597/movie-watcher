package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAniListSearchAndDetailMapping(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("anilist requires POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.Unmarshal(body, &payload)
		response := `{"data":{"Page":{"media":[
			{"id":154587,"idMal":52991,"title":{"english":"Frieren","romaji":"Sousou no Frieren","native":"葬送のフリーレン"},"startDate":{"year":2023,"month":9,"day":29},"description":"<br>Journey.","averageScore":89,"popularity":250000,"countryOfOrigin":"JP","genres":["Adventure"],"coverImage":{"extraLarge":"xl.png","large":"large.png"},"bannerImage":"banner.png","externalLinks":[{"site":"Official Site","url":"https://frieren.example"}],"episodes":28,"duration":24}
		]}}}`
		if strings.Contains(payload.Query, "Media(id:") {
			response = `{"data":{"Media":{"id":154587,"idMal":52991,"title":{"english":"Frieren"},"startDate":{"year":2023},"description":"","averageScore":89,"countryOfOrigin":"JP","genres":[],"coverImage":{"large":"large.png"},"externalLinks":[],"episodes":28,"duration":24}}}`
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(response))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})

	titles, err := provider.Search(context.Background(), SearchQuery{Query: "frieren"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(titles) != 1 {
		t.Fatalf("titles = %d", len(titles))
	}
	title := titles[0]
	if title.ID != "anilist:154587" || title.Type != TypeAnime || title.Title != "Frieren" {
		t.Fatalf("mapping wrong: %+v", title)
	}
	if title.OriginalTitle != "葬送のフリーレン" || title.Year != 2023 || title.Overview != "Journey." {
		t.Fatalf("fields wrong: %+v", title)
	}
	if title.Artwork["poster"] != "large.png" || title.Artwork["background"] != "banner.png" {
		t.Fatalf("artwork wrong: %v", title.Artwork)
	}
	if title.ProviderIDs["jikan"] != "52991" {
		t.Fatalf("MAL cross-link missing: %v", title.ProviderIDs)
	}
	if title.ExternalLinks["Official Site"] != "https://frieren.example" {
		t.Fatalf("external links wrong: %v", title.ExternalLinks)
	}

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"anilist": "154587"}})
	if err != nil || detail.ID != "anilist:154587" {
		t.Fatalf("detail = %+v err=%v", detail, err)
	}
	if _, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "1"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown namespace = %v", err)
	}
}

func TestAniListGraphQLErrorFailsSearch(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"errors":[{"message":"Too Many Requests"}]}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: "x"}); err == nil {
		t.Fatal("GraphQL errors must surface as provider errors (degradation path)")
	}
}

func TestAniListSectionKinds(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"Page":{"media":[{"id":1,"title":{"english":"A"},"startDate":{},"description":"","countryOfOrigin":"JP","genres":[],"coverImage":{},"externalLinks":[],"episodes":0,"duration":0}]}}}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})
	for _, kind := range []string{"trending", "popular"} {
		titles, err := provider.Section(context.Background(), kind)
		if err != nil || len(titles) != 1 {
			t.Fatalf("section %q = %v, %v", kind, titles, err)
		}
	}
	if _, err := provider.Section(context.Background(), "nonsense"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown kind = %v", err)
	}
}

func TestAniListDetailSurfacesSingleSeasonEpisodeCount(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"Media":{"id":154587,"idMal":52991,"title":{"english":"Frieren"},"startDate":{"year":2023},"description":"","countryOfOrigin":"JP","genres":[],"coverImage":{},"externalLinks":[],"format":"TV","episodes":28,"duration":24}}}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"anilist": "154587"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Seasons) != 1 || detail.Seasons[0].Number != 1 || detail.Seasons[0].EpisodeCount != 28 {
		t.Fatalf("seasons = %+v, want one season with 28 episodes", detail.Seasons)
	}
}

func TestAniListDetailMovieFormatKeepsNoSeasons(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"Media":{"id":1,"title":{"english":"Anime Movie"},"startDate":{},"description":"","countryOfOrigin":"JP","genres":[],"coverImage":{},"externalLinks":[],"format":"MOVIE","episodes":1,"duration":90}}}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"anilist": "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if detail.Seasons != nil {
		t.Fatalf("movie format must not fabricate seasons: %+v", detail.Seasons)
	}
}

func TestAniListSectionPageRequestsRequestedPage(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"page":3`) {
			t.Fatalf("variables missing page 3: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"Page":{"media":[{"id":9,"title":{"english":"Page Three"},"startDate":{},"description":"","countryOfOrigin":"JP","genres":[],"coverImage":{},"externalLinks":[],"episodes":0,"duration":0}]}}}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})

	titles, totalPages, err := provider.SectionPage(context.Background(), "trending", 3)
	if err != nil {
		t.Fatal(err)
	}
	// AniList paging exposes no total page count: 0 means unknown.
	if totalPages != 0 || len(titles) != 1 || titles[0].ID != "anilist:9" {
		t.Fatalf("paged section = %d pages, %+v", totalPages, titles)
	}
}

func TestAniListNamedGenreSectionUsesGenreVariable(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(payload.Query, "genre_in: $genres") || !strings.Contains(payload.Query, "isAdult: false") {
			t.Fatalf("genre query missing provider filters: %s", payload.Query)
		}
		genres, ok := payload.Variables["genres"].([]any)
		if !ok || len(genres) != 1 || genres[0] != "Slice of Life" || payload.Variables["page"] != float64(2) {
			t.Fatalf("genre variables = %#v", payload.Variables)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"Page":{"pageInfo":{"lastPage":7},"media":[{"id":10,"title":{"english":"Genre Match"},"startDate":{},"description":"","countryOfOrigin":"JP","genres":["Slice of Life"],"coverImage":{},"externalLinks":[],"episodes":0,"duration":0}]}}}`))
	})
	provider := NewAniList(AniListOptions{BaseURL: server.URL})

	titles, totalPages, err := provider.NamedGenreSection(context.Background(), "Slice of Life", 2)
	if err != nil {
		t.Fatal(err)
	}
	if totalPages != 7 || len(titles) != 1 || titles[0].ID != "anilist:10" {
		t.Fatalf("genre section = %d pages, %+v", totalPages, titles)
	}
}
