package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"testing"
)

func TestAniZipPrefersAnilistThenMalKitsu(t *testing.T) {
	queries := []string{}
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		// Trimmed from the live api.ani.zip payload (2026-10): language-map
		// titles, string "episode" fields, specials under "S" keys, and
		// cross-links under "mappings".
		_, _ = w.Write([]byte(`{"titles":{"en":"Frieren: Beyond Journey's End","x-jat":"Sousou no Frieren"},
			"episodes":{
			"1":{"tvdbShowId":424536,"seasonNumber":1,"episodeNumber":1,"absoluteEpisodeNumber":1,"episode":"1","title":{"en":"The Journey's End","ja":"x"},"airDate":"2023-09-29","runtime":24,"image":"e1.png","overview":"start"},
			"2":{"seasonNumber":1,"episodeNumber":2,"episode":"2","title":{"x-jat":"Betsu ni Mahou ja Nakutatte..."},"airDate":"2023-10-06","length":24,"summary":"two"},
			"S1":{"episode":"S1","title":{"en":"Special"},"image":"s1.png"}
			},
			"mappings":{"anilist_id":154587,"mal_id":52991,"imdb_id":"tt22248376","themoviedb_id":"209867"}}`))
	})
	provider := NewAniZip(AniZipOptions{BaseURL: server.URL})

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{
		"anilist": "154587", "jikan": "52991", "kitsu": "k1"}})
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if detail.Title != "Frieren: Beyond Journey's End" || detail.IMDBID != "tt22248376" || detail.Type != TypeAnime {
		t.Fatalf("detail mapping wrong: %+v", detail)
	}
	if queries[0] != "anilist_id=154587" {
		t.Fatalf("anilist id must win: %v", queries)
	}

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"jikan": "52991"}, Season: 1})
	if err != nil || len(episodes) != 2 {
		t.Fatalf("episodes = %v, %v", episodes, err)
	}
	episodes = sortedForTest(episodes)
	if episodes[0].Episode != 1 || episodes[0].DurationS != 1440 || episodes[0].Still != "e1.png" || episodes[0].Title != "The Journey's End" {
		t.Fatalf("episode mapping wrong: %+v", episodes[0])
	}
	if episodes[1].Title != "Betsu ni Mahou ja Nakutatte..." || episodes[1].Overview != "two" || episodes[1].DurationS != 1440 {
		t.Fatalf("fallback fields wrong: %+v", episodes[1])
	}

	// Map iteration order must not leak into observable order once sorted:
	// repeated calls yield identical sorted episode sequences.
	var baseline string
	for iteration := 0; iteration < 20; iteration++ {
		repeat, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"anilist": "154587"}, Season: 1})
		if err != nil {
			t.Fatalf("repeat episodes: %v", err)
		}
		serialized, _ := json.Marshal(sortedForTest(repeat))
		if baseline == "" {
			baseline = string(serialized)
			continue
		}
		if string(serialized) != baseline {
			t.Fatal("episode order not deterministic after sorting")
		}
	}
}

func sortedForTest(episodes []Episode) []Episode {
	sorted := append([]Episode(nil), episodes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	return sorted
}

func TestAniZipNoMatchingID(t *testing.T) {
	server := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("no provider request expected")
	})
	provider := NewAniZip(AniZipOptions{BaseURL: server.URL})
	if _, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": "1"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no usable id = %v", err)
	}
}
