package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSubtitleConfigureRouteContract(t *testing.T) {
	// Not parallel: mutates the package-global OpenSubtitles credential that
	// the external/list contract tests assert against.
	mux := http.NewServeMux()
	RegisterSubtitleRoutes(mux)
	t.Cleanup(func() { setOpenSubtitlesAPIKey("") })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodOptions, "/subtitles/configure", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "" {
		t.Fatalf("OPTIONS configure = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/configure", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Body.String() != "method not allowed\n" {
		t.Fatalf("GET configure = %d %q", recorder.Code, recorder.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/subtitles/configure", strings.NewReader(`{"apiKey":"key-123"}`))
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"ok\":true}\n" {
		t.Fatalf("configure = %d %q", recorder.Code, recorder.Body.String())
	}
	if got := openSubtitlesAPIKey(); got != "key-123" {
		t.Fatalf("configured key = %q", got)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/subtitles/configure", strings.NewReader(`{"apiKey":"  "}`)))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "invalid api key\n" {
		t.Fatalf("blank key = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/subtitles/configure", strings.NewReader("not json")))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "invalid request\n" {
		t.Fatalf("bad json = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSubtitleExternalRouteContract(t *testing.T) {
	// Not parallel: depends on the package-global credential being unset.
	mux := http.NewServeMux()
	RegisterSubtitleRoutes(mux)
	setOpenSubtitlesAPIKey("")
	t.Cleanup(func() { setOpenSubtitlesAPIKey("") })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/external?source=bogus&id=1", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "unsupported subtitle source: bogus\n" {
		t.Fatalf("unsupported source = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/external?source=opensub", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "missing id parameter\n" {
		t.Fatalf("missing id = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/external?source=opensub&id=42", nil))
	if recorder.Code != http.StatusServiceUnavailable ||
		recorder.Body.String() != "OpenSubtitles API key not configured\n" {
		t.Fatalf("no key = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSubtitleTorrentRouteContract(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterSubtitleRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/torrent", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "missing magnet/src/infoHash\n" {
		t.Fatalf("no src = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/torrent?magnet="+url.QueryEscape(testMagnet), nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "invalid fileIndex\n" {
		t.Fatalf("missing fileIndex = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/torrent?magnet="+url.QueryEscape(testMagnet)+"&fileIndex=0", nil))
	if recorder.Code != http.StatusGatewayTimeout ||
		recorder.Body.String() != "metadata timeout\n" {
		t.Fatalf("metadata timeout = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSubtitleListRouteCapturedDegradedShape(t *testing.T) {
	// Not parallel: depends on the package-global credential being unset.
	mux := http.NewServeMux()
	RegisterSubtitleRoutes(mux)
	setOpenSubtitlesAPIKey("")
	t.Cleanup(func() { setOpenSubtitlesAPIKey("") })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/subtitles/list", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["source"] != "none" || payload["fallbackUsed"] != false || payload["providerConfigured"] != false {
		t.Fatalf("degraded list payload = %v", payload)
	}
	if payload["message"] != "OpenSubtitles API key is not configured" {
		t.Fatalf("message = %v", payload["message"])
	}
	tracks, ok := payload["tracks"].([]any)
	if !ok || len(tracks) != 0 {
		t.Fatalf("tracks = %v, want empty array", payload["tracks"])
	}
}
