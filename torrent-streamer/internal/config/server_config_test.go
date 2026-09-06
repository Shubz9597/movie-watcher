package config

import (
	"strings"
	"testing"
)

func TestLoadServerConfigAcceptsV1EnvironmentNames(t *testing.T) {
	t.Setenv("PG_DSN", "postgres://torwatch:secret@db:5432/torwatch")
	t.Setenv("INDEXER_URL", "http://prowlarr:9696")
	t.Setenv("INDEXER_API_KEY", "indexer-key")
	t.Setenv("TORRENT_DATA_ROOT", "Z:/data/torrents")
	t.Setenv("SUB_CACHE_DIR", "Z:/data/subcache")
	t.Setenv("LOG_FILE", "watch.log")
	t.Setenv("ERROR_LOG_FILE", "watch-errors.log")
	t.Setenv("TORWATCH_APP_VERSION", "2.0.0-test")
	t.Setenv("LISTEN", "127.0.0.1:4001")

	cfg := LoadServerConfig()
	if cfg.PGDSN != "postgres://torwatch:secret@db:5432/torwatch" {
		t.Fatalf("PG_DSN not read: %q", cfg.PGDSN)
	}
	if cfg.ProwlarrURL != "http://prowlarr:9696" || cfg.ProwlarrAPIKey != "indexer-key" {
		t.Fatalf("indexer names not accepted: %q %q", cfg.ProwlarrURL, cfg.ProwlarrAPIKey)
	}
	if cfg.TorrentDataRoot != "Z:/data/torrents" || cfg.SubCacheDir != "Z:/data/subcache" {
		t.Fatalf("storage roots not read: %q %q", cfg.TorrentDataRoot, cfg.SubCacheDir)
	}
	if cfg.LogFile != "watch.log" || cfg.ErrorLogFile != "watch-errors.log" {
		t.Fatalf("log paths not read: %q %q", cfg.LogFile, cfg.ErrorLogFile)
	}
	if cfg.AppVersion != "2.0.0-test" {
		t.Fatalf("TORWATCH_APP_VERSION not read: %q", cfg.AppVersion)
	}
	if cfg.ListenAddr != "127.0.0.1:4001" {
		t.Fatalf("LISTEN not read: %q", cfg.ListenAddr)
	}
}

func TestLoadServerConfigPrefersIndexerNamesLikeMain(t *testing.T) {
	t.Setenv("INDEXER_URL", "http://indexer-first:9696")
	t.Setenv("PROWLARR_URL", "http://prowlarr-second:9696")
	t.Setenv("INDEXER_API_KEY", "first-key")
	t.Setenv("PROWLARR_API_KEY", "second-key")

	cfg := LoadServerConfig()
	if cfg.ProwlarrURL != "http://indexer-first:9696" {
		t.Fatalf("prowlarr url = %q, want INDEXER_URL precedence", cfg.ProwlarrURL)
	}
	if cfg.ProwlarrAPIKey != "first-key" {
		t.Fatalf("prowlarr key = %q, want INDEXER_API_KEY precedence", cfg.ProwlarrAPIKey)
	}
}

func TestLoadServerConfigFallsBackToProwlarrNames(t *testing.T) {
	t.Setenv("INDEXER_URL", "")
	t.Setenv("INDEXER_API_KEY", "")
	t.Setenv("PROWLARR_URL", "http://prowlarr-only:9696")
	t.Setenv("PROWLARR_API_KEY", "prowlarr-key")

	cfg := LoadServerConfig()
	if cfg.ProwlarrURL != "http://prowlarr-only:9696" || cfg.ProwlarrAPIKey != "prowlarr-key" {
		t.Fatalf("PROWLARR_* fallback failed: %q %q", cfg.ProwlarrURL, cfg.ProwlarrAPIKey)
	}
}

func TestServerConfigValidationNamesMissingSettingsWithoutEchoingSecrets(t *testing.T) {
	cfg := ServerConfig{
		PGDSN:          "postgres://torwatch:supersecret@db:5432/torwatch",
		ProwlarrAPIKey: "prowlarr-supersecret",
	}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected validation error for missing PROWLARR_URL")
	}
	message := err.Error()
	if !strings.Contains(message, "PROWLARR_URL") {
		t.Fatalf("error must name the missing setting: %q", message)
	}
	for _, secret := range cfg.SecretValues() {
		if strings.Contains(message, secret) {
			t.Fatalf("validation error echoed a secret value: %q", message)
		}
	}
}

func TestServerConfigValidatePassesWhenComplete(t *testing.T) {
	cfg := ServerConfig{
		PGDSN:          "postgres://torwatch:x@db:5432/torwatch",
		ProwlarrURL:    "http://prowlarr:9696",
		ProwlarrAPIKey: "key",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestServerConfigListenOrDefault(t *testing.T) {
	if got := (ServerConfig{ListenAddr: "0.0.0.0:5000"}).ListenOrDefault(); got != "0.0.0.0:5000" {
		t.Fatalf("listen override ignored: %q", got)
	}
	if got := (ServerConfig{}).ListenOrDefault(); got != ListenAddr() {
		t.Fatalf("default listen %q != V1 default %q", got, ListenAddr())
	}
}

func TestAllowedClientOriginsDefaultParsesAndRejectsWildcard(t *testing.T) {
	// Unset: the documented default preserves the Electron file:// ("null")
	// and dev-server origins without any wildcard.
	t.Setenv("TORWATCH_ALLOWED_CLIENT_ORIGINS", "")
	config := LoadServerConfig()
	origins, warnings := config.AllowedClientOriginList()
	if len(warnings) != 0 {
		t.Fatalf("default produced warnings: %v", warnings)
	}
	if len(origins) != 2 || origins[0] != "null" || origins[1] != "http://localhost:5173" {
		t.Fatalf("default origins = %v", origins)
	}

	// Explicit CSV: trimmed, deduplicated, case-normalized; wildcard dropped
	// with a warning instead of being honored.
	t.Setenv("TORWATCH_ALLOWED_CLIENT_ORIGINS", " https://TorWatch.LAN ,*,https://torwatch.lan,,http://a.example")
	config = LoadServerConfig()
	origins, warnings = config.AllowedClientOriginList()
	if len(warnings) != 1 {
		t.Fatalf("wildcard warnings = %v, want exactly one", warnings)
	}
	if len(origins) != 2 || origins[0] != "https://torwatch.lan" || origins[1] != "http://a.example" {
		t.Fatalf("parsed origins = %v", origins)
	}
}
