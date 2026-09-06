package watch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
Generic lease manager. You provide:
  - Ensure(key) error  // start/ensure the torrent for this key
  - Stop(key)          // stop/tear down torrent when no active leases
You DO NOT need to import anacrolix here; your main code knows how to start/stop.
*/

type Key struct {
	Cat       string // movie|tv|anime (or bucket)
	ID        string // prefer infoHash (uppercase hex). Fallback: magnet/src
	FileIndex int    // which file in torrent (-1 if unknown)
}

func (k Key) String() string {
	return k.Cat + "|" + k.ID + "|" + strconv.Itoa(k.FileIndex)
}

type Manager struct {
	mu              sync.Mutex
	entries         map[string]*entry // key.String() -> entry
	leaseToKey      map[string]string // leaseID -> key.String()
	Ensure          func(Key) error   // provided by main
	Stop            func(Key)         // provided by main
	maxActiveTitles int
	staleAfter      time.Duration
	tickerIntv      time.Duration
	stopCh          chan struct{}
	doneCh          chan struct{}
	// capacityRetryAfter is the retry guidance returned with
	// capacity_exceeded denials (default 30 s, aligned with the reaper).
	capacityRetryAfter time.Duration
}

type leaseInfo struct {
	ClientID  string
	SessionID string
	LastSeen  time.Time
}

type entry struct {
	key    Key
	leases map[string]*leaseInfo // leaseID -> info
	// Non-nil while setup or teardown runs outside the manager lock.
	pending chan struct{}
	err     error // setup outcome, published by closing pending
}

var ErrCapacityExceeded = errors.New("watch: capacity exceeded")

// AdmissionSnapshot counts reservations, active resources, and resources
// still being stopped. It never exposes resource or client identifiers.
type AdmissionSnapshot struct {
	ActiveKeys int `json:"activeKeys"`
	Limit      int `json:"limit"`
}

func (m *Manager) SetMaxActiveTitles(limit int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.maxActiveTitles = max(0, limit)
}

func (m *Manager) AdmissionSnapshot() AdmissionSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return AdmissionSnapshot{ActiveKeys: len(m.entries), Limit: m.maxActiveTitles}
}

func NewManager(staleAfter, tickerIntv time.Duration, ensure func(Key) error, stop func(Key)) *Manager {
	m := &Manager{
		entries:            make(map[string]*entry),
		leaseToKey:         make(map[string]string),
		Ensure:             ensure,
		Stop:               stop,
		staleAfter:         staleAfter,
		tickerIntv:         tickerIntv,
		stopCh:             make(chan struct{}),
		doneCh:             make(chan struct{}),
		capacityRetryAfter: 30 * time.Second,
	}
	go m.reaper()
	return m
}

// SetCapacityRetryAfter overrides the capacity_exceeded retry guidance.
func (m *Manager) SetCapacityRetryAfter(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d > 0 {
		m.capacityRetryAfter = d
	}
}

func (m *Manager) Shutdown() {
	close(m.stopCh)
	<-m.doneCh
}

func (m *Manager) reaper() {
	defer close(m.doneCh)
	t := time.NewTicker(m.tickerIntv)
	defer t.Stop()
	for {
		select {
		case now := <-t.C:
			m.reap(now)
		case <-m.stopCh:
			return
		}
	}
}

func (m *Manager) reap(now time.Time) {
	var toStop []*entry
	m.mu.Lock()
	for _, e := range m.entries {
		if e.pending != nil {
			continue
		}
		for id, info := range e.leases {
			if now.Sub(info.LastSeen) > m.staleAfter {
				delete(e.leases, id)
				delete(m.leaseToKey, id)
			}
		}
		if len(e.leases) == 0 {
			e.pending = make(chan struct{})
			toStop = append(toStop, e)
		}
	}
	m.mu.Unlock()
	for _, e := range toStop {
		if m.Stop != nil {
			safely(func() { m.Stop(e.key) })
		}
		m.mu.Lock()
		delete(m.entries, e.key.String())
		close(e.pending)
		m.mu.Unlock()
	}
}

func safely(fn func()) {
	defer func() { _ = recover() }()
	fn()
}

