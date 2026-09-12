package httpapi

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/playback"
)

// 13. Origin/CORS/preflight contract: allowlisted origins get exact echo,
// disallowed origins get no CORS headers, wildcard is never honored, and
// POST/DELETE preflights are supported.
func TestPlaybackCORSContract(t *testing.T) {
	origins := []string{"http://127.0.0.1:4174", "https://phone.tailnet-example.ts.net"}
	h := PlaybackHandlers{
		Manager:        &playback.Manager{}, // non-nil so routes register; no sessions exist
		Build:          buildinfo.Info{SupportedProtocolRange: []int{1, 1}},
		AllowedOrigins: origins,
	}
	mux := http.NewServeMux()
	h.Register(mux)

	// Preflight for POST from an allowlisted origin.
	req := httptest.NewRequest("OPTIONS", "/v2/playback/sessions", nil)
	req.Header.Set("Origin", origins[0])
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("preflight status = %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origins[0] {
		t.Fatalf("ACAO = %q", got)
	}
	if methods := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(methods, "POST") || !strings.Contains(methods, "DELETE") {
		t.Fatalf("preflight methods = %q", methods)
	}

	// Disallowed origin: no CORS headers at all.
	req2 := httptest.NewRequest("OPTIONS", "/v2/playback/sessions", nil)
	req2.Header.Set("Origin", "https://evil.example")
	req2.Header.Set("Access-Control-Request-Method", "POST")
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("disallowed origin received CORS headers")
	}

	// A wildcard in the configured list is rejected upstream; assert the
	// allowlist constructor still refuses it here.
	allow := NewOriginAllowlist([]string{"*"})
	if allow.Allows("https://anything.example") {
		t.Fatal("wildcard origin must never be allowed")
	}
}

// 14. Without a wired manager the routes are ABSENT (404), and the handler
// struct can't accidentally register them.
func TestPlaybackRoutesAbsentWithoutManager(t *testing.T) {
	h := PlaybackHandlers{Manager: nil, Build: buildinfo.Info{}}
	mux := http.NewServeMux()
	h.Register(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/v2/playback/sessions", bytes.NewReader([]byte("{}"))))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("route with nil manager = %d, want 404", rec.Code)
	}
}

// Create with a wired-but-empty manager: bounded 4xx errors (no sessions can
// exist without a resolver-backed Create path, so the route itself answers).
func TestPlaybackCreateBoundedErrors(t *testing.T) {
	ms, err := playback.NewMediaSource()
	if err != nil {
		t.Skipf("loopback listener unavailable: %v", err)
	}
	defer ms.Close()
	mgr := playback.NewManager(playback.Config{DataRoot: t.TempDir()},
		playback.Tools{FFprobePath: "missing-probe", FFmpegPath: "missing-ffmpeg"},
		&boundedTestProber{}, &boundedTestResolver{}, ms)
	h := PlaybackHandlers{Manager: mgr, Build: buildinfo.Info{}, PlaybackRoot: t.TempDir()}
	mux := http.NewServeMux()
	h.Register(mux)

	req := httptest.NewRequest("POST", "/v2/playback/sessions",
		bytes.NewReader([]byte(`{"cat":"movie","sourceId":"short","profile":"ios-avplayer"}`)))
	req.Header.Set("Origin", "http://127.0.0.1:4174")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid source id status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "40-character") {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "magnet") {
		t.Fatalf("error body mentions magnets: %s", rec.Body.String())
	}
}

type boundedTestProber struct{}

func (boundedTestProber) Probe(context.Context, string) (*playback.MediaInfo, error) {
	return nil, &playback.Error{Code: playback.ReasonMediaInspectionFail, Message: "probe failed"}
}

type boundedTestResolver struct{}

func (boundedTestResolver) Resolve(context.Context, string, string, int) (playback.ResolvedSource, error) {
	return playback.ResolvedSource{}, &playback.Error{Code: "invalid_request", Message: "The source identifier must be a 40-character info hash."}
}

type handlerReadSeekCloser struct{ *bytes.Reader }

func (handlerReadSeekCloser) Close() error { return nil }

type expiringTestResolver struct{}

func (expiringTestResolver) Resolve(context.Context, string, string, int) (playback.ResolvedSource, error) {
	return playback.ResolvedSource{
		Open: func() (io.ReadSeekCloser, error) {
			return handlerReadSeekCloser{bytes.NewReader(make([]byte, 1024))}, nil
		},
		Name: "sample.mp4",
		Size: 1024,
		Sidecars: []playback.Sidecar{{
			Format: "srt",
			Open: func() (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader("1\n00:00:00,000 --> 00:00:01,000\nHello\n")), nil
			},
		}},
	}, nil
}

type expiringTestProber struct{}

func (expiringTestProber) Probe(context.Context, string) (*playback.MediaInfo, error) {
	return &playback.MediaInfo{
		Container: "mp4", Width: 320, Height: 240,
		Video: playback.VideoInfo{Codec: "h264"},
		Audio: playback.AudioInfo{Codec: "aac"},
	}, nil
}

func TestPlaybackFilesRejectExpiredSessionBeforeSweep(t *testing.T) {
	ms, err := playback.NewMediaSource()
	if err != nil {
		t.Skipf("loopback listener unavailable: %v", err)
	}
	defer ms.Close()
	root := t.TempDir()
	mgr := playback.NewManager(
		playback.Config{DataRoot: root, SessionTTL: 15 * time.Millisecond},
		playback.Tools{}, expiringTestProber{}, expiringTestResolver{}, ms,
	)
	view, err := mgr.Create(context.Background(), "movie", "0123456789abcdef0123456789abcdef01234567", 0, "ios-avplayer")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(view.Subtitles) != 1 {
		t.Fatalf("subtitle offers = %d, want 1", len(view.Subtitles))
	}

	h := PlaybackHandlers{Manager: mgr, Build: buildinfo.Info{}, PlaybackRoot: root}
	mux := http.NewServeMux()
	h.Register(mux)
	time.Sleep(25 * time.Millisecond)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, view.Subtitles[0].URL, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expired subtitle status = %d, want 404", rec.Code)
	}
}
