// Package bootstrap owns the headless Prowlarr initialization that Electron
// performed in Version 1 (docs/v2-server-package/architecture.md §8): wait for
// Prowlarr readiness, obtain the API key from an explicit secret or the
// generated configuration file, and install the starter indexers on an EMPTY
// instance without ever mutating a populated one.
//
// The package is OFF by default: the V1 Electron launcher keeps providing
// PROWLARR_API_KEY and does the waiting itself, so behavior is unchanged
// unless the deployment enables it via PROWLARR_CONFIG_FILE (container path).
package bootstrap

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Starter is the declarative definition of one starter indexer. The values
// mirror the V1 Electron launcher's DEFAULT_PROWLARR_INDEXERS
// (electron-app/electron/runtime/runtime-manager.js); a parity test
// (starters_parity_test.go) prevents drift between the two copies.
type Starter struct {
	Definition     string         // indexer/schema definitionFile match
	Implementation string         // indexer/schema implementation match
	Name           string         // display name in Prowlarr
	Priority       int            // Prowlarr indexer priority
	MinimumSeeders int            // torrentBaseSettings.appMinimumSeeders
	Enabled        *bool          // nil defaults to enabled
	PreferMagnet   *bool          // nil keeps the V1 default (true)
	Fields         map[string]any // extra provider fields set on the schema
}

// Result reports what the bootstrap did. It never carries secret values.
type Result struct {
	APIKey            string   `json:"-"`
	KeySource         string   `json:"keySource"` // "explicit" | "config-file"
	IndexersPreserved int      `json:"indexersPreserved"`
	IndexersAdded     []string `json:"indexersAdded"`
	IndexersFailed    []string `json:"indexersFailed"`
}

// Options configures one bootstrap run.
type Options struct {
	// BaseURL is Prowlarr's internal endpoint (e.g. http://prowlarr:9696).
	BaseURL string
	// HTTPClient performs Prowlarr API calls.
	HTTPClient *http.Client
	// ExplicitKey is the operator-provided PROWLARR_API_KEY, if any. When set
	// it is always preferred over the generated configuration file.
	ExplicitKey string
	// ConfigFile points at Prowlarr's generated config.xml, typically a
	// read-only bind mount of the prowlarr data directory. Required only when
	// ExplicitKey is empty.
	ConfigFile string
	// Starters is the starter indexer set for empty instances. Empty disables
	// starter installation.
	Starters []Starter
	// Timeout bounds the whole run (key wait + readiness + starter install).
	Timeout time.Duration
	// PollInterval is the wait between config-file/readiness polls.
	PollInterval time.Duration
	// Log receives sanitized progress lines. Nil uses slog.Default().
	Log *slog.Logger
}

// DefaultStarters returns the V1 starter set. See starters_parity_test.go.
func DefaultStarters() []Starter {
	preferFalse := false
	return []Starter{
		{Definition: "yts", Name: "YTS", Priority: 10, MinimumSeeders: 3},
		{
			Definition: "nyaasi", Name: "Nyaa.si", Priority: 10, MinimumSeeders: 1,
			Fields: map[string]any{
				"prefer_magnet_links":  true,
				"sonarr_compatibility": true,
				"strip_s01":            true,
				"radarr_compatibility": false,
				"filter-id":            2,
				"cat-id":               0,
				"sort":                 0,
				"type":                 1,
			},
		},
		{Implementation: "SubsPlease", Name: "SubsPlease", Priority: 10, MinimumSeeders: 1},
		{Implementation: "Knaben", Name: "Knaben", Priority: 20, MinimumSeeders: 2, Enabled: &preferFalse},
		{Definition: "torrentdownload", Name: "TorrentDownload", Priority: 20, MinimumSeeders: 2},
		{Definition: "thepiratebay", Name: "The Pirate Bay", Priority: 25, MinimumSeeders: 2},
		{Definition: "limetorrents", Name: "LimeTorrents", Priority: 25, MinimumSeeders: 2, PreferMagnet: &preferFalse},
	}
}