func genID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Parse Key from request (query or JSON body)
func KeyFromRequest(r *http.Request) (Key, error) {
	q := r.URL.Query()

	cat := q.Get("cat")
	if cat == "" {
		cat = "movie"
	}
	id := q.Get("infoHash")
	if id == "" {
		id = q.Get("magnet")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		// try JSON body
		var b struct {
			Cat       string `json:"cat"`
			InfoHash  string `json:"infoHash"`
			Magnet    string `json:"magnet"`
			FileIndex int    `json:"fileIndex"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Cat != "" {
			cat = b.Cat
		}
		if b.InfoHash != "" {
			id = b.InfoHash
		} else if b.Magnet != "" {
			id = b.Magnet
		}
		if b.FileIndex != 0 {
			// if omitted, remains 0, ok
		}
		if r.Body != nil {
			_ = r.Body.Close()
		}
		q = r.URL.Query()
	}

	fi := -1
	if s := q.Get("fileIndex"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			fi = v
		}
	}
	// If body had fileIndex and query didn’t
	if fi == -1 && r.Body == nil {
		// noop
	}

	// If ID is a magnet URL, extract the infoHash
	if strings.HasPrefix(id, "magnet:") {
		// Try to extract infoHash from magnet URI
		if strings.Contains(id, "xt=urn:btih:") {
			parts := strings.Split(id, "xt=urn:btih:")
			if len(parts) > 1 {
				hashPart := parts[1]
				// Remove any trailing & or other parameters
				if idx := strings.IndexAny(hashPart, "&"); idx > 0 {
					hashPart = hashPart[:idx]
				}
				// Remove any URL encoding
				hashPart = strings.TrimSpace(hashPart)
				if len(hashPart) == 40 {
					id = strings.ToUpper(hashPart)
				} else if len(hashPart) == 32 {
					// Base32 encoded, convert to hex (simplified - just use as-is for now)
					id = strings.ToUpper(hashPart)
				}
			}
		}
	}

	// Normalize infoHash to upper-case hex if it looks like one
	if len(id) == 40 && strings.IndexFunc(id, func(r rune) bool { return !isHex(r) }) == -1 {
		id = strings.ToUpper(id)
	}

	return Key{Cat: cat, ID: id, FileIndex: fi}, nil
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// LeaseOptions carries the optional V2 lease metadata: the client-generated
// opaque UUID and the correlating stream session id. Both are untrusted
// input, validated for format/length only (FR-013) — never authentication.
type LeaseOptions struct {
	ClientID  string
	SessionID string
}

// ActiveLeasesFor returns how many leases currently hold the key
// (observability for the /watch/open response, T055).
func (m *Manager) ActiveLeasesFor(k Key) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.entries[k.String()]; ok {
		return len(e.leases)
	}
	return 0
}

// --- Public methods used by HTTP handlers ---

func (m *Manager) Open(ctx context.Context, k Key, opts LeaseOptions) (leaseID string, err error) {
	ks := k.String()
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		m.mu.Lock()
		e := m.entries[ks]
		if e != nil && e.pending != nil {
			pending := e.pending
			m.mu.Unlock()
			select {
			case <-pending:
				if e.err != nil {
					return "", e.err
				}
				continue
			case <-ctx.Done():
				return "", ctx.Err()
			case <-m.stopCh:
				return "", context.Canceled
			}
		}
		if e == nil {
			if m.maxActiveTitles > 0 && len(m.entries) >= m.maxActiveTitles {
				m.mu.Unlock()
				return "", ErrCapacityExceeded
			}
			e = &entry{key: k, leases: make(map[string]*leaseInfo), pending: make(chan struct{})}
			m.entries[ks] = e
			m.mu.Unlock()
			if m.Ensure != nil {
				err = m.Ensure(k)
			}
			m.mu.Lock()
			e.err = err
			close(e.pending)
			e.pending = nil
			if err != nil {
				delete(m.entries, ks)
				m.mu.Unlock()
				return "", err
			}
		}
		id := genID()
		e.leases[id] = &leaseInfo{ClientID: opts.ClientID, SessionID: opts.SessionID, LastSeen: time.Now()}
		m.leaseToKey[id] = ks
		m.mu.Unlock()
		return id, nil
	}
}

func (m *Manager) Ping(_ context.Context, leaseID string) bool {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	ks, ok := m.leaseToKey[leaseID]
	if !ok {
		log.Printf("[watch] Ping: unknown lease %s", leaseID[:8])
		return false
	}
	if e, ok := m.entries[ks]; ok {
		if info, ok := e.leases[leaseID]; ok {
			info.LastSeen = now
		}
		return true
	}
	log.Printf("[watch] Ping: lease %s has key %s but no entry", leaseID[:8], ks)
	return false
}

func (m *Manager) Close(_ context.Context, leaseID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	ks, ok := m.leaseToKey[leaseID]
	if !ok {
		return false
	}
	delete(m.leaseToKey, leaseID)
	e, ok := m.entries[ks]
	if !ok {
		return false
	}
	delete(e.leases, leaseID)
	// if empty, let reaper stop soon; we don’t stop here to allow quick tab reloads
	return true
}

// --- HTTP handlers ---

// clientIDPattern validates the client-generated opaque UUID (format/length
// only — FR-013); it is never authentication.
var clientIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// HandleOpen adds a lease for a resource key. Optional V2 fields:
// clientId (client-generated UUID, format-validated) and sessionId
// (opaque correlation id, length-validated). Response gains the additive
// activeLeases observability field (contracts/leases-and-progress.md).
func (m *Manager) HandleOpen(w http.ResponseWriter, r *http.Request) {
	k, err := KeyFromRequest(r)
	if err != nil || k.ID == "" {
		http.Error(w, "bad key", http.StatusBadRequest)
		return
	}
	opts := LeaseOptions{ClientID: strings.TrimSpace(r.URL.Query().Get("clientId")), SessionID: strings.TrimSpace(r.URL.Query().Get("sessionId"))}
	if opts.ClientID != "" && !clientIDPattern.MatchString(opts.ClientID) {
		http.Error(w, "invalid clientId", http.StatusBadRequest)
		return
	}
	if len(opts.SessionID) > 64 {
		http.Error(w, "invalid sessionId", http.StatusBadRequest)
		return
	}
	lease, err := m.Open(r.Context(), k, opts)
	if err != nil {
		if errors.Is(err, ErrCapacityExceeded) {
			m.mu.Lock()
			retryAfter := m.capacityRetryAfter
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":              "capacity_exceeded",
					"message":           "the maximum number of concurrent distinct titles is in use; try again shortly",
					"retryAfterSeconds": int(retryAfter.Seconds()),
				},
			})
			return
		}
		http.Error(w, "ensure failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"leaseId": lease, "activeLeases": m.ActiveLeasesFor(k)})
}

func (m *Manager) HandlePing(w http.ResponseWriter, r *http.Request) {
	lease := r.URL.Query().Get("leaseId")
	if lease == "" && r.Method == http.MethodPost {
		// support JSON body or sendBeacon body
		var b struct {
			LeaseId string `json:"leaseId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		lease = b.LeaseId
	}
	if lease == "" {
		log.Printf("[watch] Ping: missing leaseId from %s %s", r.Method, r.URL.String())
		http.Error(w, "missing leaseId", http.StatusBadRequest)
		return
	}
	if ok := m.Ping(r.Context(), lease); !ok {
		log.Printf("[watch] Ping: unknown lease %s", lease[:8])
		http.Error(w, "unknown lease", http.StatusNotFound)
		return
	}
	log.Printf("[watch] Ping: success for lease %s", lease[:8])
	w.WriteHeader(http.StatusNoContent)
}

func (m *Manager) HandleClose(w http.ResponseWriter, r *http.Request) {
	lease := r.URL.Query().Get("leaseId")
	if lease == "" {
		// handle sendBeacon (body is small blob)
		if r.Body != nil {
			defer r.Body.Close()
			var buf [128]byte
			n, _ := r.Body.Read(buf[:])
			data := string(buf[:n])
			// accept either raw leaseId or urlencoded "leaseId=..."
			if strings.HasPrefix(data, "leaseId=") {
				lease = strings.TrimPrefix(data, "leaseId=")
			} else {
				lease = strings.TrimSpace(data)
			}
		}
	}
	if lease == "" {
		http.Error(w, "missing leaseId", http.StatusBadRequest)
		return
	}
	_ = m.Close(r.Context(), lease)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
