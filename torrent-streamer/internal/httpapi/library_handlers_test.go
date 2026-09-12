package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/library"
	"torrent-streamer/migrations"
)

// libraryTestServer builds an isolated-schema library store over the
// disposable PostgreSQL (TORWATCH_TEST_PG_DSN) and mounts the library
// handlers exactly like the composition root. Skipped when no disposable
// database is configured.
func libraryTestServer(t *testing.T, capabilities []string) (*httptest.Server, *sql.DB, *libraryFakeResolver) {
	t.Helper()
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; library HTTP verification pending a disposable database")
	}
	schema := fmt.Sprintf("libhttp_%d_%d", time.Now().UnixNano(), os.Getpid())
	dsn := base + "&search_path=" + schema
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	resolver := &libraryFakeResolver{titles: map[string]library.Metadata{
		"tmdb:movie:693134": {Title: "Dune: Part Two", Year: 2024, Poster: "https://image.test/dune.jpg", Kind: "movie", SortKey: "dune part two"},
		"tmdb:tv:1396":      {Title: "Breaking Bad", Year: 2008, Poster: "https://image.test/bb.jpg", Kind: "series", SortKey: "breaking bad"},
		"tmdb:tv:209867":    {Title: "Frieren: Beyond Journey's End", Year: 2023, Poster: "https://image.test/frieren.jpg", Kind: "anime", SortKey: "frieren beyond journeys end"},
	}}
	store, err := library.NewStore(ctx, db, resolver)
	if err != nil {
		t.Fatalf("open library store: %v", err)
	}
	mux := http.NewServeMux()
	LibraryHandlers{
		Library: store,
		Build:   buildinfo.New(buildinfo.Options{ServerVersion: "test", Capabilities: capabilities}),
	}.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, db, resolver
}

type libraryFakeResolver struct {
	mu     sync.Mutex
	titles map[string]library.Metadata
}

func (f *libraryFakeResolver) Resolve(_ context.Context, canonicalID string) (library.Metadata, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.titles[canonicalID]
	if !ok {
		return library.Metadata{}, catalog.ErrNotFound
	}
	return meta, nil
}

func (f *libraryFakeResolver) remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.titles, id)
}

