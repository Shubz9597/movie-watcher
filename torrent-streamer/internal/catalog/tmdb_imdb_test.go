package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTMDbDetailCarriesIMDbID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("append_to_response"), "external_ids") {
			t.Errorf("detail request must append external_ids: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/3/tv/") {
			_, _ = w.Write([]byte(`{"id":95396,"name":"Severance","first_air_date":"2022-02-17","external_ids":{"imdb_id":"tt11280740"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":157336,"title":"Interstellar","release_date":"2014-11-05","imdb_id":"tt0816692"}`))
	}))
	defer server.Close()
	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, APIKey: "k", HTTP: server.Client()})
	for id, want := range map[string]string{"movie:157336": "tt0816692", "tv:95396": "tt11280740"} {
		title, err := provider.Detail(context.Background(), DetailRequest{ProviderIDs: map[string]string{"tmdb": id}})
		if err != nil {
			t.Fatalf("Detail(%s): %v", id, err)
		}
		if title.IMDBID != want || title.ProviderIDs["imdb"] != want {
			t.Fatalf("Detail(%s) imdb = %q / %q, want %q", id, title.IMDBID, title.ProviderIDs["imdb"], want)
		}
	}
}
