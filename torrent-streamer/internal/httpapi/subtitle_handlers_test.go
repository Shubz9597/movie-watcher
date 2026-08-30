package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"torrent-streamer/internal/torrentx"
)

func TestBuildSubtitleTorrentURLPreservesMagnet(t *testing.T) {
	magnet := "magnet:?xt=urn:btih:ABC123&dn=Show+Name&tr=udp://tracker.example:80"
	got := buildSubtitleTorrentURL(url.Values{
		"magnet": {magnet},
		"cat":    {"tv"},
	}, 7)
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("magnet") != magnet {
		t.Fatalf("magnet was corrupted: %q", parsed.Query().Get("magnet"))
	}
	if parsed.Query().Get("fileIndex") != "7" {
		t.Fatalf("fileIndex = %q, want 7", parsed.Query().Get("fileIndex"))
	}
	if strings.Contains(got, "dn=Show+Name&tr=") {
		t.Fatalf("nested magnet query was not encoded: %s", got)
	}
}

func TestSubtitleHandlersLiveOpenSubFlow(t *testing.T) {
	if os.Getenv("OPENSUB_LIVE_TEST") != "1" {
		t.Skip("set OPENSUB_LIVE_TEST=1 to run against OpenSubtitles")
	}
	if os.Getenv("OPENSUB_API_KEY") == "" && os.Getenv("OS_KEY") == "" {
		t.Fatal("OPENSUB_API_KEY or OS_KEY is required for the live test")
	}

	listReq := httptest.NewRequest(http.MethodGet, "/subtitles/list?imdbId=tt1375666&langs=en", nil)
	listRec := httptest.NewRecorder()
	handleSubtitleList(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("subtitle list returned %d: %s", listRec.Code, listRec.Body.String())
	}
	var list SubtitleListResponse
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Source != "opensub" || len(list.Tracks) == 0 {
		t.Fatalf("subtitle list returned source=%q tracks=%d message=%q", list.Source, len(list.Tracks), list.Message)
	}

	downloadReq := httptest.NewRequest(http.MethodGet, list.Tracks[0].URL, nil)
	downloadRec := httptest.NewRecorder()
	handleSubtitleExternal(downloadRec, downloadReq)
	if downloadRec.Code != http.StatusOK {
		t.Fatalf("subtitle download returned %d: %s", downloadRec.Code, downloadRec.Body.String())
	}
	if !strings.HasPrefix(downloadRec.Body.String(), "WEBVTT") {
		t.Fatalf("subtitle response is not WebVTT: %.80q", downloadRec.Body.String())
	}
}

func TestSplitCSV(t *testing.T) {
	got := splitCSV(" EN, hi, ,FR ")
	want := []string{"en", "hi", "fr"}
	if len(got) != len(want) {
		t.Fatalf("splitCSV length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitCSV[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestFilterTorrentLanguages(t *testing.T) {
	files := []torrentx.SubtitleFile{
		{Name: "movie.en.srt", Lang: "en"},
		{Name: "movie.es.srt", Lang: "es"},
		{Name: "English.srt", Lang: "und"},
	}
	got := filterTorrentLanguages(files, []string{"en"})
	if len(got) != 1 || got[0].Lang != "en" {
		t.Fatalf("filterTorrentLanguages(files, [en]) = %#v, want only English", got)
	}
}