func libraryPut(t *testing.T, server *httptest.Server, id, field string, enabled bool) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"enabled":%v}`, enabled)
	req, err := http.NewRequest(http.MethodPut, server.URL+"/v2/library/"+id+"/"+field, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return doLibraryJSON(t, req)
}

func doLibraryJSON(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp.StatusCode, payload
}

func TestLibraryWriteAndListContract(t *testing.T) {
	server, _, _ := libraryTestServer(t, []string{library.Capability})

	status, body := libraryPut(t, server, "tmdb:movie:693134", "watch-later", true)
	if status != http.StatusOK {
		t.Fatalf("write status = %d: %v", status, body)
	}
	if body["canonicalId"] != "tmdb:movie:693134" || body["watchLater"] != true || body["favourite"] != false {
		t.Fatalf("write body = %v", body)
	}
	revision, ok := body["revision"].(string)
	if !ok || revision != "1" {
		t.Fatalf("revision = %v, want decimal string \"1\"", body["revision"])
	}
	if _, ok := body["updatedAt"].(string); !ok {
		t.Fatalf("updatedAt = %v, want a timestamp string", body["updatedAt"])
	}

	// No-op retry: same committed state and revision.
	status, retry := libraryPut(t, server, "tmdb:movie:693134", "watch-later", true)
	if status != http.StatusOK || retry["revision"] != "1" {
		t.Fatalf("no-op retry = %d %v", status, retry)
	}

	resp, err := http.Get(server.URL + "/v2/library?collection=watch-later&kind=movie&sort=recent&limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var page map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page["revision"] != "1" || page["total"] != float64(1) || page["degraded"] != false {
		t.Fatalf("page envelope = %v", page)
	}
	items := page["items"].([]any)
	item := items[0].(map[string]any)
	if item["canonicalId"] != "tmdb:movie:693134" || item["type"] != "movie" ||
		item["title"] != "Dune: Part Two" || item["metadataAvailable"] != true {
		t.Fatalf("page item = %v", item)
	}
	if _, ok := item["addedAt"].(string); !ok {
		t.Fatalf("addedAt = %v, want timestamp", item["addedAt"])
	}
	if artwork, ok := item["artwork"].(map[string]any); !ok || artwork["poster"] != "https://image.test/dune.jpg" {
		t.Fatalf("artwork = %v", item["artwork"])
	}
	if _, present := page["nextCursor"]; present {
		t.Fatalf("single page must not carry nextCursor: %v", page["nextCursor"])
	}
}

func TestLibraryOverviewContract(t *testing.T) {
	server, _, _ := libraryTestServer(t, []string{library.Capability})
	if status, body := libraryPut(t, server, "tmdb:movie:693134", "watch-later", true); status != http.StatusOK {
		t.Fatalf("seed write = %d %v", status, body)
	}
	if status, body := libraryPut(t, server, "tmdb:tv:209867", "favourite", true); status != http.StatusOK {
		t.Fatalf("seed write = %d %v", status, body)
	}

	resp, err := http.Get(server.URL + "/v2/library/overview?collection=watch-later&sort=recent")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var overview map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&overview); err != nil {
		t.Fatal(err)
	}
	if overview["revision"] != "2" || overview["collection"] != "watch-later" || overview["degraded"] != false {
		t.Fatalf("overview envelope = %v", overview)
	}
	if _, ok := overview["sourceRev"].(string); !ok {
		t.Fatalf("sourceRev = %v, want decimal string", overview["sourceRev"])
	}
	shelves := overview["shelves"].([]any)
	if len(shelves) != 3 {
		t.Fatalf("shelves = %d, want movie/series/anime", len(shelves))
	}
	kinds := map[string]map[string]any{}
	for _, raw := range shelves {
		shelf := raw.(map[string]any)
		kinds[shelf["kind"].(string)] = shelf
	}
	for _, kind := range []string{"movie", "series", "anime"} {
		if _, ok := kinds[kind]; !ok {
			t.Fatalf("shelf %s missing: %v", kind, kinds)
		}
	}
	if kinds["movie"]["count"] != float64(1) || kinds["series"]["count"] != float64(0) || kinds["anime"]["count"] != float64(0) {
		t.Fatalf("overview counts = %v", kinds)
	}
	// Anime writes keep their structural tmdb id under the anime shelf.
	resp2, err := http.Get(server.URL + "/v2/library/overview?collection=favourites")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var favOverview map[string]any
	if err := json.NewDecoder(resp2.Body).Decode(&favOverview); err != nil {
		t.Fatal(err)
	}
	for _, raw := range favOverview["shelves"].([]any) {
		shelf := raw.(map[string]any)
		if shelf["kind"] == "anime" {
			previews := shelf["previews"].([]any)
			if len(previews) != 1 || previews[0].(map[string]any)["canonicalId"] != "tmdb:tv:209867" {
				t.Fatalf("anime shelf previews = %v", previews)
			}
			if previews[0].(map[string]any)["type"] != "anime" {
				t.Fatalf("anime preview type = %v", previews[0])
			}
		}
	}
}

func TestLibraryPaginationOverHTTP(t *testing.T) {
	server, _, _ := libraryTestServer(t, []string{library.Capability})
	for _, id := range []string{"tmdb:movie:693134", "tmdb:tv:1396", "tmdb:tv:209867"} {
		if status, body := libraryPut(t, server, id, "watch-later", true); status != http.StatusOK {
			t.Fatalf("seed %s = %d %v", id, status, body)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for pages := 0; ; pages++ {
		url := server.URL + "/v2/library?collection=watch-later&limit=2"
		if cursor != "" {
			url += "&cursor=" + cursor
		}
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		var page map[string]any
		err = json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if page["total"] != float64(3) {
			t.Fatalf("total = %v, want full-scope 3", page["total"])
		}
		for _, raw := range page["items"].([]any) {
			id := raw.(map[string]any)["canonicalId"].(string)
			if seen[id] {
				t.Fatalf("duplicate %s across pages", id)
			}
			seen[id] = true
		}
		next, present := page["nextCursor"]
		if !present {
			break
		}
		cursor = next.(string)
		if pages > 5 {
			t.Fatal("pagination did not terminate")
		}
	}
	if len(seen) != 3 {
		t.Fatalf("seen = %v", seen)
	}
}

func TestLibraryHTTPValidationErrors(t *testing.T) {
	server, _, resolver := libraryTestServer(t, []string{library.Capability})

	// Unqualified legacy alias: 400 invalid_request, never a library key.
	if status, body := libraryPut(t, server, "tmdb:123", "watch-later", true); status != http.StatusBadRequest || body["error"].(map[string]any)["code"] != "invalid_request" {
		t.Fatalf("unqualified alias = %d %v", status, body)
	}
	// Malformed body: 400.
	req, _ := http.NewRequest(http.MethodPut, server.URL+"/v2/library/tmdb:movie:693134/watch-later", strings.NewReader(`{"enabled":"yes"}`))
	if status, body := doLibraryJSON(t, req); status != http.StatusBadRequest {
		t.Fatalf("malformed body = %d %v", status, body)
	}
	// Unknown well-formed id with no stored snapshot: 404 title_not_found.
	resolver.remove("tmdb:tv:1396")
	if status, body := libraryPut(t, server, "tmdb:tv:1396", "watch-later", true); status != http.StatusNotFound || body["error"].(map[string]any)["code"] != "title_not_found" {
		t.Fatalf("unknown title = %d %v", status, body)
	}
	// Missing collection: 400.
	resp, err := http.Get(server.URL + "/v2/library")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || body["error"].(map[string]any)["code"] != "invalid_request" {
		t.Fatalf("missing collection = %d %v", resp.StatusCode, body)
	}
	// Invalid limit: 400.
	resp, _ = http.Get(server.URL + "/v2/library?collection=watch-later&limit=101")
	var limitBody map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&limitBody)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("limit 101 = %d %v", resp.StatusCode, limitBody)
	}
	// Invalid sort: 400.
	resp, _ = http.Get(server.URL + "/v2/library?collection=watch-later&sort=newest")
	var sortBody map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&sortBody)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid sort = %d %v", resp.StatusCode, sortBody)
	}
}

func TestLibraryCursorScopeMismatchOverHTTP(t *testing.T) {
	server, _, _ := libraryTestServer(t, []string{library.Capability})
	for _, id := range []string{"tmdb:movie:693134", "tmdb:tv:1396", "tmdb:tv:209867"} {
		libraryPut(t, server, id, "watch-later", true)
	}
	resp, err := http.Get(server.URL + "/v2/library?collection=watch-later&kind=all&limit=1")
	if err != nil {
		t.Fatal(err)
	}
	var page map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&page)
	resp.Body.Close()
	cursor, present := page["nextCursor"]
	if !present {
		t.Fatalf("expected a next cursor for a bounded page: %v", page)
	}

	// Present the all-kinds cursor with a movie scope: 400, never mixed scopes.
	mismatch := server.URL + "/v2/library?collection=watch-later&kind=movie&limit=1&cursor=" + cursor.(string)
	resp2, _ := http.Get(mismatch)
	var mismatchBody map[string]any
	_ = json.NewDecoder(resp2.Body).Decode(&mismatchBody)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest || mismatchBody["error"].(map[string]any)["code"] != "invalid_request" {
		t.Fatalf("scope-mismatched cursor = %d %v", resp2.StatusCode, mismatchBody)
	}
}

func TestLibraryCapabilityNegotiation(t *testing.T) {
	// A server WITHOUT the capability still serves the routes when storage
	// exists? No: capability advertisement and handler registration are wired
	// together in the composition root. Here the handlers are mounted with a
	// build that does NOT advertise the capability; a client explicitly
	// requesting it must be rejected with the machine-readable error.
	server, _, _ := libraryTestServer(t, []string{"catalog.bff.v2"})
	req, _ := http.NewRequest(http.MethodPut, server.URL+"/v2/library/tmdb:movie:693134/watch-later", strings.NewReader(`{"enabled":true}`))
	req.Header.Set("X-Torwatch-Capability", library.Capability)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("unadvertised capability request must not succeed silently")
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if code := body["error"].(map[string]any)["code"]; code != "unsupported_capability" && code != "capability_unavailable" {
		t.Fatalf("capability error code = %v", code)
	}
}

func TestLibraryRoutesAbsentWithoutStorage(t *testing.T) {
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	mux := http.NewServeMux()
	LibraryHandlers{Library: nil}.Register(mux) // no storage: no routes
	server := httptest.NewServer(mux)
	defer server.Close()
	resp, err := http.Get(server.URL + "/v2/library?collection=watch-later")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("routes registered without storage: status %d", resp.StatusCode)
	}
}

// Repair pass Fix 2: GET /v2/library/memberships?ids=… returns the confirmed
// flags for requested titles; an id the server does not know is OMITTED, which
// proves absence at the returned revision (cross-client removal visibility).
func TestLibraryMembershipsEndpoint(t *testing.T) {
	server, _, resolver := libraryTestServer(t, []string{library.Capability})
	defer server.Close()

	if status, body := libraryPut(t, server, "tmdb:movie:693134", "watch-later", true); status != http.StatusOK {
		t.Fatalf("seed write = %d %v", status, body)
	}
	if status, body := libraryPut(t, server, "tmdb:tv:1396", "favourite", true); status != http.StatusOK {
		t.Fatalf("seed write = %d %v", status, body)
	}

	// One known id, one unknown id: the unknown one is omitted at revision 2.
	resp, err := http.Get(server.URL + "/v2/library/memberships?ids=" + "tmdb:movie:693134" + ",tmdb:movie:777777")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Revision    string `json:"revision"`
		Memberships []struct {
			CanonicalID string `json:"canonicalId"`
			WatchLater  bool   `json:"watchLater"`
			Favourite   bool   `json:"favourite"`
		} `json:"memberships"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || payload.Revision != "2" {
		t.Fatalf("memberships = %d %v", resp.StatusCode, payload)
	}
	if len(payload.Memberships) != 1 || payload.Memberships[0].CanonicalID != "tmdb:movie:693134" || !payload.Memberships[0].WatchLater {
		t.Fatalf("known membership wrong: %+v", payload.Memberships)
	}

	// After another client removes the title, an omitted id proves absence.
	delete(resolver.titles, "tmdb:movie:693134") // metadata gone
	if status, body := libraryPut(t, server, "tmdb:movie:693134", "watch-later", false); status != http.StatusOK {
		t.Fatalf("removal write = %d %v", status, body)
	}
	resp2, err := http.Get(server.URL + "/v2/library/memberships?ids=tmdb:movie:693134")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var after struct {
		Revision    string `json:"revision"`
		Memberships []struct {
			CanonicalID string `json:"canonicalId"`
			WatchLater  bool   `json:"watchLater"`
		} `json:"memberships"`
	}
	_ = json.NewDecoder(resp2.Body).Decode(&after)
	// The row is retained with watch_later=false — a CONFIRMED false, still
	// returned (not omitted): the flags reconcile to the removal.
	if after.Revision != "3" || len(after.Memberships) != 1 || after.Memberships[0].WatchLater {
		t.Fatalf("post-removal reconciliation wrong: revision %q memberships %+v", after.Revision, after.Memberships)
	}

	// Missing ids parameter: 400.
	resp3, err := http.Get(server.URL + "/v2/library/memberships")
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing ids = %d", resp3.StatusCode)
	}
	// Over-batch: 400.
	resp4, err := http.Get(server.URL + "/v2/library/memberships?ids=" + strings.Repeat("tmdb:movie:1,", 101))
	if err != nil {
		t.Fatal(err)
	}
	resp4.Body.Close()
	if resp4.StatusCode != http.StatusBadRequest {
		t.Fatalf("101 ids = %d", resp4.StatusCode)
	}
}
