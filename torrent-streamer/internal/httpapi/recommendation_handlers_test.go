package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/library"
	"torrent-streamer/internal/recommendations"
)

type recHandlerFakeLibrary struct {
	revision  int64
	seeds     []library.Seed
	activeIDs map[string]bool
}

func (f *recHandlerFakeLibrary) FavouriteSeeds(context.Context, int) ([]library.Seed, error) {
	return f.seeds, nil
}
func (f *recHandlerFakeLibrary) ActiveMembershipIDs(context.Context) (map[string]bool, error) {
	return f.activeIDs, nil
}
func (f *recHandlerFakeLibrary) Revision(context.Context) (int64, error) { return f.revision, nil }

type recHandlerFakeCandidates struct {
	titles []catalog.Title
	err    error
}

func (f *recHandlerFakeCandidates) Candidates(context.Context) ([]catalog.Title, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.titles, nil
}

type fixedSeedGenres map[string][]string

func (f fixedSeedGenres) SeedGenres(_ context.Context, canonicalID string) ([]string, error) {
	return f[canonicalID], nil
}

func tmdbHandlerTitle(id int64, external string, title string) catalog.Title {
	return catalog.Title{ID: external, Type: catalog.TypeMovie, Title: title}
}

func recommendationTestServer(t *testing.T, capabilities []string, candidatesErr bool) *httptest.Server {
	t.Helper()
	lib := &recHandlerFakeLibrary{
		revision:  42,
		seeds:     []library.Seed{{CanonicalID: "tmdb:movie:1", Title: "Seed Movie", AddedAt: time.Now()}},
		activeIDs: map[string]bool{"tmdb:movie:1": true},
	}
	candidates := &recHandlerFakeCandidates{
		titles: []catalog.Title{
			func() catalog.Title {
				t := tmdbHandlerTitle(9, "tmdb:movie:9", "Scored")
				t.Genres = []string{"Action"}
				return t
			}(),
			tmdbHandlerTitle(10, "tmdb:movie:10", "Popular"),
		},
		err: errOrNil(candidatesErr),
	}
	service := recommendations.New(recommendations.Deps{
		Library:               lib,
		Candidates:            candidates,
		SeedGenres:            fixedSeedGenres{"tmdb:movie:1": {"Action"}},
		CandidateCacheVersion: 1,
	})
	mux := http.NewServeMux()
	RecommendationHandlers{
		Recommendations: service,
		Build:           buildinfo.New(buildinfo.Options{ServerVersion: "test", Capabilities: capabilities}),
	}.Register(mux)
	return httptest.NewServer(mux)
}

func errOrNil(b bool) error {
	if b {
		return errors.New("providers down")
	}
	return nil
}

func TestRecommendationsContract(t *testing.T) {
	server := recommendationTestServer(t, []string{recommendations.Capability}, false)
	defer server.Close()

	resp, err := http.Get(server.URL + "/v2/recommendations")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var payload struct {
		Revision string `json:"revision"`
		Fallback bool   `json:"fallback"`
		Degraded bool   `json:"degraded"`
		Items    []struct {
			CanonicalID string `json:"canonicalId"`

			Reason struct {
				Code            string `json:"code"`
				Text            string `json:"text"`
				SeedCanonicalID string `json:"seedCanonicalId"`
			} `json:"reason"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Revision != "42" {
		t.Fatalf("revision = %q, want lossless string \"42\"", payload.Revision)
	}
	if payload.Fallback || payload.Degraded {
		t.Fatalf("flags wrong: %+v", payload)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("items = %d", len(payload.Items))
	}
	if payload.Items[0].Reason.Code != "seed_genre" || payload.Items[0].Reason.SeedCanonicalID != "tmdb:movie:1" ||
		payload.Items[0].Reason.Text != "Because you favourited Seed Movie" {
		t.Fatalf("seed reason wrong: %+v", payload.Items[0])
	}
	if payload.Items[1].Reason.Code != "popular" {
		t.Fatalf("filler reason wrong: %+v", payload.Items[1])
	}
}

func TestRecommendationsLimitValidation(t *testing.T) {
	server := recommendationTestServer(t, []string{recommendations.Capability}, false)
	defer server.Close()

	for _, query := range []string{"?limit=0", "?limit=-1", "?limit=21", "?limit=abc"} {
		resp, err := http.Get(server.URL + "/v2/recommendations" + query)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest || body["error"].(map[string]any)["code"] != "invalid_request" {
			t.Fatalf("limit %q = %d %v", query, resp.StatusCode, body)
		}
	}
	for _, query := range []string{"", "?limit=1", "?limit=20"} {
		resp, err := http.Get(server.URL + "/v2/recommendations" + query)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("limit %q = %d", query, resp.StatusCode)
		}
	}
}

func TestRecommendationsDegradedOnProviderFailure(t *testing.T) {
	// Fresh service + failing candidates → truthful empty degraded section.
	server := recommendationTestServer(t, []string{recommendations.Capability}, true)
	defer server.Close()
	resp, err := http.Get(server.URL + "/v2/recommendations")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Degraded bool  `json:"degraded"`
		Items    []any `json:"items"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if !payload.Degraded || payload.Items == nil || len(payload.Items) != 0 {
		t.Fatalf("degraded empty section wrong: %+v", payload)
	}
}

func TestRecommendationsCapabilityNegotiation(t *testing.T) {
	server := recommendationTestServer(t, []string{"catalog.bff.v2"}, false)
	defer server.Close()
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/v2/recommendations", nil)
	req.Header.Set("X-Torwatch-Capability", recommendations.Capability)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode == http.StatusOK {
		t.Fatal("unadvertised capability must not pass negotiation")
	}
	if code := body["error"].(map[string]any)["code"]; code != "unsupported_capability" {
		t.Fatalf("capability error code = %v", code)
	}
}

func TestRecommendationsRoutesAbsentWithoutService(t *testing.T) {
	mux := http.NewServeMux()
	RecommendationHandlers{Recommendations: nil}.Register(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	resp, err := http.Get(server.URL + "/v2/recommendations")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("routes registered without a service: %d", resp.StatusCode)
	}
}
