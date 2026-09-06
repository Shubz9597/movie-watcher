package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/httpapi"
)

// TestCatalogEndpointsEndToEnd exercises all four /v2/catalog/* endpoints
// through the real mux assembly used by main(), with every provider pointed
// at local stub servers via the same environment overrides a disposable
// stack would use.
func TestCatalogEndpointsEndToEnd(t *testing.T) {
	tmdb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/3/search/multi":
			_, _ = w.Write([]byte(`{"results":[{"media_type":"tv","id":209867,"name":"Frieren: Beyond Journey's End","original_name":"葬送のフリーレン","first_air_date":"2023-09-29","overview":"tv","poster_path":"/tv.jpg","original_language":"ja","genre_ids":[16,10759]}]}`))
		case "/3/movie/209867":
			http.NotFound(w, r)
		case "/3/tv/209867":
			_, _ = w.Write([]byte(`{"id":209867,"name":"Frieren: Beyond Journey's End","original_name":"葬送のフリーレン","first_air_date":"2023-09-29","overview":"tv","poster_path":"/tv.jpg","episode_run_time":[24],"genres":[{"name":"Animation"}],"original_language":"ja"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(tmdb.Close)
	anilist := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), "Media(id:") {
			_, _ = w.Write([]byte(`{"data":{"Media":{"id":154587,"idMal":52991,"title":{"english":"Frieren: Beyond Journey's End"},"startDate":{"year":2023},"description":"desc","countryOfOrigin":"JP","genres":["Adventure"],"coverImage":{"large":"l.png"},"externalLinks":[],"episodes":28,"duration":24}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"Page":{"media":[{"id":154587,"idMal":52991,"title":{"english":"Frieren: Beyond Journey's End"},"startDate":{"year":2023},"description":"desc","countryOfOrigin":"JP","genres":["Adventure"],"coverImage":{"large":"l.png"},"externalLinks":[],"episodes":28,"duration":24}]}}}`))
	}))
	t.Cleanup(anilist.Close)
	jikan := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"mal_id":52991,"title":"Sousou no Frieren","title_english":"Frieren: Beyond Journey's End","aired":{"from":"2023-09-29"},"images":{"jpg":{"large_image_url":"l.jpg"}},"genres":[],"duration":"24 min per ep"}]}`))
	}))
	t.Cleanup(jikan.Close)
	cinemeta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(cinemeta.Close)
	anizip := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"葬送のフリーレン","english":{"title":"Frieren"},"imdbId":"tt28015436","episodes":{"1":{"season":1,"episode":1,"airDate":"2023-09-29","title":"The Journey's End","image":"e1.png","overview":"start","duration":24}}}`))
	}))
	t.Cleanup(anizip.Close)

	t.Setenv("TMDB_API_KEY", "test-key")
	t.Setenv("TORWATCH_TMDB_BASE_URL", tmdb.URL)
	t.Setenv("TORWATCH_ANILIST_BASE_URL", anilist.URL)
	t.Setenv("TORWATCH_JIKAN_BASE_URL", jikan.URL)
	t.Setenv("TORWATCH_CINEMETA_BASE_URL", cinemeta.URL)
	t.Setenv("TORWATCH_ANIZIP_BASE_URL", anizip.URL)

	build := buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}})
	mux := http.NewServeMux()
	httpapi.RegisterRoutes(mux)
	httpapi.CatalogHandlers{
		Catalog: catalog.NewService(buildCatalogProviders(&http.Client{}), catalog.Options{}),
		Build:   build,
	}.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	get := func(path string) (int, map[string]any) {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer response.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		return response.StatusCode, payload
	}

	status, search := get("/v2/catalog/search?q=frieren&type=all")
	if status != http.StatusOK {
		t.Fatalf("search status = %d: %v", status, search)
	}
	if search["total"] != float64(1) {
		t.Fatalf("search merge wrong (providers must join on normalized title): %v", search["results"])
	}
	results := search["results"].([]any)
	first := results[0].(map[string]any)
	if first["id"] != "tmdb:209867" || first["type"] != "anime" {
		t.Fatalf("joined title wrong: %v", first)
	}
	providerIDs := first["providerIds"].(map[string]any)
	for _, namespace := range []string{"tmdb", "anilist", "jikan"} {
		if providerIDs[namespace] == nil {
			t.Fatalf("providerIds missing %q: %v", namespace, providerIDs)
		}
	}

	status, detail := get("/v2/catalog/titles/anilist:154587")
	if status != http.StatusOK || detail["id"] != "anilist:154587" {
		t.Fatalf("detail = %d %v", status, detail)
	}

	status, episodes := get("/v2/catalog/titles/anilist:154587/episodes?season=1")
	if status != http.StatusOK {
		t.Fatalf("episodes status = %d: %v", status, episodes)
	}
	if len(episodes["episodes"].([]any)) != 1 {
		t.Fatalf("episodes merge wrong: %v", episodes)
	}
	if episodes["episodes"].([]any)[0].(map[string]any)["title"] != "The Journey's End" {
		t.Fatalf("anizip episode enrichment missing: %v", episodes)
	}

	status, sections := get("/v2/catalog/sections?kind=trending")
	if status != http.StatusOK || sections["kind"] != "provider" {
		t.Fatalf("sections = %d %v", status, sections)
	}

	status, _ = get("/v2/catalog/sections?kind=continue-watching")
	if status != http.StatusOK {
		t.Fatalf("household section = %d", status)
	}
}
