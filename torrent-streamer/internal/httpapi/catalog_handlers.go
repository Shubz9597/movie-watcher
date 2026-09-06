package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/imdb"
)

// CatalogHandlers serves the client-neutral /v2/catalog/* contract
// (contracts/v2-catalog-api.md). No endpoint requires Electron, a specific
// platform, or renderer-resident credentials (FR-003).
type CatalogHandlers struct {
	Catalog *catalog.Service
	Build   buildinfo.Info
	// Ratings enriches title detail with IMDb ratings (optional).
	Ratings IMDbRatingReader
	// HouseholdContinue resolves the shared household continue-watching
	// section (optional; nil yields an empty household section).
	HouseholdContinue func(ctx context.Context) ([]string, error)
	// AllowedOrigins is the explicit CORS origin allowlist for the versioned
	// browser/mobile surfaces (config.AllowedClientOriginList). Wildcards are
	// ignored by the allowlist; requests without Origin are unaffected.
	AllowedOrigins []string
}

// Register mounts the /v2/catalog/* routes additively. Responses carry
// origin-allowlisted CORS headers so allowlisted browser/mobile clients
// (feature 002 M1.2) can call the versioned contract from their own origins;
// no credential-bearing surface is exposed this way.
func (h CatalogHandlers) Register(mux *http.ServeMux) {
	allow := NewOriginAllowlist(h.AllowedOrigins)
	routes := []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"GET /v2/catalog/search", h.handleSearch},
		{"GET /v2/catalog/titles/{id}", h.handleTitleDetail},
		{"GET /v2/catalog/titles/{id}/episodes", h.handleEpisodes},
		{"GET /v2/catalog/sections", h.handleSections},
	}
	for _, route := range routes {
		mux.HandleFunc(route.pattern, allowlistCORS(allow, route.handler))
		// Browser/mobile cross-origin preflights arrive as OPTIONS; the
		// allowlist answers them at the same path.
		mux.HandleFunc("OPTIONS "+strings.TrimPrefix(route.pattern, "GET "), allowlistCORS(allow, func(http.ResponseWriter, *http.Request) {}))
	}
}

var clientIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// negotiationContext validates the optional client negotiation headers for a
// request (FR-011): protocol outside the supported range and unadvertised
// capabilities are rejected with machine-readable, sanitized errors.
func negotiationContext(w http.ResponseWriter, r *http.Request, build buildinfo.Info) bool {
	if build.SupportedProtocolRange == nil {
		return true
	}
	protocol := strings.TrimSpace(r.Header.Get("X-Torwatch-Protocol"))
	if protocol == "" {
		protocol = strings.TrimSpace(r.URL.Query().Get("protocol"))
	}
	if protocol != "" {
		value, err := strconv.Atoi(protocol)
		if err != nil || value < build.SupportedProtocolRange[0] || value > build.SupportedProtocolRange[len(build.SupportedProtocolRange)-1] {
			WriteProtocolError(w, "requested protocol is outside the supported range for this surface", build.SupportedProtocolRange)
			return false
		}
	}
	if capability := strings.TrimSpace(r.Header.Get("X-Torwatch-Capability")); capability != "" && !contains(build.Capabilities, capability) {
		WriteCapabilityError(w, "requested capability is not advertised by this server", build.Capabilities)
		return false
	}
	if clientID := strings.TrimSpace(r.URL.Query().Get("clientId")); clientID != "" && !clientIDPattern.MatchString(clientID) {
		writeCatalogError(w, http.StatusBadRequest, "invalid_client_id", "clientId must be a UUID")
		return false
	}
	return true
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code              string   `json:"code"`
	Message           string   `json:"message"`
	DegradedProviders []string `json:"degradedProviders,omitempty"`
}

