package watch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
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
	mu         sync.Mutex
	entries    map[string]*entry // key.String() -> entry
	leaseToKey map[string]string // leaseID -> key.String()
	Ensure     func(Key) error   // provided by main
	Stop       func(Key)         // provided by main
	staleAfter time.Duration
	tickerIntv time.Duration
	stopCh     chan struct{}
}

type entry struct {
	key      Key
	leases   map[string]time.Time // leaseID -> lastSeen
	lastSeen time.Time            // latest among leases (cached)
}

func NewManager(staleAfter, tickerIntv time.Duration, ensure func(Key) error, stop func(Key)) *Manager {
	m := &Manager{
		entries:    make(map[string]*entry),
		leaseToKey: make(map[string]string),
		Ensure:     ensure,
		Stop:       stop,
		staleAfter: staleAfter,
		tickerIntv: tickerIntv,
		stopCh:     make(chan struct{}),
	}
	go m.reaper()
	return m
}

func (m *Manager) Shutdown() { close(m.stopCh) }

func (m *Manager) reaper() {
	t := time.NewTicker(m.tickerIntv)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			now := time.Now()
			var toStop []Key
			m.mu.Lock()
			for ks, e := range m.entries {
				// prune stale leases
				for id, seen := range e.leases {
					if now.Sub(seen) > m.staleAfter {
						delete(e.leases, id)
						delete(m.leaseToKey, id)
					}
				}
				// recompute lastSeen
				e.lastSeen = time.Time{}
				for _, seen := range e.leases {
					if seen.After(e.lastSeen) {
						e.lastSeen = seen
					}
				}
				// if no leases or too stale -> stop
				if len(e.leases) == 0 || (now.Sub(e.lastSeen) > m.staleAfter) {
					toStop = append(toStop, e.key)
					delete(m.entries, ks)
				}
			}
			m.mu.Unlock()

			for _, k := range toStop {
				log.Printf("[watch] reaper: stopping %s (all leases expired or closed)", k.String())
				// stop outside the lock
				safely(func() { m.Stop(k) })
			}
		case <-m.stopCh:
			return
		}
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

// --- Public methods used by HTTP handlers ---

func (m *Manager) Open(_ context.Context, k Key) (leaseID string, err error) {
	if m.Ensure != nil {
		if err = m.Ensure(k); err != nil {
			log.Printf("[watch] Open: Ensure failed for %s: %v", k.String(), err)
			return "", err
		}
	}
	id := genID()
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	ks := k.String()
	e := m.entries[ks]
	if e == nil {
		e = &entry{key: k, leases: make(map[string]time.Time), lastSeen: now}
		m.entries[ks] = e
		log.Printf("[watch] Open: created new entry for %s", ks)
	}
	e.leases[id] = now
	e.lastSeen = now
	m.leaseToKey[id] = ks
	log.Printf("[watch] Open: created lease %s for %s (total leases: %d)", id[:8], ks, len(e.leases))
	return id, nil
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
		e.leases[leaseID] = now
		if now.After(e.lastSeen) {
			e.lastSeen = now
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

func (m *Manager) HandleOpen(w http.ResponseWriter, r *http.Request) {
	k, err := KeyFromRequest(r)
	if err != nil || k.ID == "" {
		http.Error(w, "bad key", http.StatusBadRequest)
		return
	}
	lease, err := m.Open(r.Context(), k)
	if err != nil {
		http.Error(w, "ensure failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"leaseId": lease})
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
