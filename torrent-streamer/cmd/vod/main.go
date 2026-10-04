package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
	"github.com/joho/godotenv"

	"torrent-streamer/internal/bootstrap"
	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/catalog"
	"torrent-streamer/internal/config"
	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/httpapi"
	"torrent-streamer/internal/imdb"
	"torrent-streamer/internal/janitor"
	"torrent-streamer/internal/library"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/playback"
	"torrent-streamer/internal/recommendations"
	"torrent-streamer/internal/search"
	"torrent-streamer/internal/skipsegments"
	"torrent-streamer/internal/taste"
	"torrent-streamer/internal/torrentx"
	"torrent-streamer/internal/watch"
	"torrent-streamer/migrations"
)

// startPlaybackSweeper expires playback sessions on a bounded interval.

// tasteAdapter maps the taste store's concrete signal type onto the
// recommendation engine's interface (keeps internal/taste decoupled from
// internal/recommendations).
type tasteAdapter struct {
	store *taste.Store
}

func (a tasteAdapter) HouseholdSignals(ctx context.Context) ([]recommendations.TasteSignal, error) {
	signals, err := a.store.HouseholdSignals(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]recommendations.TasteSignal, 0, len(signals))
	for _, signal := range signals {
		out = append(out, recommendations.TasteSignal{
			CanonicalID: signal.CanonicalID,
			Kind:        signal.Kind,
			Label:       signal.Label,
			Weight:      signal.Weight,
			Title:       signal.Title,
			At:          signal.At,
		})
	}
	return out, nil
}
func startPlaybackSweeper(manager *playback.Manager, interval time.Duration) (stop func()) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				manager.CleanupSweeper()
			}
		}
	}()
	return func() { close(done) }
}

