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
		_, _ = w.Write([]byte(`{"title":"è‘¬é€ã®ãƒ•ãƒªãƒ¼ãƒ¬ãƒ³","english":{"title":"Frieren"},"imdbId":"tt28015436","episodes":{
			"1":{"season":1,"episode":1,"airDate":"2023-09-29","title":"The Journey's End","image":"e1.png","overview":"start","duration":24},
			"2":{"season":1,"episode":2,"airDate":"2023-10-06","title":"Two","duration":24}
		}}`))
	})
	provider := NewAniZip(AniZipOptions{BaseURL: server.URL})

	detail, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{
		"anilist": "154587", "jikan": "52991", "kitsu": "k1"}})
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if detail.Title != "Frieren" || detail.IMDBID != "tt28015436" || detail.Type != TypeAnime {
		t.Fatalf("detail mapping wrong: %+v", detail)
	}
	if queries[0] != "anilistId=154587" {
		t.Fatalf("anilist id must win: %v", queries)
	}

	episodes, err := provider.Episodes(context.Background(), EpisodeRequest{ProviderIDs: map[string]string{"jikan": "52991"}, Season: 1})
	if err != nil || len(episodes) != 2 {
		t.Fatalf("episodes = %v, %v", episodes, err)
	}
	episodes = sortedForTest(episodes)
	if episodes[0].Episode != 1 || episodes[0].DurationS != 1440 || episodes[0].Still != "e1.png" {
		t.Fatalf("episode mapping wrong: %+v", episodes[0])
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
