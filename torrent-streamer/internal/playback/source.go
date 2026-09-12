package playback

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// MediaSource serves ONE torrent file to internal consumers (ffprobe, ffmpeg)
// over a loopback-only HTTP listener. It is the safe internal-source
// mechanism that keeps magnet URIs off process command lines:
//
// Threat boundary (documented for the contract):
//   - The listener binds 127.0.0.1 on an EPHEMERAL port; it is never exposed
//     to the network or the tailnet.
//   - Access requires a 256-bit cryptographically random path token that is
//     issued per session, expires with the session, and is revoked on delete.
//   - The token maps to (category, infoHash, fileIndex) inside the process
//     only; no magnet, path, or metadata is derivable from the URL.
//   - Only the backend process and its short-lived child processes (ffprobe,
//     ffmpeg) are expected to know the token; host-local processes could
//     technically observe it (same-user threat model), which is strictly
//     narrower than putting magnets in argv (visible to ANY host process).
type MediaSource struct {
	mu       sync.Mutex
	server   *http.Server
	listener net.Listener
	entries  map[string]*sourceEntry
}

type sourceEntry struct {
	open    func() (io.ReadSeekCloser, error)
	name    string
	size    int64
	expires time.Time
}

// NewMediaSource starts the loopback listener. The zero value is not usable;
// call Start.
func NewMediaSource() (*MediaSource, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ms := &MediaSource{
		listener: listener,
		entries:  map[string]*sourceEntry{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /f/", ms.handle)
	ms.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := ms.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[playback] media source server stopped: %v", err)
		}
	}()
	return ms, nil
}

// Port is the ephemeral loopback port the source listens on.
func (ms *MediaSource) Port() int { return ms.listener.Addr().(*net.TCPAddr).Port }

// Close shuts the listener down and revokes all tokens.
func (ms *MediaSource) Close() error {
	ms.mu.Lock()
	ms.entries = map[string]*sourceEntry{}
	ms.mu.Unlock()
	return ms.server.Close()
}

// Issue registers a readable file under a fresh opaque token and returns the
// token plus the internal URL. open must return a fresh ReadSeekCloser per
// request.
func (ms *MediaSource) Issue(open func() (io.ReadSeekCloser, error), name string, size int64, ttl time.Duration) (string, string, error) {
	token, err := randomToken()
	if err != nil {
		return "", "", err
	}
	ms.mu.Lock()
	ms.entries[token] = &sourceEntry{open: open, name: name, size: size, expires: time.Now().Add(ttl)}
	ms.mu.Unlock()
	return token, fmt.Sprintf("http://127.0.0.1:%d/f/%s", ms.Port(), token), nil
}

// Revoke removes one token (session delete / expiry).
func (ms *MediaSource) Revoke(token string) {
	ms.mu.Lock()
	delete(ms.entries, token)
	ms.mu.Unlock()
}

func (ms *MediaSource) handle(w http.ResponseWriter, r *http.Request) {
	token := lenPathToken(r.URL.Path)
	if token == "" {
		http.NotFound(w, r)
		return
	}
	ms.mu.Lock()
	entry, ok := ms.entries[token]
	if ok && time.Now().After(entry.expires) {
		delete(ms.entries, token)
		ok = false
	}
	ms.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	reader, err := entry.open()
	if err != nil {
		// Generic message only: no token echo, no path, no magnet.
		http.Error(w, "media source unavailable", http.StatusServiceUnavailable)
		return
	}
	defer reader.Close()
	// ServeContent provides Range/partial-content semantics for ffprobe and
	// ffmpeg seeking. The name is sanitized and carries no path.
	http.ServeContent(w, r, entry.name, time.Time{}, reader)
}

func lenPathToken(path string) string {
	const prefix = "/f/"
	if len(path) <= len(prefix) {
		return ""
	}
	return path[len(prefix):]
}

// randomToken returns a 256-bit hex token (opaque session/source identifier).
func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
