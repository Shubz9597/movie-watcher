package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
	"github.com/joho/godotenv"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/config"
	"torrent-streamer/internal/httpapi"
	"torrent-streamer/internal/imdb"
	"torrent-streamer/internal/janitor"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/scoring"
	"torrent-streamer/internal/search"
	"torrent-streamer/internal/torrentx"
	"torrent-streamer/internal/watch"
	"torrent-streamer/migrations"
)

var (
	db         *sql.DB
	pickRepo   *torrentx.Repo
	searchCli  *torrentx.TorznabClient
	progressDB *watch.Store
)

func mustOpenDB(dsn string) {
	if dsn == "" {
		exitOnError("database configuration missing", errors.New("environment variable PG_DSN is missing"))
	}
	var err error
	db, err = sql.Open("pgx", dsn)
	if err != nil {
		exitOnError("database initialization failed", err)
	}
	if err := db.PingContext(context.Background()); err != nil {
		exitOnError("database connection failed", err)
	}
	if err := migrations.Apply(context.Background(), db); err != nil {
		exitOnError("database migrations failed", err)
	}
	log.Println("[db] connected")
}

func main() {
	_ = godotenv.Load(".env", "../infra/prowlarr.env")

	// initialize config & logging
	config.Load()
	closeLog := config.SetupLogging()
	defer closeLog()

	serverConfig := config.LoadServerConfig()
	mustOpenDB(serverConfig.PGDSN)
	imdbStore := imdb.NewStore(db)
	pickRepo = &torrentx.Repo{DB: db}
	progressDB = watch.NewStore(db)
	httpapi.SetProgressStore(progressDB) // Enable server-side progress tracking for VLC
	prowlarrURL := serverConfig.ProwlarrURL
	prowlarrAPIKey := serverConfig.ProwlarrAPIKey
	prowlarrHTTP := &http.Client{Timeout: 25 * time.Second}
	searchCli = &torrentx.TorznabClient{BaseURL: prowlarrURL, APIKey: prowlarrAPIKey, HTTP: prowlarrHTTP}
	torrentSearch, err := search.NewService(prowlarrURL, prowlarrAPIKey, prowlarrHTTP)
	if err != nil {
		exitOnError("Prowlarr configuration failed", err)
	}

	// prepare torrentx (root dirs, initial state)
	torrentx.Init()

	// http mux & routes (endpoints are IDENTICAL to your original service)
	mux := http.NewServeMux()
	httpapi.RegisterRoutes(mux)         // /add, /files, /prefetch, /stream, /stats, /buffer/*
	httpapi.RegisterSubtitleRoutes(mux) // /subtitles/list, /subtitles/torrent, /subtitles/external
	httpapi.TorrentSearchHandlers{Service: torrentSearch}.Register(mux)
	httpapi.IMDbRatingHandlers{Ratings: imdbStore}.Register(mux)

	// V2 system surface (additive): readiness + version/protocol negotiation.
	// catalog.bff.v2 is advertised from the catalog phase onward; further
	// capabilities are added only when they actually land.
	catalogProviders := buildCatalogProviders(prowlarrHTTP)
	build := buildinfo.New(buildinfo.Options{
		ServerVersion: serverConfig.AppVersion,
		Capabilities:  []string{"catalog.bff.v2", "leases.shared", "progress.serverOrdered"},
	})
	// Explicit CORS origin allowlist for the versioned browser/mobile
	// surfaces; default preserves the Electron file:// and dev-server origins.
	allowedOrigins, corsWarnings := serverConfig.AllowedClientOriginList()
	for _, warning := range corsWarnings {
		log.Printf("[boot] config warning: %s", warning)
	}
	for _, origin := range allowedOrigins {
		if origin == "null" {
			log.Printf("[boot] opaque origin \"null\" allowed on read-only versioned surfaces (packaged file:// renderer compatibility; override TORWATCH_ALLOWED_CLIENT_ORIGINS to harden)")
		}
	}
	httpapi.SystemHandlers{
		Build:          build,
		Postgres:       func(ctx context.Context) error { return db.PingContext(ctx) },
		Prowlarr:       prowlarrReadinessCheck(prowlarrHTTP, prowlarrURL, prowlarrAPIKey),
		AllowedOrigins: allowedOrigins,
	}.Register(mux)
	httpapi.CatalogHandlers{
		Catalog:        catalog.NewService(catalogProviders, catalog.Options{}),
		Build:          build,
		Ratings:        imdbStore,
		AllowedOrigins: allowedOrigins,
	}.Register(mux)

	sess := httpapi.NewSessionHandlers(httpapi.SessionDeps{
		Picks: torrentx.EnsureDeps{
			Repo:   pickRepo,
			Search: searchCli,
		},
		Watch:       progressDB,
		ProfileCaps: scoring.ProfileCaps{CodecAllow: map[string]bool{"h264": true, "hevc": true, "av1": true}},
	})
	sess.Register(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	// watch/lease manager wiring — V1 lease semantics preserved with
	// configurable stale/reaper timings and the T056/T057 admission policy
	// (distinct-key counting; denial never touches healthy leases).
	mgr := watch.NewManager(
		config.WatchStaleAfter(),
		config.WatchReaperInterval(),
		func(k watch.Key) error { return torrentx.EnsureTorrentForKey(k.Cat, k.ID) },
		func(k watch.Key) { torrentx.StopTorrentForKey(k.Cat, k.ID) },
	)
	mgr.SetMaxActiveTitles(config.MaxActiveTitles())
	mgr.SetCapacityRetryAfter(config.WatchReaperInterval())
	httpapi.SetAdmissionSnapshot(mgr.AdmissionSnapshot)

	// CORS-wrapped watch endpoints
	mux.HandleFunc("/watch/open", func(w http.ResponseWriter, r *http.Request) {
		middleware.EnableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandleOpen(w, r)
	})
	mux.HandleFunc("/watch/ping", func(w http.ResponseWriter, r *http.Request) {
		middleware.EnableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandlePing(w, r)
	})
	mux.HandleFunc("/watch/close", func(w http.ResponseWriter, r *http.Request) {
		middleware.EnableCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		mgr.HandleClose(w, r)
	})

	// not found for everything else (with CORS preflight support)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			middleware.EnableCORS(w)
			return
		}
		http.NotFound(w, r)
	})

	addr := config.ListenAddr()
	log.Printf("[boot] VOD listening on %s root=%s prebuffer=%dB/%s waitMetadata=%s trackersMode=%s",
		addr, config.DataRoot(), config.PrebufferBytes(), config.PrebufferTimeout(), config.WaitMetadata(), config.TrackersMode())

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go refreshIMDbRatings(rootCtx, imdbStore)

	// start janitor
	go janitor.Run(rootCtx)

	// http server with recover middleware
	srv := &http.Server{
		Addr:     addr,
		Handler:  middleware.Recover(mux),
		ErrorLog: slog.NewLogLogger(slog.Default().Handler(), slog.LevelError),
	}

	// serve
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			exitOnError("HTTP server stopped unexpectedly", err)
		}
	}()

	// wait for Ctrl+C
	<-rootCtx.Done()
	log.Printf("[boot] shutdown requested")

	// graceful shutdown window
	shCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)

	// stop watch leases
	mgr.Shutdown()

	// close torrent clients
	torrentx.CloseAllClients()

	log.Printf("[boot] shutdown complete")
}

