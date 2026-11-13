package stremiosync

import (
	"context"
	"log"
	"time"
)

// Linking with a code (what Stremio's TV apps do): the profile gets a short
// code, the viewer approves it on Stremio's site, and the server, which
// watches for the approval itself, keeps the session. The password never
// passes through TorWatch, and the app may sit in the background meanwhile.

// PendingLink is a code waiting for approval.
type PendingLink struct {
	Code      string    `json:"code"`
	Link      string    `json:"link"`
	ExpiresAt time.Time `json:"expiresAt"`
	// Expired: nobody approved it in time (start again).
	Expired bool `json:"expired,omitempty"`
}

type pendingState struct {
	link   PendingLink
	cancel context.CancelFunc
}

const (
	defaultLinkWait = 10 * time.Minute
	defaultLinkPoll = 3 * time.Second
)

// StartLink gets a new code for the profile and watches for its approval
// (a code already waiting is replaced).
func (s *Service) StartLink(ctx context.Context, profileID string) (PendingLink, error) {
	code, err := s.Client.CreateLink(ctx)
	if err != nil {
		return PendingLink{}, err
	}
	wait := s.LinkWait
	if wait <= 0 {
		wait = defaultLinkWait
	}
	watchCtx, cancel := context.WithTimeout(context.Background(), wait)
	pending := PendingLink{Code: code.Code, Link: code.Link, ExpiresAt: time.Now().Add(wait)}
	s.pendingMu.Lock()
	if s.pending == nil {
		s.pending = map[string]*pendingState{}
	}
	if old := s.pending[profileID]; old != nil {
		old.cancel()
	}
	state := &pendingState{link: pending, cancel: cancel}
	s.pending[profileID] = state
	s.pendingMu.Unlock()
	go s.watchLink(watchCtx, profileID, state)
	return pending, nil
}

// Pending is the profile's code waiting for approval, if any.
func (s *Service) Pending(profileID string) (PendingLink, bool) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	state := s.pending[profileID]
	if state == nil {
		return PendingLink{}, false
	}
	return state.link, true
}

// CancelLink forgets the profile's waiting code.
func (s *Service) CancelLink(profileID string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if state := s.pending[profileID]; state != nil {
		state.cancel()
		delete(s.pending, profileID)
	}
}

func (s *Service) watchLink(ctx context.Context, profileID string, state *pendingState) {
	poll := s.LinkPoll
	if poll <= 0 {
		poll = defaultLinkPoll
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.pendingMu.Lock()
			if s.pending[profileID] == state && ctx.Err() == context.DeadlineExceeded {
				state.link.Expired = true // shown until the next start or cancel
			}
			s.pendingMu.Unlock()
			return
		case <-ticker.C:
		}
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		key, err := s.Client.ReadLink(callCtx, state.link.Code)
		cancel()
		if err != nil || key == "" {
			continue // not approved yet, or a passing network error
		}
		s.pendingMu.Lock()
		current := s.pending[profileID] == state
		if current {
			delete(s.pending, profileID)
		}
		s.pendingMu.Unlock()
		state.cancel()
		if !current {
			return // replaced or cancelled meanwhile
		}
		s.finishLink(profileID, key)
		return
	}
}

// finishLink keeps the approved session and syncs once.
func (s *Service) finishLink(profileID, key string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	email, err := s.Client.Email(ctx, key)
	if err != nil {
		log.Printf("[stremio] profile %s: linked; account email unavailable: %v", profileID, err)
	}
	if err := s.Store.Link(ctx, profileID, email, key); err != nil {
		log.Printf("[stremio] profile %s: keeping the link: %v", profileID, err)
		return
	}
	log.Printf("[stremio] profile %s: linked with a code", profileID)
	_, _ = s.SyncProfile(ctx, profileID)
}
