package playback

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Resolver abstracts torrent access so the manager is testable without a
// torrent client. The production implementation resolves (cat, sourceID,
// fileIndex) through the torrent client and returns fresh readers.
type Resolver interface {
	// Resolve must validate the category and source identifier and return a
	// bounded reader factory plus sanitized display name and size. It must
	// never leak paths, magnets, or credentials in returned values or errors.
	Resolve(ctx context.Context, cat, sourceID string, fileIndex int) (ResolvedSource, error)
}

type ResolvedSource struct {
	Open func() (io.ReadSeekCloser, error)
	Name string // sanitized display name (no path)
	Size int64
	// Sidecars are embedded subtitle sidecar files for the selected video.
	Sidecars []Sidecar
}

type Sidecar struct {
	Open     func() (io.ReadCloser, error)
	Format   string // srt, vtt, ass, ssa
	Language string
	Label    string
}

// Config bounds the service.
type Config struct {
	DataRoot            string        // session data root; cleanup NEVER escapes it
	MaxActiveTranscodes int           // default 1
	SessionTTL          time.Duration // default 2h
	ProbeTimeout        time.Duration // default 20s
	MaxTranscodeHeight  int           // default 1080
	MaxSessions         int           // default 8; bounded memory/disk surface
	// TranscodeDisabled reflects the deployment policy (Radxa): refuse
	// automatic video transcoding instead of starting it. Direct and remux
	// (stream copy) decisions are unaffected. Default false (allowed).
	TranscodeDisabled bool
}

func (c *Config) withDefaults() {
	if c.MaxActiveTranscodes <= 0 {
		c.MaxActiveTranscodes = 1
	}
	if c.SessionTTL <= 0 {
		c.SessionTTL = 2 * time.Hour
	}
	if c.ProbeTimeout <= 0 {
		c.ProbeTimeout = 20 * time.Second
	}
	if c.MaxTranscodeHeight <= 0 {
		c.MaxTranscodeHeight = 1080
	}
	if c.MaxSessions <= 0 {
		c.MaxSessions = 8
	}
}

// SessionView is the API-facing session representation. Opaque IDs only.
type SessionView struct {
	SessionID   string          `json:"sessionId"`
	Mode        Mode            `json:"mode"`
	ReasonCode  string          `json:"reasonCode"`
	Message     string          `json:"message"`
	PlaybackURL string          `json:"playbackUrl"`
	Info        *MediaInfo      `json:"media,omitempty"`
	Subtitles   []SubtitleOffer `json:"subtitles"`
	ExpiresAt   time.Time       `json:"expiresAt"`
	Profile     string          `json:"profile"`
}

