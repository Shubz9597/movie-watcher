package subtitles

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestOpenSubCatalogKeepsAllFilesAndSeparatesCredentials(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Api-Key") == "empty-account" {
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"attributes":{"language":"en","release":"Movie BluRay","files":[{"file_id":91001,"file_name":"CD1.srt"},{"file_id":91002,"file_name":"CD2.srt"},{"file_id":91001,"file_name":"duplicate.srt"}]}}]}`))
	}))
	defer server.Close()
	old := openSubAPI
	openSubAPI = server.URL
	t.Cleanup(func() { openSubAPI = old })
	q := SearchQuery{IMDBID: "tt91001", Langs: []string{"en"}}
	if got, err := FetchFromOpenSub(context.Background(), q, "empty-account"); err != nil || len(got) != 0 {
		t.Fatalf("empty account: %v, %v", got, err)
	}
	for range 2 {
		got, err := FetchFromOpenSub(context.Background(), q, "connected-account")
		if err != nil || len(got) != 2 || got[0].ID != "91001" || got[1].ID != "91002" {
			t.Fatalf("catalog files: %+v, %v", got, err)
		}
		got[0].FileName = "mutated"
	}
	if calls.Load() != 2 {
		t.Fatalf("provider calls=%d, want one per credential", calls.Load())
	}
}

func TestStremioSearchCachesChoicesAndSeparatesLanguages(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"subtitles":[{"id":"audit-en","url":"https://subs5.strem.io/en","lang":"eng"},{"id":"audit-hi","url":"https://subs5.strem.io/hi","lang":"hin"}]}`)
	}))
	defer server.Close()
	t.Setenv("TORWATCH_STREMIO_SUBTITLES_URL", server.URL)
	for _, langs := range [][]string{{"en"}, {"eng"}, {"hi"}, {"hi"}} {
		got, err := FetchFromStremio(context.Background(), SearchQuery{IMDBID: "tt919191", Langs: langs})
		if err != nil || len(got) != 1 || got[0].Lang != normalizeLang(langs[0]) {
			t.Fatalf("cached language %v: %+v, %v", langs, got, err)
		}
		got[0].Lang = "mutated"
	}
	if calls.Load() != 2 {
		t.Fatalf("provider calls=%d, want one per language", calls.Load())
	}
}
