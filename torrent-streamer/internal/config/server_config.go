package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// ServerConfig is the package-safe view of the V1 server environment
// contract. It reads the exact environment variable names the Electron
// launcher has always provided (contracts/v1-compat.md §Client launch
// contract) and adds no new defaults: container-specific values arrive via
// the deployment environment only.
type ServerConfig struct {
	PGDSN           string
	ProwlarrURL     string
	ProwlarrAPIKey  string
	TorrentDataRoot string
	SubCacheDir     string
	LogFile         string
	ErrorLogFile    string
	AppVersion      string
	ListenAddr      string
	// AllowedClientOrigins gates CORS on the versioned browser/mobile
	// surfaces (/v1/version, /readyz, /v2/catalog/*). Explicit allowlist —
	// never a wildcard. Parsed via AllowedClientOriginList.
	AllowedClientOrigins string
}

// DefaultAllowedClientOrigins preserves Electron behavior without
// configuration: `npm run dev` and unpackaged launches load the renderer
// from http://localhost:5173, while the PACKAGED Electron build loads
// dist/index.html via loadFile (main.js), so cross-origin fetches arrive
// with the opaque Chromium origin `Origin: null`. Accepting the literal
// "null" entry is a NARROW, documented compatibility measure: it applies
// only to the read-only, credential-free versioned surfaces
// (/v1/version, /readyz, /v2/catalog/*) AND the household library surface
// — the packaged desktop renderer (M3.3) writes its Library from the same
// opaque origin. KNOWN BOUNDARY: an opaque origin is not attributable, so a
// sandboxed iframe on a public page shares `Origin: null`; Chromium Private
// Network Access is the current mitigation. The durable fix is serving the
// packaged renderer from a non-opaque origin (M5 native shell) and then
// dropping "null" (or restricting it to reads) — see
// internal/httpapi/library_handlers.go. Operators may still harden by
// overriding TORWATCH_ALLOWED_CLIENT_ORIGINS without the "null" entry
// (packaged bff-mode clients then require a served origin).
const DefaultAllowedClientOrigins = "null,http://localhost:5173"

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

// LoadServerConfig reads the V1 server environment names. Precedence for the
// indexer endpoint/credentials mirrors cmd/vod (INDEXER_* first, then
// PROWLARR_*) so behavior is unchanged for existing launchers.
func LoadServerConfig() ServerConfig {
	allowedOrigins := os.Getenv("TORWATCH_ALLOWED_CLIENT_ORIGINS")
	if allowedOrigins == "" {
		allowedOrigins = DefaultAllowedClientOrigins
	}
	return ServerConfig{
		PGDSN:                os.Getenv("PG_DSN"),
		ProwlarrURL:          firstEnv("INDEXER_URL", "PROWLARR_URL"),
		ProwlarrAPIKey:       firstEnv("INDEXER_API_KEY", "PROWLARR_API_KEY"),
		TorrentDataRoot:      os.Getenv("TORRENT_DATA_ROOT"),
		SubCacheDir:          os.Getenv("SUB_CACHE_DIR"),
		LogFile:              os.Getenv("LOG_FILE"),
		ErrorLogFile:         os.Getenv("ERROR_LOG_FILE"),
		AppVersion:           os.Getenv("TORWATCH_APP_VERSION"),
		ListenAddr:           os.Getenv("LISTEN"),
		AllowedClientOrigins: allowedOrigins,
	}
}

// AllowedClientOriginList parses the configured CSV allowlist. A wildcard
// entry is rejected by dropping it (with a marker in the returned warnings)
// so a "*" can never reintroduce unconstrained cross-origin reads on the
// versioned surfaces. Comparison is case-insensitive; entries are trimmed
// and de-duplicated.
func (c ServerConfig) AllowedClientOriginList() (origins []string, warnings []string) {
	seen := map[string]bool{}
	for _, raw := range strings.Split(c.AllowedClientOrigins, ",") {
		origin := strings.ToLower(strings.TrimSpace(raw))
		if origin == "" {
			continue
		}
		if origin == "*" {
			warnings = append(warnings, "wildcard CORS origin requested but ignored; list explicit client origins instead")
			continue
		}
		if seen[origin] {
			continue
		}
		seen[origin] = true
		origins = append(origins, origin)
	}
	if origins == nil {
		origins = []string{}
	}
	return origins, warnings
}

// Validate reports whether the configuration is sufficient to start the
// server. Error messages name the missing setting but never echo secret
// values (constitution principle VI).
func (c ServerConfig) Validate() error {
	var missing []string
	if strings.TrimSpace(c.PGDSN) == "" {
		missing = append(missing, "PG_DSN")
	}
	if strings.TrimSpace(c.ProwlarrURL) == "" {
		missing = append(missing, "PROWLARR_URL (or INDEXER_URL)")
	}
	if strings.TrimSpace(c.ProwlarrAPIKey) == "" {
		missing = append(missing, "PROWLARR_API_KEY (or INDEXER_API_KEY)")
	}
	if len(missing) > 0 {
		return fmt.Errorf("server configuration missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

// ListenOrDefault returns the configured listen address or the V1 default.
func (c ServerConfig) ListenOrDefault() string {
	if strings.TrimSpace(c.ListenAddr) != "" {
		return c.ListenAddr
	}
	return ListenAddr()
}

// SecretValues returns the secret material held by this config so callers can
// assert it never reaches logs or error messages.
func (c ServerConfig) SecretValues() []string {
	var secrets []string
	if dsn := c.PGDSN; dsn != "" {
		secrets = append(secrets, dsn)
	}
	if key := c.ProwlarrAPIKey; key != "" {
		secrets = append(secrets, key)
	}
	return secrets
}

// ErrConfigInvalid marks validation failures for callers that need to
// distinguish configuration problems from other startup errors.
var ErrConfigInvalid = errors.New("invalid server configuration")