func writeCatalogError(w http.ResponseWriter, status int, code, message string, degradedProviders ...[]string) {
	body := errorBody{Error: errorDetail{Code: code, Message: message}}
	if len(degradedProviders) > 0 {
		body.Error.DegradedProviders = degradedProviders[0]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeCatalogJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (h CatalogHandlers) handleSearch(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "q parameter is required")
		return
	}
	kind := catalog.TitleType(strings.TrimSpace(r.URL.Query().Get("type")))
	switch kind {
	case "", "all", "movie", "series", "anime":
	default:
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "type must be movie, series, anime, or all")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))

	result := h.Catalog.Search(r.Context(), catalog.SearchQuery{Query: query, Type: kind, Limit: limit})
	if len(result.Titles) == 0 && len(result.DegradedProviders) > 0 {
		writeCatalogError(w, http.StatusServiceUnavailable, "providers_unavailable", "all catalog providers failed", result.DegradedProviders)
		return
	}
	writeCatalogJSON(w, http.StatusOK, map[string]any{
		"query":             query,
		"total":             len(result.Titles),
		"results":           result.Titles,
		"degraded":          len(result.DegradedProviders) > 0,
		"degradedProviders": orEmptySlice(result.DegradedProviders),
	})
}

func (h CatalogHandlers) handleTitleDetail(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	id := r.PathValue("id")
	result := h.Catalog.Detail(r.Context(), id)
	if result.NotFound {
		writeCatalogError(w, http.StatusNotFound, "title_not_found", "no catalog provider knows this title")
		return
	}
	if !result.Found {
		writeCatalogError(w, http.StatusServiceUnavailable, "providers_unavailable", "all catalog providers failed", result.DegradedProviders)
		return
	}
	response := struct {
		catalog.Title
		Ratings map[string]imdb.Rating `json:"ratings,omitempty"`
	}{Title: result.Title}
	if h.Ratings != nil && result.Title.IMDBID != "" {
		if rating, err := h.Ratings.Rating(r.Context(), result.Title.IMDBID); err == nil {
			response.Ratings = map[string]imdb.Rating{"imdb": rating}
		}
	}
	writeCatalogJSON(w, http.StatusOK, response)
}

func (h CatalogHandlers) handleEpisodes(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	id := r.PathValue("id")
	season, err := strconv.Atoi(r.URL.Query().Get("season"))
	if err != nil || season < 0 {
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "season parameter must be a non-negative integer")
		return
	}
	result := h.Catalog.Detail(r.Context(), id)
	ids := map[string]string{}
	if result.Found {
		for namespace, value := range result.Title.ProviderIDs {
			ids[namespace] = value
		}
	}
	if _, ok := ids[catalogNamespace(id)]; !ok {
		if namespace, externalID, err := catalog.ParseTitleID(id); err == nil {
			ids[namespace] = externalID
		}
	}
	episodeResult := h.Catalog.EpisodesWithIDs(r.Context(), ids, season, id)
	if len(episodeResult.Episodes) == 0 && len(episodeResult.DegradedProviders) > 0 {
		writeCatalogError(w, http.StatusServiceUnavailable, "providers_unavailable", "all episode providers failed", episodeResult.DegradedProviders)
		return
	}
	writeCatalogJSON(w, http.StatusOK, map[string]any{
		"titleId":           id,
		"season":            season,
		"episodes":          orEmptySlice(episodeResult.Episodes),
		"degraded":          len(episodeResult.DegradedProviders) > 0,
		"degradedProviders": orEmptySlice(episodeResult.DegradedProviders),
	})
}

// catalogNamespace returns the namespace part of an opaque catalog id, or "".
func catalogNamespace(id string) string {
	namespace, _, err := catalog.ParseTitleID(id)
	if err != nil {
		return ""
	}
	return namespace
}

