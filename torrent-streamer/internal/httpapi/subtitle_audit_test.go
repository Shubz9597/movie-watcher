package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/subtitles"
)

func stubConfiguredCatalog(t *testing.T, fn func(context.Context, subtitles.SearchQuery, string) ([]subtitles.SubResult, error)) {
	t.Helper()
	old := fetchOpenSubCatalog
	fetchOpenSubCatalog = fn
	setOpenSubtitlesAPIKey("audit-key")
	t.Cleanup(func() { fetchOpenSubCatalog = old; setOpenSubtitlesAPIKey("") })
}

func TestAnimeSubtitleMappingAppliesToBothCatalogsAndOffline(t *testing.T) {
	stubStremioSubtitles(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/subtitles/series/tt919191:3:5.json" {
			t.Errorf("wrong mapped addon path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"subtitles":[]}`))
	})
	mappings := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"mappings":{"imdb_id":"tt919191"},"episodes":{"5":{"seasonNumber":3,"episodeNumber":5}}}`))
	}))
	defer mappings.Close()
	t.Setenv("TORWATCH_ANIZIP_BASE_URL", mappings.URL)
	calls := 0
	stubConfiguredCatalog(t, func(_ context.Context, q subtitles.SearchQuery, _ string) ([]subtitles.SubResult, error) {
		calls++
		if q.IMDBID != "tt919191" || q.Season != 3 || q.Episode != 5 {
			t.Errorf("wrong API episode: %+v", q)
		}
		return nil, nil
	})
	recorder := httptest.NewRecorder()
	handleSubtitleList(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/list?anilistId=9919191&imdbId=tt1111&season=1&episode=5&langs=en", nil))
	_, _, err := (DownloadSubtitleSource{}).fetchOnce(context.Background(), downloads.SubtitleQuery{SeriesID: "anilist:9919191", Season: 1, Episode: 5, Lang: "en"})
	if !errors.Is(err, downloads.ErrSubtitleNotFound) || calls != 2 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestSubtitleProviderFailurePreservesChoicesAndOfflineRetry(t *testing.T) {
	stubStremioSubtitles(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/subtitles/movie/tt919192.json" {
			_, _ = w.Write([]byte(`{"subtitles":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"subtitles":[{"id":"audit-track","url":"https://subs5.strem.io/audit","lang":"eng"}]}`))
	})
	failure := errors.New("configured catalog unavailable")
	stubConfiguredCatalog(t, func(context.Context, subtitles.SearchQuery, string) ([]subtitles.SubResult, error) {
		return nil, failure
	})
	recorder := httptest.NewRecorder()
	handleSubtitleList(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/list?imdbId=tt919193&langs=en", nil))
	var list SubtitleListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Tracks) != 1 || list.Message == "" {
		t.Fatalf("partial catalog: %+v", list)
	}
	_, _, err := (DownloadSubtitleSource{}).fetchOnce(context.Background(), downloads.SubtitleQuery{SeriesID: "tmdb:movie:919192", Lang: "en", Hints: downloads.SubtitleHints{IMDBID: "tt919192"}})
	if !errors.Is(err, failure) || errors.Is(err, downloads.ErrSubtitleNotFound) {
		t.Fatalf("outage was marked final: %v", err)
	}
}
