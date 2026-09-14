package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

type parityFixture struct {
	Scenario  string `json:"scenario"`
	Query     string `json:"query"`
	Providers struct {
		TMDb    json.RawMessage `json:"tmdb"`
		AniList json.RawMessage `json:"anilist"`
		Jikan   json.RawMessage `json:"jikan"`
	} `json:"providers"`
}

type rendererRows struct {
	Scenario string `json:"scenario"`
	TMDb     struct {
		Movies            []rendererCard `json:"movies"`
		TV                []rendererCard `json:"tv"`
		DroppedAnimeCards []rendererCard `json:"droppedAnimeCards"`
	} `json:"tmdb"`
	AniList struct {
		Anime []rendererCard `json:"anime"`
	} `json:"anilist"`
}

type rendererCard struct {
	Provider         string `json:"provider"`
	ID               int64  `json:"id"`
	Title            string `json:"title"`
	Year             int    `json:"year"`
	OriginalLanguage string `json:"originalLanguage"`
	GenreIDs         []int  `json:"genreIds"`
	SourceKind       string `json:"sourceKind"`
}

// loadParityFixture reads the shared fixture consumed identically by the
// renderer harness and the Go backend.
func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/parity/parity-fixture.json")
	if err != nil {
		t.Fatalf("read parity fixture: %v", err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode parity fixture: %v", err)
	}
	return fixture
}

func loadRendererRows(t *testing.T) rendererRows {
	t.Helper()
	raw, err := os.ReadFile("testdata/parity/renderer-rows.json")
	if err != nil {
		t.Fatalf("read renderer golden rows (regenerate via electron-app/scripts/parity/renderer-catalog.mjs): %v", err)
	}
	var rows rendererRows
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("decode renderer rows: %v", err)
	}
	return rows
}

// runBackendSearch feeds the exact fixture payloads to the Go adapters via
// stub provider servers and returns the merged backend rows.
func runBackendSearch(t *testing.T, fixture parityFixture) []Title {
	t.Helper()
	serve := func(payload json.RawMessage) *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(payload)
		}))
		t.Cleanup(server.Close)
		return server
	}
	tmdbServer := serve(fixture.Providers.TMDb)
	anilistServer := serve(fixture.Providers.AniList)
	jikanServer := serve(fixture.Providers.Jikan)

	// AniList detail queries are not part of this fixture; the search stub
	// answers everything with the page payload.
	service := NewService([]Provider{
		NewTMDb(TMDbOptions{BaseURL: tmdbServer.URL, APIKey: "parity-key"}),
		NewAniList(AniListOptions{BaseURL: anilistServer.URL}),
		NewJikan(JikanOptions{BaseURL: jikanServer.URL}),
	}, Options{ProviderTimeout: 200 * time.Millisecond})

	result := service.Search(context.Background(), SearchQuery{Query: fixture.Query})
	if len(result.DegradedProviders) != 0 {
		t.Fatalf("parity fixture must not degrade providers: %v", result.DegradedProviders)
	}
	return result.Titles
}

func TestParityRendererRowsAppearInBackendRows(t *testing.T) {
	fixture := loadParityFixture(t)
	renderer := loadRendererRows(t)
	titles := runBackendSearch(t, fixture)

	backendByTitleKey := map[string]Title{}
	for _, title := range titles {
		backendByTitleKey[parityKey(title.Title, title.Year)] = title
	}

	kept := append(append([]rendererCard{}, renderer.TMDb.Movies...), renderer.TMDb.TV...)
	kept = append(kept, renderer.AniList.Anime...)
	for _, card := range kept {
		backend, ok := backendByTitleKey[parityKey(card.Title, card.Year)]
		if !ok {
			t.Fatalf("renderer row %q (%s:%d) has no backend row: backend=%v", card.Title, card.Provider, card.ID, backendKeys(titles))
		}
		namespace := card.Provider
		if namespace == "jikan" {
			namespace = "jikan"
		}
		if backend.ProviderIDs[namespace] == "" {
			t.Fatalf("backend row %q missing provider id %s:%d: %v", backend.ID, card.Provider, card.ID, backend.ProviderIDs)
		}
	}
}

