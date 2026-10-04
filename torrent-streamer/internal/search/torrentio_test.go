package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const torrentioSample = `{"streams":[
 {"name":"Torrentio\n4k","title":"Severance S01E01 Good News About Hell REPACK 2160p ATVP WEB-DL DDP5 1 Atmos\n👤 83 💾 10.04 GB ⚙️ ThePirateBay\n🇬🇧 / 🇯🇵 / 🇷🇺 / 🇮🇹","infoHash":"9b756eb0fd8a226faa8607cfb04e8e268f7aff52","fileIdx":0,"sources":["tracker:udp://tracker.opentrackr.org:1337/announce","dht:9b756eb0fd8a226faa8607cfb04e8e268f7aff52"]},
 {"name":"Torrentio\n1080p","title":"Severance.S01.1080p.WEB-DL.x264-GRP\nS01/S01E01.mkv\n👤 74 💾 950.5 MB ⚙️ 1337x","infoHash":"25ba9dddbdfffa3b6ea1b6f050c8dee118b8878b","fileIdx":3},
 {"name":"Torrentio\n1080p","title":"Castle Rock S01E01 Severance 1080p WEBRip\n👤 5 💾 1 GB ⚙️ EZTV","infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
]}`

func TestTorrentioStreamsBecomeReleases(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stream/series/tt11280740:1:1.json" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(torrentioSample))
	}))
	defer server.Close()
	season, episode := 1, 1
	request := Request{Kind: KindTV, Title: "Severance", IMDBID: "tt11280740", Season: &season, Episode: &episode, OriginalLanguage: "en"}
	releases, err := (&Torrentio{BaseURL: server.URL, HTTP: server.Client()}).Releases(context.Background(), request)
	if err != nil || len(releases) != 3 {
		t.Fatalf("Releases = %d, %v", len(releases), err)
	}
	first := releases[0]
	if first.Title != "Severance S01E01 Good News About Hell REPACK 2160p ATVP WEB-DL DDP5 1 Atmos" || first.Seeders != 83 ||
		first.Size != parseTorrentioSize("10.04", "GB") || first.Indexer != "Torrentio · ThePirateBay" ||
		!strings.Contains(first.MagnetURL, "tr=udp%3A%2F%2Ftracker.opentrackr.org") {
		t.Fatalf("first release = %+v", first)
	}
	if releases[1].FileIndex == nil || *releases[1].FileIndex != 3 || releases[1].Size != 996671488 {
		t.Fatalf("pack release = %+v", releases[1])
	}

	// The language-flag line never reaches the audio rules, and the usual
	// release decisions apply (Castle Rock is a different show).
	service := newTestService(t, "http://127.0.0.1:9696")
	results := service.normalize(request, releases)
	if len(results) != 2 || results[0].Audio != "" {
		t.Fatalf("results = %+v", results)
	}
}

func TestTorrentioFailureFallsBackToProwlarr(t *testing.T) {
	t.Parallel()
	var prowlarrSearches atomic.Int32
	torrentio := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer torrentio.Close()
	prowlarr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/indexer" {
			mockIndexerList(w, []map[string]any{indexerEntry(1, "YTS", true, "torrent", 1)})
			return
		}
		prowlarrSearches.Add(1)
		_ = json.NewEncoder(w).Encode([]prowlarrRelease{{Title: "Dune (2021) 1080p BRRip x264 -YTS", Indexer: "YTS", Protocol: "torrent", InfoHash: idHex('d'), Seeders: 50}})
	}))
	defer prowlarr.Close()

	service := newTestService(t, prowlarr.URL)
	service.SetTorrentio(&Torrentio{BaseURL: torrentio.URL, HTTP: torrentio.Client()})
	response, err := service.Search(context.Background(), Request{Kind: KindMovie, Title: "Dune", Year: 2021, IMDBID: "tt1160419", OriginalLanguage: "en"})
	if err != nil || len(response.Results) != 1 || prowlarrSearches.Load() == 0 {
		t.Fatalf("Search = %+v, %v; prowlarr searches %d — want the Prowlarr fallback", response.Results, err, prowlarrSearches.Load())
	}
}

func TestTorrentioPaths(t *testing.T) {
	t.Parallel()
	anizip := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("anilist_id") == "154587" {
			_, _ = w.Write([]byte(`{"mappings":{"kitsu_id":46474,"imdb_id":"tt22248376"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"mappings":{}}`))
	}))
	defer anizip.Close()
	source := &Torrentio{AniZipURL: anizip.URL, HTTP: anizip.Client()}
	one, five := 1, 5
	cases := []struct {
		request Request
		want    string
	}{
		{Request{Kind: KindAnime, Title: "Frieren", AniListID: 154587, Season: &one, Episode: &five, Absolute: &five}, "/stream/series/kitsu:46474:5.json"},
		{Request{Kind: KindAnime, Title: "Frieren film", AniListID: 154587}, "/stream/movie/kitsu:46474.json"},
		{Request{Kind: KindAnime, Title: "No mapping", AniListID: 999, IMDBID: "tt0388629", Season: &one, Episode: &five}, "/stream/series/tt0388629:1:5.json"},
		{Request{Kind: KindAnime, Title: "No ids", Episode: &five}, ""},
		{Request{Kind: KindMovie, Title: "Dune"}, ""},
		{Request{Kind: KindTV, Title: "Severance", IMDBID: "tt11280740"}, ""},
	}
	for _, test := range cases {
		if got := source.path(context.Background(), test.request); got != test.want {
			t.Errorf("path(%s) = %q, want %q", test.request.Title, got, test.want)
		}
	}
}

func TestPublicTrackerRejectsHomeNetwork(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]bool{
		"udp://tracker.opentrackr.org:1337/announce": true,
		"https://tracker.example.org/announce":       true,
		"http://192.168.1.1/announce":                false,
		"udp://127.0.0.1:6969":                       false,
		"http://localhost:8080/announce":             false,
		"http://[::1]/announce":                      false,
		"http://printer.local/announce":              false,
		"file:///etc/passwd":                         false,
		"http://10.0.0.5/announce":                   false,
	} {
		if got := publicTracker(raw); got != want {
			t.Errorf("publicTracker(%q) = %t, want %t", raw, got, want)
		}
	}
}

func TestTorrentioSendsUserAgent(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != userAgent {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"streams":[]}`))
	}))
	defer server.Close()
	if _, err := (&Torrentio{BaseURL: server.URL, HTTP: server.Client()}).Releases(context.Background(), Request{Kind: KindMovie, Title: "x", IMDBID: "tt0468569"}); err != nil {
		t.Fatalf("Releases with the TorWatch agent = %v", err)
	}
}
