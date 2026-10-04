package torrentx

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
)

// fakeSOCKS5 is a minimal no-auth SOCKS5 CONNECT proxy that counts tunnels.
func fakeSOCKS5(t *testing.T) (addr string, tunnels *atomic.Int32, stop func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tunnels = &atomic.Int32{}
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer client.Close()
				header := make([]byte, 2)
				if _, err := io.ReadFull(client, header); err != nil {
					return
				}
				if _, err := io.ReadFull(client, make([]byte, header[1])); err != nil {
					return
				}
				_, _ = client.Write([]byte{5, 0})
				request := make([]byte, 4)
				if _, err := io.ReadFull(client, request); err != nil || request[3] != 1 {
					return // the test only dials IPv4 literals
				}
				target := make([]byte, 6)
				if _, err := io.ReadFull(client, target); err != nil {
					return
				}
				address := net.JoinHostPort(net.IP(target[:4]).String(), strconv.Itoa(int(binary.BigEndian.Uint16(target[4:]))))
				upstream, err := net.Dial("tcp", address)
				if err != nil {
					_, _ = client.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer upstream.Close()
				tunnels.Add(1)
				_, _ = client.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				go func() { _, _ = io.Copy(upstream, client) }()
				_, _ = io.Copy(client, upstream)
			}()
		}
	}()
	return listener.Addr().String(), tunnels, func() { _ = listener.Close() }
}

func echoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return listener.Addr().String()
}

func roundTrip(t *testing.T, conn net.Conn) {
	t.Helper()
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(conn, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("reply %q, %v", reply, err)
	}
}

func TestPeerProxyDialsThroughTunnelAndFallsBackWhenItDies(t *testing.T) {
	peer := echoServer(t)
	proxyAddr, tunnels, stop := fakeSOCKS5(t)
	dialer, err := newPeerProxyDialer("socks5://"+proxyAddr, peer)
	if err != nil {
		t.Fatal(err)
	}
	dialer.check()
	if !dialer.healthy.Load() {
		t.Fatal("a working tunnel must be used")
	}
	before := tunnels.Load()
	conn, err := dialer.Dial(context.Background(), peer)
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, conn)
	if tunnels.Load() != before+1 {
		t.Fatal("the peer connection must go through the proxy")
	}

	stop()
	dialer.check()
	if dialer.healthy.Load() {
		t.Fatal("a dead proxy must be detected")
	}
	conn, err = dialer.Dial(context.Background(), peer)
	if err != nil {
		t.Fatalf("peers must still be dialed directly: %v", err)
	}
	roundTrip(t, conn)
}

func TestPeerProxyRejectsUnsupportedSettings(t *testing.T) {
	for _, raw := range []string{"http://warp:1080", "socks5://", "warp:1080"} {
		if _, err := newPeerProxyDialer(raw, "1.1.1.1:443"); err == nil {
			t.Errorf("%q must be rejected", raw)
		}
	}
}