var (
	db         *sql.DB
	pickRepo   *torrentx.Repo
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
	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	_ = godotenv.Load(".env", "../infra/prowlarr.env")

	// initialize config & logging
	config.Load()
	closeLog := config.SetupLogging()
	defer closeLog()

	serverConfig := config.LoadServerConfig()
	mustOpenDB(serverConfig.PGDSN)
	// Persistent server-instance identity (offline-downloads contracts §1):
	// created once in the database, stable across restarts and URL changes;
	// clients scope downloads and offline progress by it, never by URL.
	instanceID, err := downloads.EnsureInstanceID(context.Background(), db)
	if err != nil {
		exitOnError("server instance identity", err)
	}
	log.Printf("[boot] server instance %s", instanceID)
	imdbStore := imdb.NewStore(db)
	pickRepo = &torrentx.Repo{DB: db}
	progressDB = watch.NewStore(db)
	httpapi.SetProgressStore(progressDB) // Enable server-side progress tracking for VLC
	prowlarrURL := serverConfig.ProwlarrURL
	prowlarrAPIKey := serverConfig.ProwlarrAPIKey
	prowlarrHTTP := &http.Client{Timeout: 25 * time.Second}
	// Container deployments enable headless Prowlarr bootstrap by pointing
	// PROWLARR_CONFIG_FILE at a read-only mount of Prowlarr's config.xml
	// (architecture §8). V1 Electron launches never set it, so their behavior
	// is unchanged: Electron keeps providing PROWLARR_API_KEY and waiting.
	if configFile := strings.TrimSpace(os.Getenv("PROWLARR_CONFIG_FILE")); configFile != "" {
		// Bootstrap diagnostics must never be swallowed by the diagnostics
		// allow-list filter: headless operators debug first installs from
		// these lines, and none of them carry secret values.
		bootstrapLog := slog.New(slog.NewTextHandler(os.Stderr, nil))
		res, err := bootstrap.Run(context.Background(), bootstrap.Options{
			BaseURL:     prowlarrURL,
			HTTPClient:  &http.Client{Timeout: 60 * time.Second},
			ExplicitKey: prowlarrAPIKey,
			ConfigFile:  configFile,
			Timeout:     2 * time.Minute,
			Starters:    bootstrap.DefaultStarters(),
			Log:         bootstrapLog,
		})
		if err != nil {
			exitOnError("Prowlarr bootstrap failed", err)
		}
		prowlarrAPIKey = res.APIKey
		log.Printf("[boot] prowlarr bootstrap complete keySource=%s preserved=%d added=%d failed=%d",
			res.KeySource, res.IndexersPreserved, len(res.IndexersAdded), len(res.IndexersFailed))
	}
	torrentSearch, err := search.NewService(prowlarrURL, prowlarrAPIKey, prowlarrHTTP)
	if err != nil {
		exitOnError("Prowlarr configuration failed", err)
	}
	releaseStore := search.SQLReleaseStore{DB: db}
	purgeCtx, cancelPurge := context.WithTimeout(context.Background(), 10*time.Second)
	if purged, err := releaseStore.PurgeOtherVersions(purgeCtx, search.CacheVersion); err != nil {
		log.Printf("[search] purge old release cache: %v", err)
	} else if purged > 0 {
		log.Printf("[search] purged %d release cache rows from older versions", purged)
	}
	cancelPurge()
	torrentSearch.SetStore(releaseStore)

	// prepare torrentx (root dirs, initial state)
	torrentx.Init()

	// http mux & routes (endpoints are IDENTICAL to your original service)
	mux := http.NewServeMux()
	tasteStore := taste.New(db)
	httpapi.RegisterRoutes(mux)         // /add, /files, /prefetch, /stream, /stats, /buffer/*
	httpapi.RegisterSubtitleRoutes(mux) // /subtitles/list, /subtitles/torrent, /subtitles/external, /subtitles/import
	httpapi.RegisterTasteRoutes(mux, taste.New(db))
	mux.HandleFunc("/skip-segments", skipsegments.Handler)
	httpapi.TorrentSearchHandlers{Service: torrentSearch}.Register(mux)
	httpapi.IMDbRatingHandlers{Ratings: imdbStore}.Register(mux)

	// V2 system surface (additive): readiness + version/protocol negotiation.
	// catalog.bff.v2 is advertised from the catalog phase onward; further
	// capabilities are added only when they actually land.
	catalogProviders := buildCatalogProviders(prowlarrHTTP)
	catalogService := catalog.NewService(catalogProviders, catalog.Options{})
	// Household library (feature 002 M3.2): advertise library.household.v1
	// ONLY when the schema is initialized and the storage-backed service
	// opened; an uninitialized schema keeps the routes absent and the
	// capability unadvertised (contracts/library-api.md §negotiation).
	libraryStore, libraryErr := library.NewStore(context.Background(), db, library.CatalogResolver{Catalog: catalogService})
	if libraryErr != nil {
		log.Printf("[boot] library capability unavailable: %v", libraryErr)
	}
	capabilities := []string{"catalog.bff.v2", "leases.shared", "progress.serverOrdered"}
	if libraryStore != nil {
		capabilities = append(capabilities, library.Capability)
	}
	// Offline downloads (D02b): the prepper claims preparing jobs through the
	// torrent engine into a SEPARATE downloads root the cache janitor never
	// evicts. The downloads.offline.v1 capability is advertised only when the
	// preparation pipeline is functional (storage root writable) — never as a
	// promise (contracts.md §2).
	var downloadPrepper *downloads.Prepper
	if downloadRootAbs, rootErr := filepath.Abs(config.DownloadsRoot()); rootErr == nil &&
		os.MkdirAll(filepath.Join(downloadRootAbs, "ready"), 0o755) == nil &&
		os.MkdirAll(filepath.Join(downloadRootAbs, "staging"), 0o755) == nil {
		downloadPrepper = downloads.NewPrepper(downloads.NewStore(db), pickRepo, downloadRootAbs, config.DownloadMaxConcurrent())
		// Requested subtitle languages missing from the torrent fall back to
		// the OpenSubtitles credential the player already uses.
		downloadPrepper.Subtitles = httpapi.DownloadSubtitleSource{}
		if released, err := downloadPrepper.ReconcileStartup(rootCtx); err != nil {
			log.Printf("[boot] downloads.offline.v1 unavailable: reconciliation failed: %v", err)
			downloadPrepper = nil
		} else {
			if released > 0 {
				log.Printf("[boot] reconciled %d preparing download jobs from a previous run", released)
			}
			capabilities = append(capabilities, "downloads.offline.v1", "downloads.subtitles.v1")
			log.Printf("[boot] downloads.offline.v1 ready (root=%s maxConcurrent=%d)", downloadRootAbs, config.DownloadMaxConcurrent())
		}
	} else {
		log.Printf("[boot] downloads.offline.v1 unavailable: the download storage root is not writable")
	}
	// Recommendations (M4.1): wired ONLY when the household library and a
	// catalog candidate provider both exist; the capability is advertised only
	// then (contracts/recommendations-api.md §Negotiation). The v2 taste
	// engine: when the taste store is available, scoring uses the household
	// taste profile (favourites + Watch Later + watch progress + opened
	// titles); per-seed similar candidates route by namespace (TMDb for
	// tmdb: seeds, AniList recommendations for anilist: seeds).
	var recommendationService *recommendations.Service
	if libraryStore != nil {
		for _, provider := range catalogProviders {
			if candidateProvider, ok := provider.(catalog.CandidateProvider); ok {
				deps := recommendations.Deps{
					Library:               libraryStore,
					Candidates:            recommendations.CatalogCandidates{Provider: candidateProvider},
					SeedGenres:            recommendations.CatalogSeedGenres{Catalog: catalogService},
					SeedSimilar:           recommendations.CatalogSeedSimilar{Provider: candidateProvider},
					CandidateCacheVersion: recommendations.CandidatePoolVersion,
				}
				// Crossover (movies for series, series for movies) by shared
				// keywords and mapped genres.
				if tmdbProvider, ok := candidateProvider.(*catalog.TMDb); ok {
					deps.CrossSimilar = recommendations.TMDbCrossSimilar{Provider: tmdbProvider}
				}
				for _, p := range catalogProviders {
					if anilistProvider, ok := p.(*catalog.AniList); ok {
						deps.SeedSimilar = recommendations.NamespaceSeedSimilar{
							TMDb:    recommendations.CatalogSeedSimilar{Provider: candidateProvider},
							AniList: recommendations.AniListSeedSimilar{Provider: anilistProvider},
						}
						break
					}
				}
				if tasteStore != nil {
					deps.Taste = tasteAdapter{store: tasteStore}
				}
				recommendationService = recommendations.New(deps)
				break
			}
		}
	}
	if recommendationService != nil {
		capabilities = append(capabilities, recommendations.Capability)
		// Compute once at startup so the first Home load after a deploy
		// does not wait for dozens of provider calls.
		recommendationService.Warm()
	}
	// Playback compatibility service (M1.3.x): the shared mobile playback
	// foundation. The capability is advertised ONLY when BOTH ffprobe and
	// ffmpeg are configured, executable, and self-identifying — an
	// unconfigured toolchain keeps the routes absent and /v1/version honest.
	var playbackManager *playback.Manager
	{
		tools := playback.Tools{FFprobePath: config.FFprobePath(), FFmpegPath: config.FFmpegPath()}
		if ok, why := tools.Available(context.Background()); !ok {
			log.Printf("[boot] playback.compat.v1 unavailable: %s", why)
		} else if source, srcErr := playback.NewMediaSource(); srcErr != nil {
			log.Printf("[boot] playback.compat.v1 unavailable: media source could not start: %v", srcErr)
		} else {
			// Source resolution: the torrent resolver is the production path.
			// A configured fixture root (TORWATCH_PLAYBACK_FIXTURE_ROOT)
			// replaces it for VALIDATION deployments so deterministic
			// evidence can be produced without torrent peers. The fixture
			// resolver only ever serves direct children of that root.
			var playbackResolver playback.Resolver = &playback.TorrentResolver{WaitMetadata: config.WaitMetadata()}
			if fixtureRoot := config.PlaybackFixtureRoot(); fixtureRoot != "" {
				playbackResolver = &playback.FixtureResolver{Root: fixtureRoot}
				log.Printf("[boot] playback fixture source ACTIVE (validation only): sessions resolve media from the configured fixture root")
			}
			manager := playback.NewManager(
				playback.Config{
					DataRoot:            config.PlaybackDataRoot(),
					MaxActiveTranscodes: config.PlaybackMaxTranscodes(),
					SessionTTL:          config.PlaybackSessionTTL(),
					ProbeTimeout:        config.PlaybackProbeTimeout(),
					MaxTranscodeHeight:  config.PlaybackMaxTranscodeHeight(),
					MaxSessions:         config.PlaybackMaxSessions(),
					TranscodeDisabled:   !config.PlaybackTranscodeAllowed(),
				},
				tools,
				&playback.FFprobeProber{Tools: tools, Timeout: config.PlaybackProbeTimeout()},
				playbackResolver, source,
			)
			manager.SweepStaleAtStartup()
			stopSweep := startPlaybackSweeper(manager, config.PlaybackSessionTTL()/4)
			defer stopSweep()
			defer manager.Stop()
			playbackManager = manager
			capabilities = append(capabilities, "playback.compat.v1")
			log.Printf("[boot] playback.compat.v1 ready (transcodes<=%d ttl=%s root=%s transcodeMode=%s)",
				config.PlaybackMaxTranscodes(), config.PlaybackSessionTTL(), config.PlaybackDataRoot(),
				map[bool]string{true: "auto", false: "off"}[config.PlaybackTranscodeAllowed()])
		}
	}
	build := buildinfo.New(buildinfo.Options{
		ServerVersion: serverConfig.AppVersion,
		Capabilities:  capabilities,
		InstanceID:    instanceID,
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
		Catalog:        catalogService,
		Build:          build,
		Ratings:        imdbStore,
		AllowedOrigins: allowedOrigins,
	}.Register(mux)
	httpapi.LibraryHandlers{
		Library:        libraryStore,
		Build:          build,
		AllowedOrigins: allowedOrigins,
	}.Register(mux)
	httpapi.RecommendationHandlers{
		Recommendations: recommendationService,
		Build:           build,
		AllowedOrigins:  allowedOrigins,
	}.Register(mux)
	httpapi.PlaybackHandlers{
		Manager:        playbackManager,
		Build:          build,
		AllowedOrigins: allowedOrigins,
		PlaybackRoot:   config.PlaybackDataRoot(),
	}.Register(mux)
	// Offline downloads (D02a): durable job surface behind the finalized
	// contract. With D02b the prep pipeline runs and the capability is
	// advertised; the surface stays inert when the pipeline is unavailable.
	httpapi.DownloadsHandlers{
		Store:          downloads.NewStore(db),
		SourceResolver: torrentSearch,
		Picks:          pickRepo,
		Build:          build,
		AllowedOrigins: allowedOrigins,
		AssetRoot:      config.DownloadsRoot(),
	}.Register(mux)
	downloadDone := make(chan struct{})
	if downloadPrepper != nil {
		go func() { defer close(downloadDone); downloadPrepper.Run(rootCtx) }()
	} else {
		close(downloadDone)
	}

	sess := httpapi.NewSessionHandlers(httpapi.SessionDeps{Watch: progressDB})
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

	go refreshIMDbRatings(rootCtx, imdbStore)

	// start janitor
	go janitor.Run(rootCtx)

	// http server with recover middleware
	srv := &http.Server{
		Addr:        addr,
		BaseContext: func(net.Listener) context.Context { return rootCtx },
		Handler:     middleware.Recover(mux),
		ErrorLog:    slog.NewLogLogger(slog.Default().Handler(), slog.LevelError),
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
	if err := srv.Shutdown(shCtx); err != nil {
		_ = srv.Close()
	}
	select {
	case <-downloadDone:
	case <-shCtx.Done():
		log.Printf("[boot] download worker shutdown exceeded the grace period")
	}

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

// buildCatalogProviders assembles the server-side catalog providers in fixed
// priority order (contracts/v2-catalog-api.md §Merge determinism). Provider
// credentials never leave the backend (FR-003/FR-012); a provider without
// its credentials is simply absent from the registry. Base URLs are
// overridable for disposable-stack testing.
func buildCatalogProviders(client *http.Client) []catalog.Provider {
	var providers []catalog.Provider
	apiKey, accessToken := os.Getenv("TMDB_API_KEY"), os.Getenv("TMDB_ACCESS_TOKEN")
	if apiKey != "" || accessToken != "" {
		providers = append(providers, catalog.NewTMDb(catalog.TMDbOptions{
			BaseURL:     envOr("TORWATCH_TMDB_BASE_URL", ""),
			APIKey:      apiKey,
			AccessToken: accessToken,
			HTTP:        client,
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
