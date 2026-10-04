package torrentx

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/proxy"
)

// Peer connections can go through a SOCKS5 proxy (TORRENT_PEER_PROXY, e.g.
// socks5://warp:1080 for Cloudflare WARP). Some ISPs throttle BitTorrent
// once they recognise it; through an encrypted tunnel the same swarm
// downloads many times faster (measured: 0.3–1.5 MB/s direct vs 3–20 MB/s
// over WARP). Only outgoing TCP peer connections use the proxy: DHT and
// tracker announces stay direct (UDP cannot cross a SOCKS5 CONNECT proxy and
// peer discovery is not throttled). If the proxy or its tunnel stops
// working, peers are dialed directly until it recovers, so torrents slow
// down but never stall.

const (
	peerProxyCheckInterval = 15 * time.Second
	peerProxyCheckTimeout  = 5 * time.Second
	// peerProxyProbeAddr is dialed THROUGH the proxy to prove the tunnel
	// itself works, not just the proxy's listening socket.
	peerProxyProbeAddr = "1.1.1.1:443"
)

type peerProxyDialer struct {
	name    string // proxy host:port, for logs
	socks   proxy.ContextDialer
	direct  net.Dialer
	healthy atomic.Bool
	checked atomic.Bool // the first check is always logged
	probe   string
}

var (
	peerProxyOnce sync.Once
	peerProxy     *peerProxyDialer
)

// configuredPeerProxy returns the process-wide peer dialer, or nil when no
// proxy is configured (or the setting is invalid, which is logged).
func configuredPeerProxy() *peerProxyDialer {
	peerProxyOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv("TORRENT_PEER_PROXY"))
		if raw == "" {
			return
		}
		dialer, err := newPeerProxyDialer(raw, peerProxyProbeAddr)
		if err != nil {
			log.Printf("[peer-proxy] disabled: %v", err)
			return
		}
		peerProxy = dialer
		dialer.check()
		go dialer.monitor()
	})
	return peerProxy
}

func newPeerProxyDialer(raw, probe string) (*peerProxyDialer, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "socks5" || parsed.Host == "" {
		return nil, fmt.Errorf("TORRENT_PEER_PROXY must look like socks5://host:port")
	}
	var auth *proxy.Auth
	if parsed.User != nil {
		password, _ := parsed.User.Password()
		auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
	}
	d := &peerProxyDialer{name: parsed.Host, probe: probe}
	socks, err := proxy.SOCKS5("tcp", parsed.Host, auth, &d.direct)
	if err != nil {
		return nil, err
	}
	contextDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("SOCKS5 dialer does not support contexts")
	}
	d.socks = contextDialer
	return d, nil
}

// DialerNetwork and Dial implement the torrent engine's peer dialer.
func (d *peerProxyDialer) DialerNetwork() string { return "tcp" }

func (d *peerProxyDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	if d.healthy.Load() {
		return d.socks.DialContext(ctx, "tcp", addr)
	}
	return d.direct.DialContext(ctx, "tcp", addr)
}

func (d *peerProxyDialer) monitor() {
	ticker := time.NewTicker(peerProxyCheckInterval)
	defer ticker.Stop()
	for range ticker.C {
		d.check()
	}
}

// check probes the tunnel and logs every change between proxied and direct.
func (d *peerProxyDialer) check() {
	ctx, cancel := context.WithTimeout(context.Background(), peerProxyCheckTimeout)
	defer cancel()
	conn, err := d.socks.DialContext(ctx, "tcp", d.probe)
	ok := err == nil
	if conn != nil {
		_ = conn.Close()
	}
	previous := d.healthy.Swap(ok)
	if first := !d.checked.Swap(true); first || previous != ok {
		if ok {
			log.Printf("[peer-proxy] peer connections go through %s", d.name)
		} else {
			log.Printf("[peer-proxy] %s unavailable, dialing peers directly: %v", d.name, err)
		}
	}
}
