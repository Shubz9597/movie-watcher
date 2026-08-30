package subtitles

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestSRTtoVTT(t *testing.T) {
	input := "1\r\n00:00:01,250 --> 00:00:03,500\r\nHello\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,100\r\nWorld\r\n"
	got := SRTtoVTT(input)
	for _, want := range []string{"WEBVTT", "00:00:01.250 --> 00:00:03.500", "Hello", "00:01:00.000 --> 00:01:01.100", "World"} {
		if !strings.Contains(got, want) {
			t.Fatalf("converted VTT missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "\n1\n") || strings.Contains(got, "\n2\n") {
		t.Fatalf("cue numbers should be removed:\n%s", got)
	}
}

func TestOpenSubLiveSearch(t *testing.T) {
	if os.Getenv("OPENSUB_LIVE_TEST") != "1" {
		t.Skip("set OPENSUB_LIVE_TEST=1 to run against OpenSubtitles")
	}
	key := os.Getenv("OPENSUB_API_KEY")
	if key == "" {
		t.Fatal("OPENSUB_API_KEY is required for the live test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	results, err := FetchFromOpenSub(ctx, SearchQuery{IMDBID: "tt1375666", Langs: []string{"en"}}, key)
	if err != nil {
		t.Fatalf("live OpenSubtitles search failed: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("live OpenSubtitles search returned no results")
	}
	if len(results) < 2 {
		t.Fatalf("live search returned only %d result; expected the English release catalog", len(results))
	}
	seen := make(map[string]bool)
	for _, result := range results {
		if result.Lang != "en" {
			t.Fatalf("live result language = %q, want en", result.Lang)
		}
		if seen[result.ID] {
			t.Fatalf("duplicate OpenSubtitles file ID %q", result.ID)
		}
		seen[result.ID] = true
	}
}

func TestNormalizeLang(t *testing.T) {
	cases := map[string]string{"eng": "en", "Hindi": "hi", "pt": "pt", "zho": "zh"}
	for input, want := range cases {
		if got := normalizeLang(input); got != want {
			t.Fatalf("normalizeLang(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestOpenSubHeadersUseConfiguredUserToken(t *testing.T) {
	t.Setenv("OPENSUBTITLES_USER_TOKEN", "test-token")
	req, err := http.NewRequest(http.MethodGet, "https://example.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	setOpenSubAPIHeaders(req, "test-key")
	if got := req.Header.Get("Authorization"); got != "Bearer test-token" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Api-Key"); got != "test-key" {
		t.Fatalf("Api-Key = %q", got)
	}
}

func TestPersistentSubtitleCacheRoundTrip(t *testing.T) {
	t.Setenv("SUB_CACHE_DIR", t.TempDir())
	const fileID = 12345
	const want = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"
	if err := saveDiskSubtitle(fileID, want); err != nil {
		t.Fatal(err)
	}
	got, ok := loadDiskSubtitle(fileID)
	if !ok || got != want {
		t.Fatalf("persistent cache got ok=%v content=%q", ok, got)
	}
}

func TestOpenSubRequestRetriesNetworkFailure(t *testing.T) {
	attempts := 0
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("connection reset")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{}`)),
		}, nil
	})}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.test/subtitles", nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := doOpenSubRequest(context.Background(), client, req)
	if err != nil {
		t.Fatalf("request should recover on the second edge: %v", err)
	}
	defer resp.Body.Close()
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}

func TestDownloadSubtitleResponseRetriesNetworkFailure(t *testing.T) {
	attempts := 0
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("connection reset")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("subtitle")),
		}, nil
	})}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.test/file.srt", nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := downloadSubtitleResponse(context.Background(), client, req)
	if err != nil {
		t.Fatalf("subtitle file request should recover: %v", err)
	}
	defer resp.Body.Close()
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}