// installMu serializes starter installation across concurrent Run calls.
var installMu sync.Mutex

// Run performs the bounded bootstrap sequence. It is fail-closed on key or
// readiness errors (the server cannot serve torrent search without a key) and
// degraded-tolerant on individual starter failures.
func Run(ctx context.Context, opts Options) (Result, error) {
	if opts.Timeout <= 0 {
		opts.Timeout = 2 * time.Minute
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = time.Second
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if strings.TrimSpace(opts.BaseURL) == "" {
		return Result{}, errors.New("bootstrap: prowlarr base url is not configured")
	}

	ctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	result, err := resolveAPIKey(ctx, opts)
	if err != nil {
		return Result{}, err
	}
	opts.Log.Info("[bootstrap] prowlarr api key resolved",
		"source", result.KeySource)

	if err := waitReady(ctx, opts, result.APIKey); err != nil {
		return result, err
	}

	if len(opts.Starters) > 0 {
		// Serialize starter installation within this process so concurrent
		// bootstrap calls cannot double-add to a momentarily-empty instance
		// (architecture.md §8: concurrency-safe, idempotent).
		installMu.Lock()
		added, preserved, failed, err := installStarters(ctx, opts, result.APIKey)
		installMu.Unlock()
		if err != nil {
			// Starter-list errors (schema/profile unavailable) are degraded
			// state, not fatal: a configured Prowlarr stays usable.
			opts.Log.Warn("[bootstrap] starter indexer installation degraded", "err", err)
			result.IndexersFailed = append(result.IndexersFailed, "bootstrap-listing")
			return result, nil
		}
		result.IndexersAdded = added
		result.IndexersPreserved = preserved
		result.IndexersFailed = failed
	}
	return result, nil
}

// resolveAPIKey prefers the explicit secret; otherwise it waits (bounded) for
// the generated config file and parses the ApiKey element structurally. The
// key is never logged.
func resolveAPIKey(ctx context.Context, opts Options) (Result, error) {
	if key := strings.TrimSpace(opts.ExplicitKey); key != "" {
		return Result{APIKey: key, KeySource: "explicit"}, nil
	}
	if strings.TrimSpace(opts.ConfigFile) == "" {
		return Result{}, errors.New(
			"bootstrap: no prowlarr api key source (set PROWLARR_API_KEY or PROWLARR_CONFIG_FILE)")
	}
	deadline := time.Now().Add(opts.Timeout)
	for {
		key, err := readConfigAPIKey(opts.ConfigFile)
		if err == nil && key != "" {
			return Result{APIKey: key, KeySource: "config-file"}, nil
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			return Result{}, fmt.Errorf(
				"bootstrap: prowlarr configuration file did not become readable in time: %w", os.ErrDeadlineExceeded)
		}
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-time.After(opts.PollInterval):
		}
	}
}

// prowlarrConfig mirrors the single element we need from config.xml. Parsing
// is structural (encoding/xml), never a regex over arbitrary file content.
type prowlarrConfig struct {
	ApiKey string `xml:"ApiKey"`
}

func readConfigAPIKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var cfg prowlarrConfig
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("bootstrap: %s is not valid prowlarr XML: %w", path, err)
	}
	key := strings.TrimSpace(cfg.ApiKey)
	if key == "" {
		return "", errors.New("bootstrap: config file has no ApiKey element yet")
	}
	return key, nil
}

// waitReady polls Prowlarr's authenticated system status endpoint until the
// API accepts the key (Prowlarr can listen before its API is initialized).
func waitReady(ctx context.Context, opts Options, apiKey string) error {
	deadline := time.Now().Add(opts.Timeout)
	url := strings.TrimRight(opts.BaseURL, "/") + "/api/v1/system/status"
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return fmt.Errorf("bootstrap: prowlarr readiness request: %w", err)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("X-Api-Key", apiKey)
		resp, err := opts.HTTPClient.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if ctx.Err() != nil {
			return fmt.Errorf("bootstrap: prowlarr not ready before deadline: %w", ctx.Err())
		}
		if time.Now().After(deadline) {
			return errors.New("bootstrap: prowlarr did not become ready in time")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("bootstrap: prowlarr not ready before deadline: %w", ctx.Err())
		case <-time.After(opts.PollInterval):
		}
	}
}