type sectionResponse struct {
	ID                string           `json:"id"`
	Kind              string           `json:"kind"`
	TitleIDs          []string         `json:"titleIds"`
	Results           *[]catalog.Title `json:"results,omitempty"`
	CachedAt          string           `json:"cachedAt,omitempty"`
	Degraded          bool             `json:"degraded"`
	DegradedProviders []string         `json:"degradedProviders"`
	Page              int              `json:"page,omitempty"`
	TotalPages        int              `json:"totalPages,omitempty"`
}

func (h CatalogHandlers) handleSections(w http.ResponseWriter, r *http.Request) {
	if !negotiationContext(w, r, h.Build) {
		return
	}
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	switch kind {
	case "continue-watching":
		h.handleHouseholdSection(w, r, kind)
		return
	case "trending", "popular":
	default:
		writeCatalogError(w, http.StatusBadRequest, "unsupported_section_kind", "kind must be trending, popular, or continue-watching")
		return
	}

	// Additive parameters (T042.1): optional 1-based page and, for genre
	// rails, a media-type-scoped TMDb genre id. Absent/invalid defaults keep
	// the original single-page behavior byte-compatible.
	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 500 {
			writeCatalogError(w, http.StatusBadRequest, "invalid_request", "page must be an integer between 1 and 500")
			return
		}
		page = value
	}
	genreID := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("genre")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 {
			writeCatalogError(w, http.StatusBadRequest, "invalid_request", "genre must be a positive integer")
			return
		}
		genreID = value
	}
	mediaType := catalog.TitleType(strings.TrimSpace(r.URL.Query().Get("type")))
	if genreID > 0 {
		switch mediaType {
		case catalog.TypeMovie, catalog.TypeSeries:
		default:
			writeCatalogError(w, http.StatusBadRequest, "invalid_request", "type must be movie or series when genre is set")
			return
		}
	} else if mediaType != "" {
		writeCatalogError(w, http.StatusBadRequest, "invalid_request", "type is only valid together with genre")
		return
	}

	result := h.Catalog.SectionQuery(r.Context(), catalog.SectionQuery{Kind: kind, Page: page, GenreID: genreID, Type: mediaType})
	if len(result.TitleIDs) == 0 && len(result.DegradedProviders) > 0 {
		writeCatalogError(w, http.StatusServiceUnavailable, "providers_unavailable", "all section providers failed", result.DegradedProviders)
		return
	}
	result.Titles = orEmptySlice(result.Titles)
	response := sectionResponse{
		ID:                result.SectionID,
		Kind:              "provider",
		TitleIDs:          orEmptySlice(result.TitleIDs),
		Results:           &result.Titles,
		Degraded:          len(result.DegradedProviders) > 0,
		DegradedProviders: orEmptySlice(result.DegradedProviders),
	}
	if page > 1 || genreID > 0 || result.TotalPages > 0 {
		response.Page = result.Page
		response.TotalPages = result.TotalPages
	}
	if len(result.CachedAt) > 0 {
		latest := time.Time{}
		for _, at := range result.CachedAt {
			if at.After(latest) {
				latest = at
			}
		}
		response.CachedAt = latest.UTC().Format(time.RFC3339)
	}
	writeCatalogJSON(w, http.StatusOK, response)
}

func (h CatalogHandlers) handleHouseholdSection(w http.ResponseWriter, r *http.Request, kind string) {
	response := sectionResponse{ID: kind, Kind: "household", TitleIDs: []string{}, DegradedProviders: []string{}}
	if h.HouseholdContinue != nil {
		titleIDs, err := h.HouseholdContinue(r.Context())
		if err != nil {
			writeCatalogError(w, http.StatusInternalServerError, "household_section_failed", "continue-watching section unavailable")
			return
		}
		response.TitleIDs = orEmptySlice(titleIDs)
	}
	response.CachedAt = time.Now().UTC().Format(time.RFC3339)
	writeCatalogJSON(w, http.StatusOK, response)
}

func orEmptySlice[T any](value []T) []T {
	if value == nil {
		return []T{}
	}
	return value
}
