package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/profiles"
	"torrent-streamer/internal/stremiosync"
)

// Stremio sync (internal/stremiosync), for the request's profile (clientId):
//
//	GET  /v1/stremio?clientId        -> {linked, account?, pending?}
//	POST /v1/stremio/link/start      -> {linked:false, pending: {code, link, expiresAt}}
//	POST /v1/stremio/link/cancel     -> {linked, account?}
//	POST /v1/stremio/push {enabled}  -> {linked, account} (write TorWatch progress to Stremio)
//	POST /v1/stremio/link?clientId   {email,password} -> {linked, account}
//	POST /v1/stremio/sync?clientId   -> {linked, account}
//	POST /v1/stremio/unlink?clientId -> {linked:false}
//
// account: {email, linkedAt, lastSyncAt, lastError, imported}. pending: a
// link code waiting for the viewer to approve it on Stremio's site (the
// server watches for the approval; expired once nobody approved it in
// time). With email and password, the password is sent on to Stremio once
// and never stored; the session key never leaves the server.
type StremioHandlers struct {
	Sync *stremiosync.Service
}

func (h StremioHandlers) Register(mux *http.ServeMux) {
	if h.Sync == nil {
		return
	}
	mux.HandleFunc("/v1/stremio", h.handleStatus)
	mux.HandleFunc("/v1/stremio/link", h.handleLink)
	mux.HandleFunc("/v1/stremio/link/start", h.handleLinkStart)
	mux.HandleFunc("/v1/stremio/link/cancel", h.handleLinkCancel)
	mux.HandleFunc("/v1/stremio/push", h.handlePush)
	mux.HandleFunc("/v1/stremio/sync", h.handleSync)
	mux.HandleFunc("/v1/stremio/unlink", h.handleUnlink)
}

func (h StremioHandlers) status(w http.ResponseWriter, r *http.Request, account stremiosync.Account, linked bool) {
	body := map[string]any{"linked": linked}
	if linked {
		body["account"] = account
	}
	if pending, ok := h.Sync.Pending(profiles.From(r.Context()).ID); ok {
		body["pending"] = pending
	}
	writeJSON(w, http.StatusOK, body)
}

func (h StremioHandlers) handleLinkStart(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	profileID := profiles.From(r.Context()).ID
	if _, err := h.Sync.StartLink(r.Context(), profileID); err != nil {
		log.Printf("[stremio] link code for profile %s: %v", profileID, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Couldn't reach Stremio. Try again in a moment."})
		return
	}
	account, linked, _ := h.Sync.Store.Get(r.Context(), profileID)
	h.status(w, r, account, linked)
}

func (h StremioHandlers) handleLinkCancel(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	profileID := profiles.From(r.Context()).ID
	h.Sync.CancelLink(profileID)
	account, linked, _ := h.Sync.Store.Get(r.Context(), profileID)
	h.status(w, r, account, linked)
}

func (h StremioHandlers) handleStatus(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	account, linked, err := h.Sync.Store.Get(r.Context(), profiles.From(r.Context()).ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Couldn't read the Stremio link."})
		return
	}
	h.status(w, r, account, linked)
}

func (h StremioHandlers) handleLink(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeProfileRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Email) == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Enter your Stremio email and password."})
		return
	}
	profileID := profiles.From(r.Context()).ID
	account, err := h.Sync.Link(r.Context(), profileID, req.Email, req.Password)
	switch {
	case errors.Is(err, stremiosync.ErrBadLogin):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Stremio didn't accept that email and password."})
		return
	case err != nil && account.Email == "":
		log.Printf("[stremio] link for profile %s: %v", profileID, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Couldn't reach Stremio. Try again in a moment."})
		return
	}
	// Linked; a failed first sync shows in account.lastError.
	h.status(w, r, account, true)
}

func (h StremioHandlers) handleSync(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	profileID := profiles.From(r.Context()).ID
	if _, linked, _ := h.Sync.Store.Get(r.Context(), profileID); !linked {
		h.status(w, r, stremiosync.Account{}, false)
		return
	}
	account, _ := h.Sync.SyncProfile(r.Context(), profileID) // the outcome is in account.lastError
	h.status(w, r, account, account.Email != "")
}

func (h StremioHandlers) handleUnlink(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := h.Sync.Unlink(r.Context(), profiles.From(r.Context()).ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Couldn't unlink Stremio."})
		return
	}
	h.status(w, r, stremiosync.Account{}, false)
}

func (h StremioHandlers) handlePush(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeProfileRequest(w, r, &req) {
		return
	}
	profileID := profiles.From(r.Context()).ID
	account, linked, err := h.Sync.Store.Get(r.Context(), profileID)
	if err != nil || !linked {
		h.status(w, r, stremiosync.Account{}, false)
		return
	}
	if err := h.Sync.Store.SetPush(r.Context(), profileID, req.Enabled); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Couldn't change that."})
		return
	}
	account, _, _ = h.Sync.Store.Get(r.Context(), profileID)
	if req.Enabled {
		// Send what is being watched now right away.
		if _, err := h.Sync.PushProfile(r.Context(), account); err != nil {
			log.Printf("[stremio] first send for profile %s: %v", profileID, err)
		}
		account, _, _ = h.Sync.Store.Get(r.Context(), profileID)
	}
	h.status(w, r, account, true)
}
