package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"torrent-streamer/internal/animemap"
)

// Recorded live: Dragon Ball Z Kai on Cinemeta (Specials 9, season 1 98,
// season 2 61), ani.zip's two AniList entries (6033: TVDB season 1, 20635:
// season 2) and the community anime list. TMDb splits the same show into
// six broadcast seasons.
func kaiService(t *testing.T, layouts LayoutStore) (*Service, *httptest.Server) {
	t.Helper()
	read := func(name string) []byte {
		data, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	cinemeta, anizip6033, anizip20635 := read("cinemeta_dbz_kai.json"), read("anizip_6033.json"), read("anizip_20635.json")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/meta/series/tt1409055.json":
			_, _ = w.Write(cinemeta)
		case r.URL.Path == "/mappings" && r.URL.Query().Get("anilist_id") == "6033":
			_, _ = w.Write(anizip6033)
		case r.URL.Path == "/mappings" && r.URL.Query().Get("anilist_id") == "20635":
			_, _ = w.Write(anizip20635)
		default:
			http.NotFound(w, r)
		}
	}))
	list, err := animemap.Parse(read("anime_list_sample.json"))
	if err != nil {
		t.Fatal(err)
	}
	tmdb := &fakeProvider{name: "tmdb", detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
		if request.ProviderIDs["tmdb"] != "tv:61709" {
			return Title{}, ErrNotFound
		}
		var seasons []Season
		for number, count := range []int{9, 26, 26, 25, 20, 35, 26} {
			seasons = append(seasons, Season{Number: number, EpisodeCount: count, Poster: "tmdb-poster"})
		}
		return Title{ID: "tmdb:tv:61709", Type: TypeSeries, Title: "Dragon Ball Z Kai", IMDBID: "tt1409055",
			ProviderIDs: map[string]string{"tmdb": "tv:61709", "imdb": "tt1409055"}, Seasons: seasons}, nil
	}}
	anilist := &fakeProvider{name: "anilist", detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
		if request.ProviderIDs["anilist"] == "" {
			return Title{}, ErrNotFound
		}
		return Title{ID: "anilist:" + request.ProviderIDs["anilist"], Type: TypeAnime, Title: "Dragon Ball Z Kai",
			ProviderIDs: map[string]string{"anilist": request.ProviderIDs["anilist"]}, Seasons: []Season{{Number: 1, EpisodeCount: 97}}}, nil
	}}
	providers := []Provider{tmdb, anilist,
		NewCinemeta(CinemetaOptions{BaseURL: server.URL, HTTP: server.Client()}),
		NewAniZip(AniZipOptions{BaseURL: server.URL, HTTP: server.Client()})}
	service := NewService(providers, Options{Links: &MemoryIDLinks{}, Layouts: layouts, AnimeMap: func() *animemap.Map { return list }})
	t.Cleanup(service.Close)
	return service, server
}

func TestShowSeasonsAreStremios(t *testing.T) {
	service, server := kaiService(t, &MemoryLayouts{})
	defer server.Close()
	ctx := context.Background()

	detail := service.Detail(ctx, "tmdb:tv:61709")
	if !detail.Found || !detail.Title.Anime {
		t.Fatalf("detail: %+v", detail)
	}
	var got []string
	for _, season := range detail.Title.Seasons {
		got = append(got, season.Name+"="+strconv.Itoa(season.EpisodeCount))
	}
	if strings.Join(got, ",") != "Specials=9,Season 1=98,Season 2=61" {
		t.Fatalf("seasons = %v, want Stremio's Specials 9, Season 1 98, Season 2 61", got)
	}
	if detail.Title.Seasons[0].Poster != "tmdb-poster" || detail.Title.Seasons[1].Poster != "" {
		t.Fatal("TMDb's poster only for a season TMDb numbers alike (Specials, 9 each)")
	}

	finals := service.Episodes(ctx, "tmdb:tv:61709", 2)
	if len(finals.Episodes) != 61 {
		t.Fatalf("season 2: %d episodes", len(finals.Episodes))
	}
	first := finals.Episodes[0]
	if first.Episode != 1 || first.Absolute != 99 || !strings.HasPrefix(first.Title, "Seven Years Later") || first.ID != "tmdb:tv:61709:2:1" {
		t.Fatalf("season 2 opens with the Buu saga: %+v", first)
	}
	if !strings.Contains(first.Still, "thetvdb.com") {
		t.Fatalf("anime stills come from ani.zip: %q", first.Still)
	}
	one := service.Episodes(ctx, "tmdb:tv:61709", 1)
	if len(one.Episodes) != 98 || one.Episodes[35].Episode != 36 || !strings.Contains(one.Episodes[35].Still, "thetvdb.com") {
		t.Fatalf("season 1: %d episodes", len(one.Episodes))
	}
	for _, episode := range one.Episodes {
		if episode.Season != 1 {
			t.Fatalf("season 1 lists %+v", episode)
		}
	}
}