func TestParityDroppedTMDbAnimeRowsAreMergedNotLost(t *testing.T) {
	fixture := loadParityFixture(t)
	renderer := loadRendererRows(t)
	titles := runBackendSearch(t, fixture)

	backendByTitleKey := map[string]Title{}
	for _, title := range titles {
		backendByTitleKey[parityKey(title.Title, title.Year)] = title
	}
	for _, card := range renderer.TMDb.DroppedAnimeCards {
		backend, ok := backendByTitleKey[parityKey(card.Title, card.Year)]
		if !ok {
			t.Fatalf("TMDb anime row %q dropped by the renderer must still exist in the backend merge (joined with the AniList canonical row)", card.Title)
		}
		if backend.Type != TypeAnime {
			t.Fatalf("dropped TMDb anime row must classify as anime in the backend: %+v", backend)
		}
		if backend.ProviderIDs["tmdb"] == "" || backend.ProviderIDs["anilist"] == "" || backend.ProviderIDs["jikan"] == "" {
			t.Fatalf("the dropped row's providers must join into one merged row: %v", backend.ProviderIDs)
		}
	}
}

func TestParityAnimeClassificationMatchesRenderer(t *testing.T) {
	fixture := loadParityFixture(t)
	renderer := loadRendererRows(t)
	titles := runBackendSearch(t, fixture)

	backendByTitleKey := map[string]Title{}
	for _, title := range titles {
		backendByTitleKey[parityKey(title.Title, title.Year)] = title
	}
	all := append(append([]rendererCard{}, renderer.TMDb.Movies...), renderer.TMDb.TV...)
	all = append(all, renderer.TMDb.DroppedAnimeCards...)
	for _, card := range all {
		backend, ok := backendByTitleKey[parityKey(card.Title, card.Year)]
		if !ok {
			t.Fatalf("card %q missing from backend: %v", card.Title, backendKeys(titles))
		}
		wantMovie := card.SourceKind == "movie"
		if wantMovie && backend.Type != TypeMovie {
			t.Fatalf("renderer movie %q classified %q in backend", card.Title, backend.Type)
		}
	}
}

func TestParityBackendOrderingIsContractDeterministic(t *testing.T) {
	fixture := loadParityFixture(t)
	first := runBackendSearch(t, fixture)
	second := runBackendSearch(t, fixture)
	if len(first) != len(second) {
		t.Fatalf("result count differs between runs")
	}
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatalf("ordering differs between runs: %v vs %v", ids(first), ids(second))
		}
	}
	// Identity merging is deterministic; presentation follows query relevance.
	query := normalizeSearchText(fixture.Query)
	for i := 1; i < len(first); i++ {
		previous := max(searchMatchScore(first[i-1].Title, query), searchMatchScore(first[i-1].OriginalTitle, query))
		current := max(searchMatchScore(first[i].Title, query), searchMatchScore(first[i].OriginalTitle, query))
		if current > previous {
			t.Fatalf("results must follow relevance: %v", ids(first))
		}
	}
}

func TestParityJikanOnlyInBackend(t *testing.T) {
	// The renderer search pipeline never aggregates Jikan rows (evidence
	// variance V2); the backend does per FR-001. The Jikan Frieren row must
	// join the merged row rather than create a duplicate.
	fixture := loadParityFixture(t)
	titles := runBackendSearch(t, fixture)
	count := 0
	for _, title := range titles {
		if parityKey(title.Title, title.Year) == parityKey("Frieren: Beyond Journey's End", 2023) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("jikan row must join the merged Frieren row exactly once: %d", count)
	}
}

func parityKey(title string, year int) string {
	return fmt.Sprintf("%s|%d", NormalizeTitle(title), year)
}

func backendKeys(titles []Title) []string {
	keys := make([]string, 0, len(titles))
	for _, title := range titles {
		keys = append(keys, title.ID+" ("+parityKey(title.Title, title.Year)+")")
	}
	return keys
}

func ids(titles []Title) []string {
	result := make([]string, 0, len(titles))
	for _, title := range titles {
		result = append(result, title.ID)
	}
	return result
}
