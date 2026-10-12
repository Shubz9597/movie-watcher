package catalog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Cinemeta answers every season request with the whole show; Specials (season
// 0) showed every regular episode of The Wire after TMDb's specials.
func TestSeasonListsHoldOnlyThatSeason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"meta":{"id":"tt0306414","type":"series","name":"The Wire","videos":[
			{"season":1,"episode":1,"name":"The Target","released":"2002-06-02T00:00:00.000Z"},
			{"season":1,"episode":2,"name":"The Detail","released":"2002-06-09T00:00:00.000Z"},
			{"season":5,"episode":1,"name":"More With Less","released":"2008-01-06T00:00:00.000Z"}]}}`))
	}))
	defer server.Close()
	tmdb := &fakeProvider{name: "tmdb",
		detailFn: func(context.Context, DetailRequest) (Title, error) {
			return Title{ID: "tmdb:tv:1438", Title: "The Wire", ProviderIDs: map[string]string{"tmdb": "tv:1438", "imdb": "tt0306414"}}, nil
		},
		episodeFn: func(_ context.Context, request EpisodeRequest) ([]Episode, error) {
			if request.Season != 0 {
				return nil, ErrNotFound
			}
			return []Episode{
				{ID: "tmdb:tv:1438:0:1", Season: 0, Episode: 1, Title: "It's All Connected"},
				{ID: "tmdb:tv:1438:0:2", Season: 0, Episode: 2, Title: "When Bunk Met McNulty"},
			}, nil
		},
	}
	service := NewService([]Provider{tmdb, NewCinemeta(CinemetaOptions{BaseURL: server.URL, HTTP: server.Client()})}, Options{})
	defer service.Close()

	for season, want := range map[int][]string{0: {"It's All Connected", "When Bunk Met McNulty"}, 1: {"The Target", "The Detail"}, 5: {"More With Less"}} {
		result := service.Episodes(context.Background(), "tmdb:tv:1438", season)
		var titles []string
		for _, episode := range result.Episodes {
			if episode.Season != season {
				t.Fatalf("season %d holds %+v", season, episode)
			}
			titles = append(titles, episode.Title)
		}
		if len(titles) != len(want) || titles[0] != want[0] {
			t.Fatalf("season %d = %v, want %v", season, titles, want)
		}
	}
}

// An AniList arc opens as its season of the grouped TMDb show (Demon Slayer
// Mugen Train Arc is season 2 of tmdb:tv:85937), and only when TMDb agrees.
func TestAnimeArcPointsToItsSeasonOfTheShow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Trimmed from the live api.ani.zip payload for AniList 129874.
		_, _ = w.Write([]byte(`{"titles":{"en":"Demon Slayer: Kimetsu no Yaiba Mugen Train Arc"},
			"episodes":{"1":{"seasonNumber":2,"episodeNumber":1,"absoluteEpisodeNumber":27},
				"2":{"seasonNumber":2,"episodeNumber":2,"absoluteEpisodeNumber":28},
				"S1":{"seasonNumber":0,"episodeNumber":1}},
			"mappings":{"anilist_id":129874,"type":"TV","imdb_id":"tt9335498","themoviedb_id":"85937"}}`))
	}))
	defer server.Close()

	for _, test := range []struct {
		name    string
		seasons []Season
		tmdbErr error
		want    *SeriesLink
	}{
		{name: "season confirmed", seasons: []Season{{Number: 1, EpisodeCount: 26}, {Number: 2, EpisodeCount: 7}}, want: &SeriesLink{ID: "tmdb:tv:85937", Season: 2, episodes: 2}},
		{name: "TMDb season too short", seasons: []Season{{Number: 1, EpisodeCount: 26}, {Number: 2, EpisodeCount: 1}}},
		{name: "TMDb has no such season", seasons: []Season{{Number: 1, EpisodeCount: 26}}},
		{name: "TMDb down", tmdbErr: errors.New("provider request failed: connection reset by peer")},
	} {
		t.Run(test.name, func(t *testing.T) {
			tmdb := &fakeProvider{name: "tmdb", detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
				if request.ProviderIDs["tmdb"] != "tv:85937" {
					return Title{}, ErrNotFound
				}
				if test.tmdbErr != nil {
					return Title{}, test.tmdbErr
				}
				return Title{ID: "tmdb:tv:85937", ProviderIDs: map[string]string{"tmdb": "tv:85937"}, Seasons: test.seasons}, nil
			}}
			anilist := &fakeProvider{name: "anilist", detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
				if request.ProviderIDs["anilist"] != "129874" {
					return Title{}, ErrNotFound
				}
				return Title{ID: "anilist:129874", Type: TypeAnime, Title: "Mugen Train Arc", ProviderIDs: map[string]string{"anilist": "129874"}}, nil
			}}
			service := NewService([]Provider{tmdb, anilist, NewAniZip(AniZipOptions{BaseURL: server.URL, HTTP: server.Client()})}, Options{})
			defer service.Close()

			result := service.Detail(context.Background(), "anilist:129874")
			if result.Title.ID != "anilist:129874" {
				t.Fatalf("id = %q", result.Title.ID)
			}
			got := result.Title.Series
			if (got == nil) != (test.want == nil) || (got != nil && *got != *test.want) {
				t.Fatalf("series = %+v, want %+v", got, test.want)
			}
		})
	}
}

// The grouped show itself never points anywhere.
func TestTMDbShowHasNoSeriesLink(t *testing.T) {
	link := &SeriesLink{ID: "tmdb:tv:85937", Season: 1, episodes: 1}
	service := NewService(nil, Options{})
	defer service.Close()
	if got := service.confirmSeries(context.Background(), "tmdb", link); got != nil {
		t.Fatalf("series = %+v", got)
	}
}