func exitOnError(message string, err error) {
	slog.Error(message, "err", err)
	os.Exit(1)
}

func refreshIMDbRatings(ctx context.Context, store *imdb.Store) {
	const (
		refreshInterval = 24 * time.Hour
		retryInterval   = 6 * time.Hour
	)
	client := &http.Client{Timeout: 15 * time.Minute}
	datasetURL := os.Getenv("IMDB_RATINGS_URL")
	refresh := func() {
		refreshContext, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		result, err := store.RefreshIfDue(refreshContext, client, datasetURL, time.Now(), refreshInterval)
		if err != nil {
			log.Printf("[imdb] ratings refresh failed: %v", err)
			return
		}
		if result.Updated {
			log.Printf("[imdb] imported %d current ratings", result.RowCount)
		}
	}

	refresh()
	ticker := time.NewTicker(retryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

// buildCatalogProviders assembles the server-side catalog providers in fixed
// priority order (contracts/v2-catalog-api.md §Merge determinism). Provider
// credentials never leave the backend (FR-003/FR-012); a provider without
// its credentials is simply absent from the registry. Base URLs are
// overridable for disposable-stack testing.
func buildCatalogProviders(client *http.Client) []catalog.Provider {
	var providers []catalog.Provider
	if apiKey := os.Getenv("TMDB_API_KEY"); apiKey != "" {
		providers = append(providers, catalog.NewTMDb(catalog.TMDbOptions{
			BaseURL: envOr("TORWATCH_TMDB_BASE_URL", ""), APIKey: apiKey, HTTP: client,
		}))
	}
	providers = append(providers,
		catalog.NewAniList(catalog.AniListOptions{BaseURL: envOr("TORWATCH_ANILIST_BASE_URL", ""), HTTP: client}),
		catalog.NewJikan(catalog.JikanOptions{BaseURL: envOr("TORWATCH_JIKAN_BASE_URL", ""), HTTP: client}),
		catalog.NewCinemeta(catalog.CinemetaOptions{BaseURL: envOr("TORWATCH_CINEMETA_BASE_URL", ""), HTTP: client}),
		catalog.NewAniZip(catalog.AniZipOptions{BaseURL: envOr("TORWATCH_ANIZIP_BASE_URL", ""), HTTP: client}),
	)
	return providers
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// prowlarrReadinessCheck probes the Prowlarr health endpoint; failures mark
// the component degraded for /readyz without leaking credentials (FR-012).
func prowlarrReadinessCheck(client *http.Client, baseURL, apiKey string) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		if baseURL == "" {
			return errors.New("prowlarr url is not configured")
		}
		endpoint := strings.TrimRight(baseURL, "/") + "/api/v1/health"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		req.Header.Set("X-Api-Key", apiKey)
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("prowlarr health status %d", resp.StatusCode)
		}
		return nil
	}
}
