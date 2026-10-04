package subtitles

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchFromStremioFiltersLanguageAndUntrustedHosts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/subtitles/series/tt11280740:1:1.json" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"subtitles":[
 {"id":"1","url":"https://subs5.strem.io/en/download/file/1","lang":"eng","subtitleFileName":"Severance.S01E01.1080p.WEB-DL.srt","movieReleaseName":"Severance.S01E01.1080p.WEB-DL"},
 {"id":"2","url":"https://subs5.strem.io/en/download/file/2","lang":"spa"},
 {"id":"3","url":"http://evil.example/steal","lang":"eng"}
]}`))
	}))
	defer server.Close()
	previous := stremioSubtitlesBase
	stremioSubtitlesBase = server.URL
	defer func() { stremioSubtitlesBase = previous }()

	results, err := FetchFromStremio(context.Background(), SearchQuery{IMDBID: "tt11280740", Season: 1, Episode: 1, Langs: []string{"en"}})
	if err != nil || len(results) != 1 {
		t.Fatalf("results = %+v, %v; want the one trusted English subtitle", results, err)
	}
	if got := results[0]; got.Source != "stremio" || got.Lang != "en" || got.Release != "Severance.S01E01.1080p.WEB-DL" {
		t.Fatalf("result = %+v", got)
	}
	if _, err := FetchFromStremio(context.Background(), SearchQuery{Title: "No id"}); err != ErrNoIMDbID {
		t.Fatalf("missing IMDb id: err = %v", err)
	}
	if _, err := DownloadStremioSubtitle(context.Background(), "3"); err == nil {
		t.Fatal("an untrusted URL must never be downloadable")
	}
}
