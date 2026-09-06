package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"torrent-streamer/internal/buffer"
)

func TestBufferStateRouteContract(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/state?state=rewind", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "state must be pause|play|stop\n" {
		t.Fatalf("invalid state = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/state?state=stop&src=http%3A%2F%2Fexample.com%2Fx", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "src parameter must contain a literal magnet URI\n" {
		t.Fatalf("non-magnet src = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/state?state=stop&infoHash=zzz", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "invalid infoHash\n" {
		t.Fatalf("invalid infoHash = %d %q", recorder.Code, recorder.Body.String())
	}

	const infoHash = "0123456789ABCDEF0123456789ABCDEF01234567"
	controller := buffer.Get(buffer.Key{Cat: "movie", IH: infoHash, FIdx: 0})
	controller.SetState(buffer.StatePaused)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/buffer/state?cat=movie&state=stop&magnet="+url.QueryEscape("magnet:?xt=urn:btih:"+infoHash), nil))
	if recorder.Code != http.StatusOK ||
		recorder.Body.String() != "{\"ok\":true,\"state\":\"stopped\"}\n" {
		t.Fatalf("stop = %d %q", recorder.Code, recorder.Body.String())
	}
	if got := controller.State(); got != buffer.StateStopped {
		t.Fatalf("controller state = %q, want stopped", got)
	}
}

func TestBufferInfoRouteCapturedFallbackShape(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/info", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "missing magnet/src/infoHash\n" {
		t.Fatalf("no src = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/info?magnet="+url.QueryEscape(testMagnet), nil))
	if recorder.Code != http.StatusOK ||
		recorder.Body.String() != "{\"contiguousAhead\":0,\"targetBytes\":0}\n" {
		t.Fatalf("json fallback = %d %q", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("content type = %q", got)
	}
}

func TestBufferInfoRouteCapturedSSETick(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/buffer/info?magnet="+url.QueryEscape(testMagnet)+"&sse=1", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("sse status = %d body=%q", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("sse content type = %q", got)
	}
	want := "retry: 2000\n\ndata: {\"targetBytes\":0,\"contiguousAhead\":0}\n\n"
	if recorder.Body.String() != want {
		t.Fatalf("sse body = %q, want %q", recorder.Body.String(), want)
	}
}

func TestWantsSSE(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet, "/buffer/info?magnet=x&sse=1", nil)
	if !wantsSSE(request) {
		t.Fatal("sse=1 not detected")
	}
	request = httptest.NewRequest(http.MethodGet, "/buffer/info?magnet=x", nil)
	request.Header.Set("Accept", "text/event-stream")
	if !wantsSSE(request) {
		t.Fatal("Accept header not detected")
	}
	request = httptest.NewRequest(http.MethodGet, "/buffer/info?magnet=x", nil)
	if wantsSSE(request) {
		t.Fatal("plain request detected as SSE")
	}
}
