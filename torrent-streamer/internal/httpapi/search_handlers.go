package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/search"
)

const searchRequestLimit = 1 << 20

// TorrentSearchHandlers exposes backend-owned torrent discovery and resolution.
type TorrentSearchHandlers struct {
	Service *search.Service
}

// Register adds the torrent search endpoints to mux.
func (h TorrentSearchHandlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/torrents/search", h.handleSearch)
	mux.HandleFunc("/v1/torrents/resolve", h.handleResolve)
}

func (h TorrentSearchHandlers) handleSearch(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		writeSearchError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h.Service == nil {
		writeSearchError(w, http.StatusServiceUnavailable, "torrent search is not configured")
		return
	}
	var request search.Request
	if err := decodeSearchJSON(r, &request); err != nil {
		writeSearchError(w, http.StatusBadRequest, err.Error())
		return
	}
	if request.Title == "" || request.Kind != search.KindMovie && request.Kind != search.KindTV && request.Kind != search.KindAnime {
		writeSearchError(w, http.StatusBadRequest, "title and a valid kind are required")
		return
	}
	// 55s: MUST stay under the iOS WKWebView fetch idle limit (~60s) while
	// covering the service's per-indexer budget (20s) plus the unscoped
	// fallback retry (20s). The previous 35s cap killed searches that were
	// still healthy on slow indexers (Nyaa via FlareSolverr commonly takes
	// 10-20s alone) — every real-device search surfaced as a timeout.
	ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
	defer cancel()
	started := time.Now()
	response, err := h.Service.Search(ctx, request)
	log.Printf("[search] kind=%s title=%q took=%s results=%d err=%v",
		request.Kind, truncateSearchLogTitle(request.Title), time.Since(started).Round(time.Millisecond), len(response.Results), err)
	if err != nil {
		writeSearchError(w, searchErrorStatus(err), err.Error())
		return
	}
	writeSearchJSON(w, http.StatusOK, response)
}

func truncateSearchLogTitle(title string) string {
	runes := []rune(title)
	if len(runes) > 40 {
		return string(runes[:40]) + "…"
	}
	return title
}

func (h TorrentSearchHandlers) handleResolve(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		writeSearchError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h.Service == nil {
		writeSearchError(w, http.StatusServiceUnavailable, "torrent search is not configured")
		return
	}
	var request search.ResolveRequest
	if err := decodeSearchJSON(r, &request); err != nil {
		writeSearchError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	response, err := h.Service.Resolve(ctx, request)
	if err != nil {
		writeSearchError(w, searchErrorStatus(err), err.Error())
		return
	}
	writeSearchJSON(w, http.StatusOK, response)
}

func decodeSearchJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, searchRequestLimit+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func searchErrorStatus(err error) int {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

func writeSearchError(w http.ResponseWriter, status int, message string) {
	writeSearchJSON(w, status, map[string]string{"error": message})
}

func writeSearchJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
