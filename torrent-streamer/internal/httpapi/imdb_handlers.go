package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"torrent-streamer/internal/imdb"
	"torrent-streamer/internal/middleware"
)

type IMDbRatingReader interface {
	Rating(ctx context.Context, imdbID string) (imdb.Rating, error)
}

type IMDbRatingHandlers struct {
	Ratings IMDbRatingReader
}

func (h IMDbRatingHandlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/imdb/ratings/", h.rating)
}

func (h IMDbRatingHandlers) rating(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCORS(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	imdbID := strings.TrimPrefix(r.URL.Path, "/v1/imdb/ratings/")
	if !validIMDbID(imdbID) {
		writeIMDbError(w, http.StatusBadRequest, "invalid IMDb id")
		return
	}
	rating, err := h.Ratings.Rating(r.Context(), imdbID)
	if errors.Is(err, imdb.ErrRatingNotFound) {
		writeIMDbError(w, http.StatusNotFound, "IMDb rating not found")
		return
	}
	if err != nil {
		writeIMDbError(w, http.StatusInternalServerError, "could not load IMDb rating")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rating)
}

func writeIMDbError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func validIMDbID(value string) bool {
	if len(value) < 3 || !strings.HasPrefix(value, "tt") {
		return false
	}
	for _, character := range value[2:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}
