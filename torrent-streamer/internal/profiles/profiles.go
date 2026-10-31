// Package profiles: "Who's watching?" profiles. Each profile has its own
// watch progress, Continue Watching, watched marks, library and
// recommendations; a device picks one (migrations/017_profiles.sql).
//
// Requests are mapped to a profile by the device id they already carry
// (clientId / subjectId): the app, the phone's native player and the
// downloader need no other change. A device that never picked a profile
// uses the first one, 'household'.
//
// Who may manage profiles comes from Tailscale: Tailscale Serve names the
// tailnet user of every request (Tailscale-User-Login). The gateway passes
// that on only for requests that came through Serve (Identity), so it cannot
// be forged on the gateway's open port. The server's owner
// (TORWATCH_OWNER_LOGIN) may rename or remove any profile; everyone else
// their own.
package profiles

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Default is the profile of devices that never picked one.
const Default = "household"

// MaxProfiles bounds a server's profiles.
const MaxProfiles = 12

type Profile struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	HouseholdID int       `json:"-"`
	CreatedBy   string    `json:"-"`
	CreatedAt   time.Time `json:"createdAt"`
}

var (
	ErrNotFound  = errors.New("profile not found")
	ErrForbidden = errors.New("not allowed")
	ErrInvalid   = errors.New("invalid profile")
	ErrLast      = errors.New("the last profile cannot be removed")
	ErrTooMany   = errors.New("too many profiles")
)

type Store struct {
	DB *sql.DB

	mu      sync.Mutex
	byID    map[string]Profile
	device  map[string]string // client id -> profile id
	loaded  time.Time
	enabled bool // migration 017 applied
}

func NewStore(db *sql.DB) *Store { return &Store{DB: db} }

const cacheTTL = 30 * time.Second

// refresh reloads profiles and device choices (cheap: a handful of rows).
func (s *Store) refresh(ctx context.Context, force bool) {
	s.mu.Lock()
	fresh := !force && time.Since(s.loaded) < cacheTTL && s.byID != nil
	s.mu.Unlock()
	if fresh || s.DB == nil {
		return
	}
	byID := map[string]Profile{}
	device := map[string]string{}
	rows, err := s.DB.QueryContext(ctx, `SELECT id, name, color, household_id, created_by, created_at FROM profiles`)
	if err != nil {
		// Older schema (no profiles yet): everyone is the household.
		s.mu.Lock()
		s.byID, s.device, s.loaded, s.enabled = map[string]Profile{}, map[string]string{}, time.Now(), false
		s.mu.Unlock()
		return
	}
	for rows.Next() {
		var p Profile
		if rows.Scan(&p.ID, &p.Name, &p.Color, &p.HouseholdID, &p.CreatedBy, &p.CreatedAt) == nil {
			byID[p.ID] = p
		}
	}
	rows.Close()
	if dRows, err := s.DB.QueryContext(ctx, `SELECT client_id, profile_id FROM device_profiles`); err == nil {
		for dRows.Next() {
			var client, profile string
			if dRows.Scan(&client, &profile) == nil {
				device[client] = profile
			}
		}
		dRows.Close()
	}
	s.mu.Lock()
	s.byID, s.device, s.loaded, s.enabled = byID, device, time.Now(), true
	s.mu.Unlock()
}

func (s *Store) Enabled(ctx context.Context) bool {
	s.refresh(ctx, false)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

// householdProfile is the default profile when the table is missing.
var householdProfile = Profile{ID: Default, Name: "Household", Color: "#e50914", HouseholdID: 1}

// ForClient is the profile a device uses (Default when it never picked one
// or its profile was removed).
func (s *Store) ForClient(ctx context.Context, clientID string) Profile {
	if s == nil {
		return householdProfile
	}
	s.refresh(ctx, false)
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.device[strings.TrimSpace(clientID)]; ok {
		if p, ok := s.byID[id]; ok {
			return p
		}
	}
	if p, ok := s.byID[Default]; ok {
		return p
	}
	return householdProfile
}

// Chosen reports whether the device picked a profile (the app asks
// "Who's watching?" until it has, once there are two or more profiles).
func (s *Store) Chosen(ctx context.Context, clientID string) (string, bool) {
	s.refresh(ctx, false)
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.device[strings.TrimSpace(clientID)]
	if ok {
		_, ok = s.byID[id]
	}
	return id, ok
}

// SubjectFor maps a device id to its profile's subject (watch.Store).
func (s *Store) SubjectFor(clientID string) string {
	return s.ForClient(context.Background(), clientID).ID
}

func (s *Store) List(ctx context.Context) []Profile {
	s.refresh(ctx, false)
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Profile, 0, len(s.byID))
	for _, p := range s.byID {
		out = append(out, p)
	}
	// Oldest first: the household's own profile leads.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt.Before(out[j-1].CreatedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (s *Store) get(ctx context.Context, id string) (Profile, bool) {
	s.refresh(ctx, false)
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.byID[id]
	return p, ok
}

func validName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, len([]rune(name)) >= 1 && len([]rune(name)) <= 40
}

func validColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	_, err := hex.DecodeString(color[1:])
	return err == nil
}

