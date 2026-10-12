package apiproxy

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"

	"golang.org/x/net/proxy"
)

// fakeSocks records which addresses went through the proxy.
type fakeSocks struct {
	mu   sync.Mutex
	seen []string
	err  error
}

func (f *fakeSocks) Dial(network, addr string) (net.Conn, error) {
	return f.DialContext(context.Background(), network, addr)
}

func (f *fakeSocks) DialContext(_ context.Context, _, addr string) (net.Conn, error) {
	f.mu.Lock()
	f.seen = append(f.seen, addr)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	client, server := net.Pipe()
	go func() { _, _ = io.Copy(io.Discard, server) }()
	return client, nil
}

var _ proxy.ContextDialer = (*fakeSocks)(nil)

func router(socks *fakeSocks, healthy bool) *Router {
	r := &Router{name: "warp:1080", hosts: []string{"themoviedb.org", "opensubtitles.com"}, socks: socks}
	r.healthy.Store(healthy)
	return r
}

func TestOnlyChosenHostsGoThroughTheProxy(t *testing.T) {
	socks := &fakeSocks{}
	r := router(socks, true)
	var direct []string
	directDial := func(_ context.Context, _, addr string) (net.Conn, error) {
		direct = append(direct, addr)
		return nil, errors.New("direct")
	}
	for _, addr := range []string{"api.themoviedb.org:443", "themoviedb.org:443", "API.OpenSubtitles.com:443", "v3-cinemeta.strem.io:443", "notthemoviedb.org:443"} {
		_, _ = r.Dial(context.Background(), "tcp", addr, directDial)
	}
	if len(socks.seen) != 3 || len(direct) != 2 || direct[0] != "v3-cinemeta.strem.io:443" || direct[1] != "notthemoviedb.org:443" {
		t.Fatalf("proxied %v, direct %v", socks.seen, direct)
	}
}

func TestDirectWhenTheTunnelIsDownOrADialFails(t *testing.T) {
	directDials := 0
	directDial := func(context.Context, string, string) (net.Conn, error) {
		directDials++
		client, _ := net.Pipe()
		return client, nil
	}
	down := &fakeSocks{}
	if _, err := router(down, false).Dial(context.Background(), "tcp", "api.themoviedb.org:443", directDial); err != nil || len(down.seen) != 0 || directDials != 1 {
		t.Fatalf("unhealthy tunnel: err %v, proxied %v, direct %d", err, down.seen, directDials)
	}
	failing := &fakeSocks{err: errors.New("general SOCKS server failure")}
	if _, err := router(failing, true).Dial(context.Background(), "tcp", "api.themoviedb.org:443", directDial); err != nil || len(failing.seen) != 1 || directDials != 2 {
		t.Fatalf("failed proxied dial: err %v, proxied %v, direct %d", err, failing.seen, directDials)
	}
}

func TestNoProxyDialsDirectly(t *testing.T) {
	var nilRouter *Router
	called := false
	_, _ = nilRouter.Dial(context.Background(), "tcp", "api.themoviedb.org:443", func(context.Context, string, string) (net.Conn, error) {
		called = true
		return nil, errors.New("direct")
	})
	if !called {
		t.Fatal("nil router did not dial directly")
	}
}

func TestNewRejectsOtherSchemes(t *testing.T) {
	if _, err := New("http://warp:1080", DefaultHosts, probeAddr); err == nil {
		t.Fatal("http proxy accepted")
	}
	r, err := New("socks5://warp:1080", []string{" .TheMovieDB.org. ", ""}, probeAddr)
	if err != nil || len(r.hosts) != 1 || r.hosts[0] != "themoviedb.org" {
		t.Fatalf("router %+v, err %v", r, err)
	}
}