// SubtitleOffer is one selectable WebVTT track. URLs are opaque and
// session-scoped.
type SubtitleOffer struct {
	ID       string `json:"id"`
	Language string `json:"language,omitempty"`
	Label    string `json:"label,omitempty"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
	URL      string `json:"url"`
	Origin   string `json:"origin"` // "embedded-sidecar" | "external" | "container-stream"
}

type session struct {
	id         string
	token      string // media-source token
	view       SessionView
	decision   Decision
	dir        string // under DataRoot; removed with the session only
	runner     sessionRunner
	hls        bool // true when playbackUrl is the HLS master playlist
	expires    time.Time
	cancel     context.CancelFunc
	createdDir bool
	slotOnce   sync.Once
	holdsSlot  bool
	// Direct-mode media serving (opaque; reader factory only, no paths).
	openMedia func() (io.ReadSeekCloser, error)
	mediaName string
}

// Manager owns the session lifecycle.
type Manager struct {
	cfg       Config
	prober    Prober
	newRunner func() sessionRunner
	tools     Tools
	resolver  Resolver
	source    *MediaSource

	mu         sync.Mutex
	sessions   map[string]*session
	transcodes chan struct{} // bounded concurrency semaphore
	stopped    bool
}

// NewManager wires the service. Call StartCleanup and Stop from the host.
func NewManager(cfg Config, tools Tools, prober Prober, resolver Resolver, source *MediaSource) *Manager {
	cfg.withDefaults()
	return &Manager{
		cfg:        cfg,
		prober:     prober,
		tools:      tools,
		resolver:   resolver,
		source:     source,
		sessions:   map[string]*session{},
		newRunner:  func() sessionRunner { return &Runner{FFmpegPath: tools.FFmpegPath} },
		transcodes: make(chan struct{}, cfg.MaxActiveTranscodes),
	}
}

// Ready reports whether the complete configured service is functional. The
// capability MUST NOT be advertised when this returns false.
func (m *Manager) Ready(ctx context.Context) (bool, string) {
	if m == nil || m.source == nil || m.resolver == nil {
		return false, "playback service not wired"
	}
	return m.tools.Available(ctx)
}

// Create validates input, inspects the media, plans playback, and (for
// remux/transcode) starts the bounded FFmpeg process. Planning NEVER starts
// playback on a client device; it only prepares server resources.
func (m *Manager) Create(ctx context.Context, cat, sourceID string, fileIndex int, profileName string) (*SessionView, error) {
	profile, ok := DefaultProfiles()[profileName]
	if !ok {
		return nil, &Error{Code: "invalid_request", Message: "Unknown capability profile."}
	}
	if strings.TrimSpace(sourceID) == "" {
		return nil, &Error{Code: "invalid_request", Message: "A source identifier is required."}
	}
	if fileIndex < 0 {
		return nil, &Error{Code: "invalid_request", Message: "The file index must not be negative."}
	}
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return nil, &Error{Code: "unavailable", Message: "The playback service is stopping."}
	}
	if len(m.sessions) >= m.cfg.MaxSessions {
		m.mu.Unlock()
		return nil, &Error{Code: ReasonSessionLimit, Message: "Too many active playback sessions; stop one and retry."}
	}
	m.mu.Unlock()

	resolved, err := m.resolver.Resolve(ctx, cat, sourceID, fileIndex)
	if err != nil {
		return nil, err // resolver errors are already bounded and redacted
	}

	// Issue the loopback token for THIS session before probing. The source
	// entry expires with the session TTL and is revoked on delete.
	token, srcURL, err := m.source.Issue(resolved.Open, resolved.Name, resolved.Size, m.cfg.SessionTTL)
	if err != nil {
		return nil, &Error{Code: "internal", Message: "Could not allocate session resources."}
	}

	prober := m.prober
	if fp, ok := prober.(*FFprobeProber); ok {
		fpCopy := *fp
		fpCopy.Timeout = m.cfg.ProbeTimeout
		prober = &fpCopy
	}
	info, err := prober.Probe(ctx, srcURL)
	if err != nil {
		m.source.Revoke(token)
		return nil, &Error{Code: ReasonMediaInspectionFail, Message: "The selected source could not be inspected. It may be corrupt, empty, or still downloading."}
	}
	info.FileIndex = fileIndex

	// The planner trusts the CONFIGURED toolchain; actual executable
	// verification happens once at wiring time (capability advertisement)
	// and per-process at runner start. This keeps session creation cheap.
	ffmpegReady := m.tools.FFmpegPath != ""
	decision := Plan(PlanInput{
		Info:               info,
		Profile:            profile,
		FFmpegReady:        ffmpegReady,
		MaxTranscodeHeight: m.cfg.MaxTranscodeHeight,
		TranscodeAllowed:   !m.cfg.TranscodeDisabled,
	})

	if decision.Mode == ModeTranscode || decision.Mode == ModeRemux {
		select {
		case m.transcodes <- struct{}{}:
		default:
			m.source.Revoke(token)
			return nil, &Error{Code: ReasonCapacityExhausted, Message: "The server is already converting another source (bounded to one conversion at a time). Try again shortly."}
		}
	}

	id, err := randomToken()
	if err != nil {
		m.releaseSlot(decision)
		m.source.Revoke(token)
		return nil, &Error{Code: "internal", Message: "Could not allocate session resources."}
	}
	dir, err := m.sessionDir(id)
	if err != nil {
		m.releaseSlot(decision)
		m.source.Revoke(token)
		return nil, err
	}

	sess := &session{
		id:         id,
		token:      token,
		decision:   decision,
		dir:        dir,
		runner:     m.newRunner(),
		expires:    time.Now().Add(m.cfg.SessionTTL),
		createdDir: true,
		holdsSlot:  decision.Mode == ModeRemux || decision.Mode == ModeTranscode,
	}
	sess.view = SessionView{
		SessionID:  id,
		Mode:       decision.Mode,
		ReasonCode: decision.ReasonCode,
		Message:    decision.Message,
		Info:       info,
		ExpiresAt:  sess.expires,
		Profile:    profile.Name,
	}

	if decision.Mode == ModeRemux || decision.Mode == ModeTranscode {
		runCtx, cancel := context.WithCancel(context.Background())
		sess.cancel = cancel
		if err := sess.runner.Start(runCtx, srcURL, decision, dir); err != nil {
			cancel()
			m.destroy(sess)
			return nil, &Error{Code: "internal", Message: "The conversion process could not be started."}
		}
		sess.hls = true
		sess.view.PlaybackURL = "/v2/playback/sessions/" + id + "/master.m3u8"
		go func() {
			<-sess.runner.Done()
			m.releaseSessionSlot(sess)
		}()
	} else if decision.Mode == ModeDirect {
		sess.openMedia = resolved.Open
		sess.mediaName = resolved.Name
		sess.view.PlaybackURL = "/v2/playback/sessions/" + id + "/media"
	} else { // unsupported
		m.source.Revoke(token)
		sess.token = ""
	}

	// Subtitles: embedded sidecars only for this milestone's session offers;
	// container-internal streams are extracted for HLS sessions when present.
	sess.view.Subtitles = m.collectSubtitles(ctx, sess, resolved, info, srcURL)

	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		m.destroy(sess)
		return nil, &Error{Code: "unavailable", Message: "The playback service is stopping."}
	}
	if len(m.sessions) >= m.cfg.MaxSessions {
		m.mu.Unlock()
		m.destroy(sess)
		return nil, &Error{Code: ReasonSessionLimit, Message: "Too many active playback sessions; stop one and retry."}
	}
	m.sessions[id] = sess
	m.mu.Unlock()
	view := sess.view
	return &view, nil
}

// releaseSlot is a no-op for unsupported sessions; conversion slots are held
// for the lifetime of remux/transcode sessions and released by Cleanup.
func (m *Manager) releaseSlot(d Decision) {
	if d.Mode == ModeRemux || d.Mode == ModeTranscode {
		<-m.transcodes
	}
}

func (m *Manager) releaseSessionSlot(sess *session) {
	if !sess.holdsSlot {
		return
	}
	sess.slotOnce.Do(func() { <-m.transcodes })
}

// Get returns the current view of a session (expired/unknown → not found).
func (m *Manager) Get(id string) (*SessionView, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sess, ok := m.sessions[id]
	if !ok || time.Now().After(sess.expires) {
		return nil, false
	}
	view := sess.view
	return &view, true
}

// Lookup resolves a session for internal serving (media/HLS/subtitles).
func (m *Manager) Lookup(id string) (*session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sess, ok := m.sessions[id]
	if !ok || time.Now().After(sess.expires) {
		return nil, false
	}
	return sess, true
}

// Delete stops the session's processes, revokes its token, and removes ONLY
// its directory under the configured root.
func (m *Manager) Delete(id string) bool {
	m.mu.Lock()
	sess, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return false
	}
	return m.destroy(sess)
}

func (m *Manager) destroy(sess *session) bool {
	if sess.cancel != nil {
		sess.cancel()
	}
	sess.runner.Stop()
	if sess.token != "" {
		m.source.Revoke(sess.token)
	}
	// Release the conversion slot if this session held one.
	m.releaseSessionSlot(sess)
	if sess.createdDir {
		removeSessionDir(m.cfg.DataRoot, sess.dir)
	}
	return true
}

// sessionDir creates <root>/<sessionID>; the root boundary is enforced.
func (m *Manager) sessionDir(id string) (string, error) {
	root, err := filepath.Abs(m.cfg.DataRoot)
	if err != nil {
		return "", &Error{Code: "internal", Message: "Playback storage is misconfigured."}
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", &Error{Code: "internal", Message: "Playback storage is unavailable."}
	}
	dir, err := safeJoin(root, id)
	if err != nil {
		return "", &Error{Code: "invalid_request", Message: "Invalid session identifier."}
	}
	if _, err := os.Stat(dir); err == nil {
		// Collision of a 256-bit random ID is practically impossible; treat
		// it as a hard error rather than reusing another session's dir.
		return "", &Error{Code: "internal", Message: "Could not allocate session resources."}
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		return "", &Error{Code: "internal", Message: "Could not allocate session resources."}
	}
	return dir, nil
}

// safeJoin refuses any candidate that escapes root (traversal defense).
func safeJoin(root, relative string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(relative))
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "..") {
		return "", fmt.Errorf("path escapes the playback data root")
	}
	candidate := filepath.Clean(filepath.Join(root, cleaned))
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes the playback data root")
	}
	return candidate, nil
}

// removeSessionDir deletes exactly one session directory. The directory MUST
// be a direct child of root (defensive check; never deletes anything else).
func removeSessionDir(root, dir string) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	parent := filepath.Dir(absDir)
	if parent != absRoot {
		return // refuse: not a direct child of the configured root
	}
	_ = os.RemoveAll(absDir)
}

// CleanupSweeper expires sessions whose TTL passed. Returns removed IDs.
func (m *Manager) CleanupSweeper() []string {
	now := time.Now()
	m.mu.Lock()
	var expired []string
	var doomed []*session
	for id, sess := range m.sessions {
		if now.After(sess.expires) {
			expired = append(expired, id)
			doomed = append(doomed, sess)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, sess := range doomed {
		m.destroy(sess)
	}
	return expired
}

// SweepStaleAtStartup removes session directories left by a previous process
// (sessions do not survive restarts). Deterministic: ANY directory under the
// root at startup is stale, because the registry starts empty.
func (m *Manager) SweepStaleAtStartup() {
	root, err := filepath.Abs(m.cfg.DataRoot)
	if err != nil {
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return
		}
		_ = os.MkdirAll(root, 0o755)
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}

// Stop tears the whole service down (host shutdown).
func (m *Manager) Stop() {
	m.mu.Lock()
	m.stopped = true
	all := make([]*session, 0, len(m.sessions))
	for _, sess := range m.sessions {
		all = append(all, sess)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	for _, sess := range all {
		m.destroy(sess)
	}
}

// Error is the bounded service error consumed by the HTTP layer.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// --- Exported accessors for the HTTP layer (session fields stay private) ---

// HasHLS reports whether the session carries an HLS rendition.
func (s *session) HasHLS() bool { return s.hls }

// MediaOpen returns a fresh reader for the direct rendition, or nil when the
// session has none.
func (s *session) MediaOpen() func() (io.ReadSeekCloser, error) { return s.openMedia }

// MediaName is the sanitized direct-rendition display name.
func (s *session) MediaName() string { return s.mediaName }
