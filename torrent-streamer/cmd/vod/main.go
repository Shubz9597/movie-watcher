package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
	"github.com/joho/godotenv"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/httpapi"
	"torrent-streamer/internal/janitor"
	"torrent-streamer/internal/middleware"
	"torrent-streamer/internal/scoring"
	"torrent-streamer/internal/torrentx"
	"torrent-streamer/internal/watch"
)

var (
	db         *sql.DB
	pickRepo   *torrentx.Repo
	searchCli  *torrentx.TorznabClient
	progressDB *watch.Store
)

func mustOpenDB() {
	dsn := os.Getenv("PG_DSN")
	if dsn == "" {
		log.Fatal("PG_DSN missing")
	}
	var err error
	db, err = sql.Open("pgx", dsn)
	if err != nil {
		log.Fatal(err)
	}
	if err := db.PingContext(context.Background()); err != nil {
		log.Fatal(err)
	}
	log.Println("[db] connected")
}

func main() {
	_ = godotenv.Load(".env")

	// initialize config & logging
	config.Load()
	config.SetupLogging()

	mustOpenDB()
	pickRepo = &torrentx.Repo{DB: db}
	progressDB = watch.NewStore(db)
	httpapi.SetProgressStore(progressDB) // Enable server-side progress tracking for VLC
	searchCli = &torrentx.TorznabClient{
		BaseURL: os.Getenv("INDEXER_URL"),
		APIKey:  os.Getenv("INDEXER_API_KEY"),
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}

	// prepare torrentx (root dirs, initial state)
	torrentx.Init()

	// http mux & routes (endpoints are IDENTICAL to your original service)
	mux := http.NewServeMux()
	httpapi.RegisterRoutes(mux)         // /add, /files, /prefetch, /stream, /stats, /buffer/*
	httpapi.RegisterSubtitleRoutes(mux) // /subtitles/list, /subtitles/torrent, /subtitles/external

	sess := httpapi.NewSessionHandlers(httpapi.SessionDeps{
		Picks: torrentx.EnsureDeps{
			Repo:   pickRepo,
			Search: searchCli,
		},
		Watch:       progressDB,
		ProfileCaps: scoring.ProfileCaps{CodecAllow: map[string]bool{"h264": true, "hevc": true, "av1": true}},
	})
	sess.Register(mux)
	// watch/lease manager wiring — same semantics as your main.go
	mgr := watch.NewManager(
		20*time.Second, // staleAfter
		30*time.Second, // ticker
		func(k watch.Key) error { return torrentx.EnsureTorrentForKey(k.Cat, k.ID) },
		func(k watch.Key) { torrentx.StopTorrentForKey(k.Cat, k.ID) },
	)

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

	// start janitor
	go janitor.Run(rootCtx)

	// http server with recover middleware
	srv := &http.Server{
		Addr:     addr,
		Handler:  middleware.Recover(mux),
		ErrorLog: log.New(log.Writer(), "[http] ", 0),
	}

	// serve
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
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
