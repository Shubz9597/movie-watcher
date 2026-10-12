package catalog

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"torrent-streamer/migrations"
)

// Death Note as TMDb and Cinemeta describe it. TMDb resolves the IMDb id;
// Cinemeta answers only by IMDb id.
func linkTestProviders(tmdbDown *bool) []Provider {
	tmdb := &fakeProvider{name: "tmdb",
		detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
			if *tmdbDown {
				return Title{}, errors.New("provider request failed: connection reset by peer")
			}
			if request.ProviderIDs["tmdb"] != "tv:13916" {
				return Title{}, ErrNotFound
			}
			return Title{ID: "tmdb:tv:13916", Type: TypeAnime, Format: "tv", Title: "Death Note",
				ProviderIDs: map[string]string{"tmdb": "tv:13916", "imdb": "tt0877057"}, IMDBID: "tt0877057", MergedFrom: []string{"tmdb"},
				Seasons: []Season{{Number: 1, Name: "Season 1", EpisodeCount: 37}}}, nil
		},
		episodeFn: func(_ context.Context, request EpisodeRequest) ([]Episode, error) {
			if *tmdbDown {
				return nil, errors.New("provider request failed: connection reset by peer")
			}
			return []Episode{{ID: "tmdb:tv:13916:1:1", Season: 1, Episode: 1, Title: "Rebirth"}}, nil
		},
	}
	cinemeta := &fakeProvider{name: "cinemeta",
		detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
			if request.ProviderIDs["imdb"] != "tt0877057" {
				return Title{}, ErrNotFound
			}
			return Title{ID: "imdb:tt0877057", Type: TypeSeries, Title: "Death Note",
				ProviderIDs: map[string]string{"imdb": "tt0877057"}, IMDBID: "tt0877057", MergedFrom: []string{"cinemeta"},
				Seasons: []Season{{Number: 1, Name: "Season 1", EpisodeCount: 37}}}, nil
		},
		episodeFn: func(_ context.Context, request EpisodeRequest) ([]Episode, error) {
			if request.ProviderIDs["imdb"] != "tt0877057" {
				return nil, ErrNotFound
			}
			return []Episode{{ID: "imdb:tt0877057:1:1", Season: 1, Episode: 1, Title: "Rebirth"}}, nil
		},
	}
	return []Provider{tmdb, cinemeta}
}

func TestTitleResolvesThroughCinemetaWhenTMDbIsDown(t *testing.T) {
	links := &MemoryIDLinks{}
	down := false
	first := NewService(linkTestProviders(&down), Options{Links: links})
	defer first.Close()
	if result := first.Detail(context.Background(), "tmdb:tv:13916"); !result.Found {
		t.Fatalf("first load: %+v", result)
	}

	// A restarted server (empty caches) while TMDb resets every connection.
	down = true
	second := NewService(linkTestProviders(&down), Options{Links: links})
	defer second.Close()
	result := second.Detail(context.Background(), "tmdb:tv:13916")
	if !result.Found {
		t.Fatalf("with TMDb down the remembered IMDb link must let Cinemeta answer: %+v", result)
	}
	got := result.Title
	if got.ID != "tmdb:tv:13916" || got.Type != TypeAnime || got.Format != "tv" || got.ProviderIDs["tmdb"] != "tv:13916" || len(got.Seasons) != 1 {
		t.Fatalf("the app must see the same title (id, type, format, tmdb id, seasons): %+v", got)
	}
	episodes := second.Episodes(context.Background(), "tmdb:tv:13916", 1)
	if len(episodes.Episodes) != 1 || episodes.Episodes[0].Title != "Rebirth" {
		t.Fatalf("episodes must come from Cinemeta when TMDb is down: %+v", episodes)
	}
}

func TestTitleWithoutLinkStillReportsTMDbOutage(t *testing.T) {
	down := true
	service := NewService(linkTestProviders(&down), Options{Links: &MemoryIDLinks{}})
	defer service.Close()
	result := service.Detail(context.Background(), "tmdb:tv:13916")
	if result.Found || len(result.DegradedProviders) == 0 {
		t.Fatalf("an unknown title cannot be resolved without TMDb: %+v", result)
	}
}

func TestSQLIDLinksRoundTrip(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	store := &SQLIDLinks{DB: db}
	link := IDLink{ProviderIDs: map[string]string{"tmdb": "tv:13916", "imdb": "tt0877057"}, Type: TypeAnime, Format: "tv"}
	store.PutLink(ctx, "tmdb:tv:13916", link)
	fresh := &SQLIDLinks{DB: db} // a restarted server reads from the table
	got, ok := fresh.GetLink(ctx, "tmdb:tv:13916")
	if !ok || got.ProviderIDs["imdb"] != "tt0877057" || got.Type != TypeAnime || got.Format != "tv" {
		t.Fatalf("link = %+v, %v", got, ok)
	}
	if _, ok := fresh.GetLink(ctx, "tmdb:tv:0"); ok {
		t.Fatal("unknown ids have no link")
	}
}