func (s *Store) Create(ctx context.Context, name, color, createdBy string) (Profile, error) {
	name, ok := validName(name)
	if !ok || !validColor(color) {
		return Profile{}, ErrInvalid
	}
	if len(s.List(ctx)) >= MaxProfiles {
		return Profile{}, ErrTooMany
	}
	random := make([]byte, 6)
	if _, err := rand.Read(random); err != nil {
		return Profile{}, err
	}
	p := Profile{ID: "p-" + hex.EncodeToString(random), Name: name, Color: color, CreatedBy: createdBy}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Profile{}, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `INSERT INTO library_household (id, revision) VALUES (nextval('library_household_id_seq'), 0) RETURNING id`).Scan(&p.HouseholdID); err != nil {
		return Profile{}, err
	}
	if err := tx.QueryRowContext(ctx, `INSERT INTO profiles (id, name, color, household_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING created_at`,
		p.ID, p.Name, p.Color, p.HouseholdID, p.CreatedBy).Scan(&p.CreatedAt); err != nil {
		return Profile{}, err
	}
	if err := tx.Commit(); err != nil {
		return Profile{}, err
	}
	s.refresh(ctx, true)
	return p, nil
}

// CanManage: the owner manages every profile, others the ones they made.
func CanManage(p Profile, who Identity) bool {
	if who.Owner {
		return true
	}
	return who.Login != "" && strings.EqualFold(p.CreatedBy, who.Login)
}

func (s *Store) Update(ctx context.Context, id, name, color string, who Identity) (Profile, error) {
	p, ok := s.get(ctx, id)
	if !ok {
		return Profile{}, ErrNotFound
	}
	if !CanManage(p, who) {
		return Profile{}, ErrForbidden
	}
	if name != "" {
		valid, ok := validName(name)
		if !ok {
			return Profile{}, ErrInvalid
		}
		p.Name = valid
	}
	if color != "" {
		if !validColor(color) {
			return Profile{}, ErrInvalid
		}
		p.Color = color
	}
	if _, err := s.DB.ExecContext(ctx, `UPDATE profiles SET name=$2, color=$3 WHERE id=$1`, p.ID, p.Name, p.Color); err != nil {
		return Profile{}, err
	}
	s.refresh(ctx, true)
	return p, nil
}

// Delete removes a profile and everything that was its own: progress,
// Continue Watching dismissals, title visits and library. Devices that used
// it go back to the first profile (and are asked again).
func (s *Store) Delete(ctx context.Context, id string, who Identity) error {
	p, ok := s.get(ctx, id)
	if !ok {
		return ErrNotFound
	}
	if !CanManage(p, who) {
		return ErrForbidden
	}
	if id == Default || len(s.List(ctx)) <= 1 {
		return ErrLast
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range []string{
		`DELETE FROM watch_progress_sessions WHERE progress_id IN (SELECT id FROM watch_progress WHERE subject_id=$1)`,
		`DELETE FROM watch_progress WHERE subject_id=$1`,
		`DELETE FROM continue_dismissals WHERE subject_id=$1`,
		`DELETE FROM taste_events WHERE subject_id=$1`,
		`DELETE FROM device_profiles WHERE profile_id=$1`,
	} {
		if _, err := tx.ExecContext(ctx, statement, p.ID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM library_memberships WHERE household_id=$1`, p.HouseholdID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM profiles WHERE id=$1`, p.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM library_household WHERE id=$1`, p.HouseholdID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.refresh(ctx, true)
	return nil
}

// Select makes a device use a profile.
func (s *Store) Select(ctx context.Context, clientID, profileID string) error {
	if _, ok := s.get(ctx, profileID); !ok {
		return ErrNotFound
	}
	clientID = strings.TrimSpace(clientID)
	if clientID == "" || len(clientID) > 128 {
		return ErrInvalid
	}
	if _, err := s.DB.ExecContext(ctx, `
INSERT INTO device_profiles (client_id, profile_id) VALUES ($1, $2)
ON CONFLICT (client_id) DO UPDATE SET profile_id = EXCLUDED.profile_id, updated_at = now()`, clientID, profileID); err != nil {
		return err
	}
	s.refresh(ctx, true)
	return nil
}

// MARK: - Request context

type ctxKey struct{}

// WithProfile carries the request's profile.
func WithProfile(ctx context.Context, p Profile) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// From is the request's profile (the household's when none was set).
func From(ctx context.Context) Profile {
	if p, ok := ctx.Value(ctxKey{}).(Profile); ok {
		return p
	}
	return householdProfile
}

// Middleware puts the profile of the request's device (clientId or
// subjectId in the query) into its context.
func (s *Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		client := q.Get("clientId")
		if client == "" {
			client = q.Get("subjectId")
		}
		if client != "" && s != nil {
			r = r.WithContext(WithProfile(r.Context(), s.ForClient(r.Context(), client)))
		}
		next.ServeHTTP(w, r)
	})
}

// MARK: - Identity

// Identity is who sent a request, per Tailscale.
type Identity struct {
	Login string `json:"login"`
	Name  string `json:"name"`
	Owner bool   `json:"owner"`
}

// ProofHeader carries the gateway's secret on requests that came through
// Tailscale Serve (deploy/torwatch-server/Caddyfile).
const ProofHeader = "X-Torwatch-Identity-Proof"

// IdentityOf reads the Tailscale user of a request. Without a configured
// secret (TORWATCH_IDENTITY_SECRET) nobody can be told apart and everyone
// may manage profiles, as a server with one viewer always could.
func IdentityOf(r *http.Request) Identity {
	secret := os.Getenv("TORWATCH_IDENTITY_SECRET")
	if secret == "" {
		return Identity{Owner: true}
	}
	proof := r.Header.Get(ProofHeader)
	if subtle.ConstantTimeCompare([]byte(proof), []byte(secret)) != 1 {
		return Identity{}
	}
	login := strings.TrimSpace(r.Header.Get("Tailscale-User-Login"))
	owner := os.Getenv("TORWATCH_OWNER_LOGIN")
	return Identity{
		Login: login,
		Name:  strings.TrimSpace(r.Header.Get("Tailscale-User-Name")),
		Owner: login != "" && owner != "" && strings.EqualFold(login, strings.TrimSpace(owner)),
	}
}