// installStarters adds the starter set to an empty instance and completes a
// partially installed starter set on later runs. A populated instance with no
// recognized starter names is treated as operator-owned and preserved. Every
// existing indexer is left unchanged; retries only POST missing starter names.
func installStarters(ctx context.Context, opts Options, apiKey string) (added []string, preserved int, failed []string, err error) {
	existing, err := prowlarrGet(ctx, opts, apiKey, "indexer")
	if err != nil {
		return nil, 0, nil, fmt.Errorf("bootstrap: list indexers: %w", err)
	}
	list, ok := existing.([]any)
	if existing == nil {
		list = []any{}
	} else if !ok {
		return nil, 0, nil, errors.New("bootstrap: indexer list returned an unexpected shape")
	}
	existingNames := make(map[string]struct{}, len(list))
	for _, entry := range list {
		indexer, _ := entry.(map[string]any)
		name, _ := indexer["name"].(string)
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			existingNames[name] = struct{}{}
		}
	}
	hasStarter := false
	missingStarters := 0
	for _, starter := range opts.Starters {
		if _, exists := existingNames[strings.ToLower(strings.TrimSpace(starter.Name))]; exists {
			hasStarter = true
		} else {
			missingStarters++
		}
	}
	if len(list) > 0 && !hasStarter {
		return nil, len(list), nil, nil
	}
	if missingStarters == 0 {
		return nil, len(list), nil, nil
	}

	schemas, err := prowlarrGetList(ctx, opts, apiKey, "indexer/schema")
	if err != nil {
		return nil, 0, nil, fmt.Errorf("bootstrap: fetch indexer schema: %w", err)
	}

	profilesRaw, err := prowlarrGet(ctx, opts, apiKey, "appProfile")
	if err != nil {
		return nil, 0, nil, fmt.Errorf("bootstrap: fetch app profiles: %w", err)
	}
	appProfileID, err := firstAppProfileID(profilesRaw)
	if err != nil {
		return nil, 0, nil, err
	}

	added = []string{}
	failed = []string{}
	for _, starter := range opts.Starters {
		if _, exists := existingNames[strings.ToLower(strings.TrimSpace(starter.Name))]; exists {
			continue
		}
		schema, ok := findSchema(schemas, starter)
		if !ok {
			opts.Log.Warn("[bootstrap] starter source not available in this prowlarr build",
				"name", starter.Name)
			failed = append(failed, starter.Name)
			continue
		}

		// Round-trip the ENTIRE schema object (V1 parity: the Electron
		// launcher posts a clone of the schema minus id). Prowlarr rejects
		// partial payloads with HTTP 400.
		payload, err := cloneJSONMap(schema)
		if err != nil {
			failed = append(failed, starter.Name)
			continue
		}
		delete(payload, "id")
		payload["name"] = starter.Name
		payload["enable"] = starterEnabled(starter)
		payload["priority"] = starter.Priority
		payload["appProfileId"] = appProfileID
		payload["tags"] = []any{}
		payload["fields"] = setSchemaFields(schema["fields"], map[string]any{
			"baseSettings.grabLimit":                15,
			"torrentBaseSettings.appMinimumSeeders": starter.MinimumSeeders,
			"torrentBaseSettings.preferMagnetUrl":   preferMagnet(starter),
		})
		// Starter-specific fields override the defaults.
		payload["fields"] = setSchemaFields(payload["fields"], starter.Fields)

		body, err := json.Marshal(payload)
		if err != nil {
			failed = append(failed, starter.Name)
			continue
		}
		if err := prowlarrPost(ctx, opts, apiKey, "indexer?forceSave=true", body); err != nil {
			opts.Log.Warn("[bootstrap] could not add starter source",
				"name", starter.Name, "err", err)
			failed = append(failed, starter.Name)
			continue
		}
		added = append(added, starter.Name)
	}
	return added, len(list), failed, nil
}

