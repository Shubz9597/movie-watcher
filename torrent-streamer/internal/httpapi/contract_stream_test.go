package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567"

func TestParseByteRangeCapturedSemantics(t *testing.T) {
	t.Parallel()
	cases := []struct {
		header     string
		size       int64
		start, end int64
		wantOK     bool
	}{
		{header: "bytes=0-1023", size: 4096, start: 0, end: 1023, wantOK: true},
		{header: "bytes=1024-", size: 4096, start: 1024, end: 4095, wantOK: true},
		{header: "bytes=-512", size: 4096, start: 3584, end: 4095, wantOK: true},
		{header: "bytes=-9999", size: 4096, start: 0, end: 4095, wantOK: true},
		{header: "bytes=0-99999", size: 4096, start: 0, end: 4095, wantOK: true},
		{header: "bytes=5000-", size: 4096, wantOK: false},
		{header: "bytes=0-1,5-6", size: 4096, wantOK: false},
		{header: "bytes=5-2", size: 4096, wantOK: false},
		{header: "bytes=abc", size: 4096, wantOK: false},
		{header: "chunked", size: 4096, wantOK: false},
		{header: "", size: 4096, wantOK: false},
	}
	for _, c := range cases {
		start, end, ok := parseByteRange(c.header, c.size)
		if ok != c.wantOK || (ok && (start != c.start || end != c.end)) {
			t.Fatalf("parseByteRange(%q, %d) = (%d,%d,%v), want (%d,%d,%v)",
				c.header, c.size, start, end, ok, c.start, c.end, c.wantOK)
		}
	}
}

func TestIsProbeRangeCapturedRule(t *testing.T) {
	t.Parallel()
	cases := []struct {
		start, end int64
		want       bool
	}{
		{0, 1023, true},
		{0, 1024, false},
		{100, 200, true},
		{5, 4, false},
	}
	for _, c := range cases {
		if got := isProbeRange(c.start, c.end); got != c.want {
			t.Fatalf("isProbeRange(%d,%d) = %v, want %v", c.start, c.end, got, c.want)
		}
	}
}

func TestStreamRouteCapturedErrorShapes(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/stream", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "missing magnet/src/infoHash\n" {
		t.Fatalf("/stream no src = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/stream?infoHash=zzz", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "invalid infoHash\n" {
		t.Fatalf("/stream invalid infoHash = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/stream?magnet="+url.QueryEscape(testMagnet), nil))
	if recorder.Code != http.StatusGatewayTimeout ||
		recorder.Body.String() != "torrent metadata unavailable: no reachable peers before timeout\n" {
		t.Fatalf("/stream metadata timeout = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestFilesRouteCapturedErrorShapes(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/files", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "missing magnet/src/infoHash\n" {
		t.Fatalf("/files no src = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/files?magnet="+url.QueryEscape(testMagnet), nil))
	if recorder.Code != http.StatusGatewayTimeout ||
		recorder.Body.String() != "metadata timeout\n" {
		t.Fatalf("/files metadata timeout = %d %q", recorder.Code, recorder.Body.String())
	}
}
