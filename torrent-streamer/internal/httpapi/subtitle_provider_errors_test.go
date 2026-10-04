package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"torrent-streamer/internal/downloads"
)

// stubStremioSubtitles points the Stremio subtitle addon at a stub and
// clears the OpenSubtitles key, so Stremio is the only catalog.
func stubStremioSubtitles(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	t.Setenv("TORWATCH_STREMIO_SUBTITLES_URL", server.URL)
	t.Setenv("OPENSUB_API_KEY", "")
	t.Setenv("OS_KEY", "")
	setOpenSubtitlesAPIKey("")
}

func TestSubtitleListReportsNoneFoundWhenStremioIsEmpty(t *testing.T) {
	stubStremioSubtitles(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"subtitles":[{"id":"1","url":"https://subs5.strem.io/x","lang":"ger"}]}`))
	})
	recorder := httptest.NewRecorder()
	handleSubtitleList(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/list?imdbId=tt0209144&langs=en", nil))
	var list SubtitleListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Tracks) != 0 || list.Message != "No English subtitles found" {
		t.Fatalf("tracks=%d message=%q; an empty answer is not an outage", len(list.Tracks), list.Message)
	}
}

func TestDownloadSubtitleRetriesWhenStremioFails(t *testing.T) {
	stubStremioSubtitles(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	query := downloads.SubtitleQuery{SeriesID: "tmdb:movie:77", Lang: "en", Hints: downloads.SubtitleHints{IMDBID: "tt0209144"}}
	_, _, err := DownloadSubtitleSource{}.fetchOnce(context.Background(), query)
	if err == nil || errors.Is(err, downloads.ErrSubtitleNotFound) {
		t.Fatalf("err = %v; an outage must stay retryable, not final not-found", err)
	}

	stubStremioSubtitles(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"subtitles":[]}`))
	})
	if _, _, err := (DownloadSubtitleSource{}).fetchOnce(context.Background(), query); !errors.Is(err, downloads.ErrSubtitleNotFound) {
		t.Fatalf("err = %v; an empty answer is final", err)
	}
}