func preferMagnet(s Starter) bool {
	if s.PreferMagnet != nil {
		return *s.PreferMagnet
	}
	return true
}

func starterEnabled(s Starter) bool {
	if s.Enabled != nil {
		return *s.Enabled
	}
	return true
}

// findSchema locates the schema entry for a starter: by implementation when
// set, otherwise by the definitionFile field value.
func findSchema(schemas []map[string]any, starter Starter) (map[string]any, bool) {
	for _, schema := range schemas {
		if starter.Implementation != "" {
			if v, _ := schema["implementation"].(string); v == starter.Implementation {
				return schema, true
			}
			continue
		}
		fields, _ := schema["fields"].([]any)
		for _, f := range fields {
			field, _ := f.(map[string]any)
			if field == nil || field["name"] != "definitionFile" {
				continue
			}
			if v, _ := field["value"].(string); v == starter.Definition {
				return schema, true
			}
		}
	}
	return nil, false
}

// setSchemaFields sets values on a decoded JSON fields array, preserving
// field order and every untouched field.
func setSchemaFields(rawFields any, values map[string]any) []any {
	fields, _ := rawFields.([]any)
	out := make([]any, len(fields))
	copy(out, fields)
	for _, f := range out {
		field, _ := f.(map[string]any)
		if field == nil {
			continue
		}
		name, _ := field["name"].(string)
		if v, ok := values[name]; ok {
			field["value"] = v
		}
	}
	return out
}

func cloneJSONMap(src map[string]any) (map[string]any, error) {
	data, err := json.Marshal(src)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func firstAppProfileID(raw any) (int, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return 0, fmt.Errorf("bootstrap: encode app profiles: %w", err)
	}
	var profiles []struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(data, &profiles); err != nil {
		return 0, fmt.Errorf("bootstrap: decode app profiles: %w", err)
	}
	for _, p := range profiles {
		if p.ID > 0 {
			return p.ID, nil
		}
	}
	return 0, errors.New("bootstrap: prowlarr has no usable application profile")
}

func prowlarrGet(ctx context.Context, opts Options, apiKey, route string) (any, error) {
	url := strings.TrimRight(opts.BaseURL, "/") + "/api/v1/" + strings.TrimLeft(route, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	resp, err := opts.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prowlarr %s returned HTTP %d", route, resp.StatusCode)
	}
	var payload any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("prowlarr %s returned invalid JSON: %w", route, err)
	}
	return payload, nil
}

// prowlarrGetList fetches a route expected to return a JSON object array.
func prowlarrGetList(ctx context.Context, opts Options, apiKey, route string) ([]map[string]any, error) {
	raw, err := prowlarrGet(ctx, opts, apiKey, route)
	if err != nil {
		return nil, err
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("prowlarr %s returned an unexpected shape", route)
	}
	out := make([]map[string]any, 0, len(list))
	for _, entry := range list {
		if m, ok := entry.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

func prowlarrPost(ctx context.Context, opts Options, apiKey, route string, body []byte) error {
	url := strings.TrimRight(opts.BaseURL, "/") + "/api/v1/" + strings.TrimLeft(route, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)
	resp, err := opts.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
		var validation []struct {
			PropertyName string `json:"propertyName"`
			ErrorMessage string `json:"errorMessage"`
		}
		if json.Unmarshal(data, &validation) == nil {
			messages := make([]string, 0, len(validation))
			for _, problem := range validation {
				if problem.ErrorMessage == "" {
					continue
				}
				if problem.PropertyName != "" {
					messages = append(messages, problem.PropertyName+": "+problem.ErrorMessage)
				} else {
					messages = append(messages, problem.ErrorMessage)
				}
			}
			if len(messages) > 0 {
				return fmt.Errorf("prowlarr %s returned HTTP %d (%s)", route, resp.StatusCode, strings.Join(messages, "; "))
			}
		}
		return fmt.Errorf("prowlarr %s returned HTTP %d", route, resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}
