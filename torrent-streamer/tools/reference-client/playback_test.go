package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlaybackJourneyEndpoints(t *testing.T) {
	server := newStubBackend(t)
	client := newTestClient(t, server)
	ctx := context.Background()

	resolve, err := client.Resolve(ctx, "source-1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !strings.HasPrefix(resolve.MagnetURI, "magnet:?xt=urn:btih:0123456789ABCDEF") {
		t.Fatalf("resolve result wrong: %+v", resolve)
	}

	status, contentRange, body, err := client.StreamRange(ctx, resolve.MagnetURI, -1, 0, 1023)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if status != http.StatusPartialContent || len(body) != 1024 || contentRange != "bytes 0-1023/8192" {
		t.Fatalf("ranged stream = status %d, %d bytes, range %q", status, len(body), contentRange)
	}

	if err := client.Heartbeat(ctx, HeartbeatRequest{
		SubjectID: "subject-A", SeriesID: "tmdb:209867", Season: 1, Episode: 1,
		PositionS: 600, DurationS: 1440,
	}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}

	state, err := client.Resume(ctx, "subject-A", "tmdb:209867")
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !state.Found || state.PositionS != 585 {
		t.Fatalf("resume must apply the 15s rewind to the stored 600s: %+v", state)
	}
}

func TestFullJourneyCommand(t *testing.T) {
	server := newStubBackend(t)
	client := newTestClient(t, server)
	if err := client.RunJourney(context.Background(), "frieren",
		"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
		"subject-journey", "tmdb:209867"); err != nil {
		t.Fatalf("journey: %v", err)
	}
}

func TestJourneyFailsWithoutViableSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/version" {
			_, _ = w.Write([]byte(`{"serverVersion":"1","protocolVersion":1,"supportedProtocolRange":[1,1],"capabilities":["catalog.bff.v2"]}`))
			return
		}
		if r.URL.Path == "/v2/catalog/search" {
			_, _ = w.Write([]byte(`{"results":[],"total":0}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := newTestClient(t, server)
	err := client.RunJourney(context.Background(), "nothing", "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567", "s", "x")
	if err == nil || !strings.Contains(err.Error(), "no results") {
		t.Fatalf("empty search must produce an explicit no-viable-source outcome: %v", err)
	}
}
