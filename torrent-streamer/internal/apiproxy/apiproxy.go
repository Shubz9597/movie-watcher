// Package apiproxy carries connections to chosen services through a SOCKS5
// proxy (TORWATCH_API_PROXY, e.g. socks5://warp:1080 for Cloudflare WARP).
//
// Some ISPs reset TLS connections to particular services. Measured on Airtel
// 2026-10-13, 15 connections each: TMDb connected 3 times directly and 14
// through WARP; OpenSubtitles 4 directly and 15 through WARP. Only hosts in
// TORWATCH_API_PROXY_HOSTS (default: TMDb and OpenSubtitles) use the proxy;
// everything else dials directly. When the proxy or its tunnel is down, or a
// proxied dial fails, those hosts are dialed directly, so a broken tunnel
// costs no more than having no proxy.
package apiproxy

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/proxy"
)

// DefaultHosts are reached through the proxy unless TORWATCH_API_PROXY_HOSTS
// names others. A host also covers its subdomains.
var DefaultHosts = []string{"themoviedb.org", "opensubtitles.com", "opensubtitles.org"}

const (
	checkInterval = 15 * time.Second
	checkTimeout  = 5 * time.Second
	// probeAddr is dialed THROUGH the proxy to prove the tunnel itself works,
	// not just the proxy's listening socket.
	probeAddr = "1.1.1.1:443"
)

// DialFunc is the shape of http.Transport.DialContext.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Router sends dials for its hosts through the proxy while it is healthy.
type Router struct {
	name    string // proxy host:port, for logs
	hosts   []string
	socks   proxy.ContextDialer
	healthy atomic.Bool
	checked atomic.Bool // the first check is always logged
	probe   string
}

var (
	configuredOnce sync.Once
	configured     *Router
)

// fromEnv returns the process-wide router, or nil when no proxy is set (or
// the setting is invalid, which is logged).
func fromEnv() *Router {
	configuredOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv("TORWATCH_API_PROXY"))
		if raw == "" {
			return
		}
		hosts := DefaultHosts
		if list := strings.TrimSpace(os.Getenv("TORWATCH_API_PROXY_HOSTS")); list != "" {
			hosts = strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ' ' })
		}
		router, err := New(raw, hosts, probeAddr)
		if err != nil {
			log.Printf("[api-proxy] disabled: %v", err)
			return
		}
		configured = router
		router.check()
		go router.monitor()
	})
	return configured
}

// New builds a router for socks5://host:port and the given hosts.
func New(raw string, hosts []string, probe string) (*Router, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "socks5" || parsed.Host == "" {
		return nil, fmt.Errorf("TORWATCH_API_PROXY must look like socks5://host:port")
	}
	var auth *proxy.Auth
	if parsed.User != nil {
		password, _ := parsed.User.Password()
		auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
	}
	socks, err := proxy.SOCKS5("tcp", parsed.Host, auth, &net.Dialer{Timeout: 10 * time.Second})
	if err != nil {
		return nil, err
	}
	contextDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("SOCKS5 dialer does not support contexts")
	}
	cleaned := make([]string, 0, len(hosts))
	for _, host := range hosts {
		if host = strings.ToLower(strings.Trim(strings.TrimSpace(host), ".")); host != "" {
			cleaned = append(cleaned, host)
		}
	}
	return &Router{name: parsed.Host, hosts: cleaned, socks: contextDialer, probe: probe}, nil
}

// Wrap returns a dial function that uses the configured proxy for its hosts
// and direct for everything else.
func Wrap(direct DialFunc) DialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return fromEnv().Dial(ctx, network, addr, direct)
	}
}

// Install routes a transport's dials (keeping its own dialer for direct). It
// also reads the configuration, so the first request does not wait for the
// tunnel check.
func Install(transport *http.Transport) {
	fromEnv()
	direct := transport.DialContext
	if direct == nil {
		direct = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	transport.DialContext = Wrap(direct)
}

// Dial connects to addr through the proxy when it routes addr's host and is
// healthy, otherwise (or when the proxied dial fails) directly. A nil
// router always dials directly.
func (r *Router) Dial(ctx context.Context, network, addr string, direct DialFunc) (net.Conn, error) {
	if r == nil || !r.routes(addr) || !r.healthy.Load() {
		return direct(ctx, network, addr)
	}
	conn, err := r.socks.DialContext(ctx, network, addr)
	if err == nil || ctx.Err() != nil {
		return conn, err
	}
	return direct(ctx, network, addr)
}

func (r *Router) routes(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, routed := range r.hosts {
		if host == routed || strings.HasSuffix(host, "."+routed) {
			return true
		}
	}
	return false
}

func (r *Router) monitor() {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for range ticker.C {
		r.check()
	}
}

// check probes the tunnel and logs every change between proxied and direct.
func (r *Router) check() {
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	conn, err := r.socks.DialContext(ctx, "tcp", r.probe)
	ok := err == nil
	if conn != nil {
		_ = conn.Close()
	}
	previous := r.healthy.Swap(ok)
	if first := !r.checked.Swap(true); first || previous != ok {
		if ok {
			log.Printf("[api-proxy] %s go through %s", strings.Join(r.hosts, ", "), r.name)
		} else {
			log.Printf("[api-proxy] %s unavailable, dialing %s directly: %v", r.name, strings.Join(r.hosts, ", "), err)
		}
	}
}