func TestAniListEntriesOpenAsSeasonsOfTheShow(t *testing.T) {
	service, server := kaiService(t, &MemoryLayouts{})
	defer server.Close()
	for id, season := range map[string]int{"anilist:6033": 1, "anilist:20635": 2} {
		detail := service.Detail(context.Background(), id)
		if !detail.Found || detail.Title.Series == nil || detail.Title.Series.ID != "tmdb:tv:61709" || detail.Title.Series.Season != season || detail.Title.Series.EpisodeOffset != 0 {
			t.Fatalf("%s: series %+v", id, detail.Title.Series)
		}
	}
}

func TestShowKeepsItsSeasonsWhileCinemetaIsDown(t *testing.T) {
	layouts := &MemoryLayouts{}
	service, server := kaiService(t, layouts)
	if detail := service.Detail(context.Background(), "tmdb:tv:61709"); len(detail.Title.Seasons) != 3 {
		t.Fatalf("first answer: %+v", detail.Title.Seasons)
	}
	server.Close() // Cinemeta (and ani.zip) unreachable from now on

	// A restarted server: nothing in memory, only the saved layout.
	restarted := NewService(service.providers, Options{Links: &MemoryIDLinks{}, Layouts: layouts, AnimeMap: service.options.AnimeMap})
	defer restarted.Close()
	detail := restarted.Detail(context.Background(), "tmdb:tv:61709")
	if len(detail.Title.Seasons) != 3 || detail.Title.Seasons[2].EpisodeCount != 61 {
		t.Fatalf("saved layout not used: %+v", detail.Title.Seasons)
	}
	if episodes := restarted.Episodes(context.Background(), "tmdb:tv:61709", 2); len(episodes.Episodes) != 61 {
		t.Fatalf("saved layout episodes: %d", len(episodes.Episodes))
	}
}

// Searching Dragon Ball Z Kai lists the show once (Stremio's order first),
// not TMDb's show plus AniList's two seasons; the card opens the show.
func TestSearchListsTheShowOnce(t *testing.T) {
	service, server := kaiService(t, &MemoryLayouts{})
	defer server.Close()
	anilist := service.providers[1].(*fakeProvider)
	anilist.searchFn = func(context.Context, SearchQuery) ([]Title, error) {
		return []Title{
			{ID: "anilist:6033", Type: TypeAnime, Title: "Dragon Ball Z Kai", Year: 2009, ProviderIDs: map[string]string{"anilist": "6033"}, MergedFrom: []string{"anilist"}},
			{ID: "anilist:20635", Type: TypeAnime, Title: "Dragon Ball Z Kai: The Final Chapters", Year: 2014, ProviderIDs: map[string]string{"anilist": "20635"}, MergedFrom: []string{"anilist"}},
		}, nil
	}
	tmdb := service.providers[0].(*fakeProvider)
	tmdb.searchFn = func(context.Context, SearchQuery) ([]Title, error) {
		return []Title{{ID: "tmdb:tv:61709", Type: TypeAnime, Title: "Dragon Ball Z Kai", Year: 2009,
			ProviderIDs: map[string]string{"tmdb": "tv:61709"}, MergedFrom: []string{"tmdb"}}}, nil
	}
	result := service.Search(context.Background(), SearchQuery{Query: "dragon ball z kai"})
	var ids []string
	for _, title := range result.Titles {
		ids = append(ids, title.ID)
	}
	if len(result.Titles) != 1 || result.Titles[0].ID != "tmdb:tv:61709" || result.Titles[0].ProviderIDs["anilist"] != "" || result.Titles[0].MergedFrom[0] != "tmdb" {
		t.Fatalf("results = %v %+v", ids, result.Titles)
	}
	if !slices.Contains(result.Titles[0].AltTitles, "Dragon Ball Z Kai: The Final Chapters") {
		t.Fatalf("the season's name stays searchable: %v", result.Titles[0].AltTitles)
	}
}

// Stremio's hits lead in Stremio's order; other results follow as ranked.
func TestStremioOrderLeads(t *testing.T) {
	titles := []Title{{ID: "tmdb:movie:95993"}, {ID: "tmdb:tv:85937"}, {ID: "anilist:1"}, {ID: "tmdb:movie:635302"}}
	got := stremioFirst(titles, []string{"tmdb:tv:85937", "tmdb:movie:635302"})
	var ids []string
	for _, title := range got {
		ids = append(ids, title.ID)
	}
	if strings.Join(ids, ",") != "tmdb:tv:85937,tmdb:movie:635302,tmdb:movie:95993,anilist:1" {
		t.Fatalf("order = %v", ids)
	}
}
