package catalog

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// resettingServer cuts the first `resets` connections (TCP RST, as the home
// ISP's filter does to TMDb TLS handshakes), then answers normally.
func resettingServer(t *testing.T, resets int32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) <= resets {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				if tcp, ok := conn.(*net.TCPConn); ok {
					_ = tcp.SetLinger(0)
				}
				_ = conn.Close()
			}
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	return server, &requests
}

func TestProviderRequestsSurviveConnectionResets(t *testing.T) {
	server, requests := resettingServer(t, 3)
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var target struct{ OK bool }
	if err := fetchJSON(ctx, client, server.URL, &target); err != nil || !target.OK {
		t.Fatalf("fetch = %+v, %v; three resets must be retried", target, err)
	}
	if got := requests.Load(); got != 4 {
		t.Fatalf("requests = %d, want 4 (3 resets + 1 answer)", got)
	}
}

func TestProviderRequestsGiveUpAfterRepeatedResets(t *testing.T) {
	server, requests := resettingServer(t, 100)
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var target struct{ OK bool }
	if err := fetchJSON(ctx, client, server.URL, &target); err == nil {
		t.Fatal("a provider that always resets must fail")
	}
	if got := requests.Load(); got > int32(connectionResetRetries)+3 {
		t.Fatalf("requests = %d; retries must stay bounded", got)
	}
}
