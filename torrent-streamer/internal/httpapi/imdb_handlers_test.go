package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/imdb"
)

type fakeIMDbRatings struct {
	rating imdb.Rating
	err    error
}

func (f fakeIMDbRatings) Rating(context.Context, string) (imdb.Rating, error) {
	return f.rating, f.err
}

func TestIMDbRatingHandler(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	IMDbRatingHandlers{Ratings: fakeIMDbRatings{rating: imdb.Rating{
		IMDbID: "tt1234567", Rating: 8.4, Votes: 12345,
	}}}.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/tt1234567", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if body := response.Body.String(); !strings.Contains(body, `"rating":8.4`) || !strings.Contains(body, `"votes":12345`) {
		t.Fatalf("body = %s", body)
	}
}

func TestIMDbRatingHandlerNotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	IMDbRatingHandlers{Ratings: fakeIMDbRatings{err: imdb.ErrRatingNotFound}}.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/tt1234567", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
}

func TestIMDbRatingHandlerRejectsInvalidID(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	IMDbRatingHandlers{Ratings: fakeIMDbRatings{err: errors.New("must not be called")}}.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/v1/imdb/ratings/not-an-id", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}
