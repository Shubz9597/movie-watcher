package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/profiles"
)

// Profiles ("Who's watching?"), internal/profiles:
//
//	GET  /v1/profiles?clientId    -> {profiles:[{id,name,color,canManage}], current, me}
//	POST /v1/profiles             {name,color}            -> the new profile
//	POST /v1/profiles/update      {id,name?,color?}       -> the profile
//	POST /v1/profiles/delete      {id}                    -> 204
//	POST /v1/profiles/select      {clientId,profileId}    -> 204
//
// current is the profile this device picked, or null (the app asks "Who's
// watching?" once there are two or more). me: the Tailscale user and
// whether they are the server's owner.
type ProfileHandlers struct {
	Store *profiles.Store
}

func (h ProfileHandlers) Register(mux *http.ServeMux) {
	if h.Store == nil {
		return
	}
	mux.HandleFunc("/v1/profiles", h.handleProfiles)
	mux.HandleFunc("/v1/profiles/update", h.handleUpdate)
	mux.HandleFunc("/v1/profiles/delete", h.handleDelete)
	mux.HandleFunc("/v1/profiles/select", h.handleSelect)
}

type profileBody struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	CanManage bool   `json:"canManage"`
}

func (h ProfileHandlers) body(p profiles.Profile, who profiles.Identity) profileBody {
	return profileBody{ID: p.ID, Name: p.Name, Color: p.Color, CanManage: profiles.CanManage(p, who)}
}

func (h ProfileHandlers) handleProfiles(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	switch r.Method {
	case http.MethodOptions:
		return
	case http.MethodGet:
		who := profiles.IdentityOf(r)
		list := h.Store.List(r.Context())
		out := make([]profileBody, 0, len(list))
		for _, p := range list {
			out = append(out, h.body(p, who))
		}
		var current any
		if id, ok := h.Store.Chosen(r.Context(), r.URL.Query().Get("clientId")); ok {
			current = id
		}
		writeJSON(w, http.StatusOK, map[string]any{"profiles": out, "current": current, "me": who, "max": profiles.MaxProfiles})
	case http.MethodPost:
		var req struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		}
		if !decodeProfileRequest(w, r, &req) {
			return
		}
		who := profiles.IdentityOf(r)
		p, err := h.Store.Create(r.Context(), req.Name, req.Color, who.Login)
		if err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, h.body(p, who))
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h ProfileHandlers) handleUpdate(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if !decodeProfileRequest(w, r, &req) {
		return
	}
	who := profiles.IdentityOf(r)
	p, err := h.Store.Update(r.Context(), req.ID, req.Name, req.Color, who)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.body(p, who))
}

func (h ProfileHandlers) handleDelete(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if !decodeProfileRequest(w, r, &req) {
		return
	}
	if err := h.Store.Delete(r.Context(), req.ID, profiles.IdentityOf(r)); err != nil {
		writeProfileError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h ProfileHandlers) handleSelect(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		ClientID  string `json:"clientId"`
		ProfileID string `json:"profileId"`
	}
	if !decodeProfileRequest(w, r, &req) {
		return
	}
	if err := h.Store.Select(r.Context(), req.ClientID, req.ProfileID); err != nil {
		writeProfileError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeProfileRequest(w http.ResponseWriter, r *http.Request, into any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(into); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
		return false
	}
	return true
}

func writeProfileError(w http.ResponseWriter, err error) {
	status, code := http.StatusInternalServerError, "profiles_failed"
	switch {
	case errors.Is(err, profiles.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, profiles.ErrForbidden):
		status, code = http.StatusForbidden, "forbidden"
	case errors.Is(err, profiles.ErrInvalid):
		status, code = http.StatusBadRequest, "invalid"
	case errors.Is(err, profiles.ErrLast):
		status, code = http.StatusConflict, "last_profile"
	case errors.Is(err, profiles.ErrTooMany):
		status, code = http.StatusConflict, "too_many"
	}
	writeJSON(w, status, map[string]string{"error": code, "message": strings.TrimSpace(err.Error())})
}
