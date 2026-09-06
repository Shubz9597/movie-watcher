package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Client is the reference-client harness. ClientID is an untrusted opaque
// identifier (FR-013): generated locally, persisted for stability, validated
// server-side for format only — never registration or authentication.
type Client struct {
	BaseURL    string
	HTTP       *http.Client
	ClientID   string
	AppVersion string
}

// NewClient builds the harness and loads/creates the persisted client id.
func NewClient(baseURL, configDir string) (*Client, error) {
	id, err := LoadOrCreateClientID(configDir)
	if err != nil {
		return nil, err
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTP:       &http.Client{Timeout: 30 * time.Second},
		ClientID:   id,
		AppVersion: "reference-client-dev",
	}, nil
}

// LoadOrCreateClientID reads the persisted client-generated UUID, creating a
// cryptographically random one on first run (FR-013; reinstallation simply
// generates a new one without server registration).
func LoadOrCreateClientID(configDir string) (string, error) {
	dir := configDir
	if dir == "" {
		userConfig, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("resolve user config dir: %w", err)
		}
		dir = filepath.Join(userConfig, "torwatch-reference-client")
	}
	path := filepath.Join(dir, "client-id")
	if data, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(data)); isUUID(id) {
			return id, nil
		}
	}
	id, err := newUUID()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(id), 0o600); err != nil {
		return "", err
	}
	return id, nil
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	value := hex.EncodeToString(b[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, r := range value {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			isHex := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// --- /v2/catalog/* (T046) ---

type CatalogTitle struct {
	ID          string            `json:"id"`
	Type        string            `json:"type"`
	Title       string            `json:"title"`
	Year        int               `json:"year,omitempty"`
	Overview    string            `json:"overview,omitempty"`
	ProviderIDs map[string]string `json:"providerIds,omitempty"`
	IMDBID      string            `json:"imdbId,omitempty"`
	MergedFrom  []string          `json:"mergedFrom,omitempty"`
}

type CatalogEpisode struct {
	ID        string `json:"id"`
	Season    int    `json:"season"`
	Episode   int    `json:"episode"`
	Title     string `json:"title,omitempty"`
	AirDate   string `json:"airDate,omitempty"`
	Still     string `json:"still,omitempty"`
	DurationS int    `json:"duration_s,omitempty"`
}

// Search queries the unified BFF search. Requires the catalog capability.
func (c *Client) Search(ctx context.Context, query string) ([]CatalogTitle, error) {
	if err := c.requireCapability("catalog.bff.v2"); err != nil {
		return nil, err
	}
	if err := c.EnsureCompatible(ctx); err != nil {
		return nil, err
	}
	var payload struct {
		Results []CatalogTitle `json:"results"`
	}
	if err := c.getJSON(ctx, "/v2/catalog/search?q="+url.QueryEscape(query)+"&type=all&clientId="+c.ClientID, &payload); err != nil {
		return nil, err
	}
	return payload.Results, nil
}

// TitleDetail fetches one opaque catalog title.
func (c *Client) TitleDetail(ctx context.Context, titleID string) (CatalogTitle, error) {
	if err := c.EnsureCompatible(ctx); err != nil {
		return CatalogTitle{}, err
	}
	var title CatalogTitle
	if err := c.getJSON(ctx, "/v2/catalog/titles/"+titleID+"?clientId="+c.ClientID, &title); err != nil {
		return CatalogTitle{}, err
	}
	return title, nil
}

// Episodes fetches the episode list for a title/season.
func (c *Client) Episodes(ctx context.Context, titleID string, season int) ([]CatalogEpisode, error) {
	if err := c.EnsureCompatible(ctx); err != nil {
		return nil, err
	}
	var payload struct {
		Episodes []CatalogEpisode `json:"episodes"`
	}
	if err := c.getJSON(ctx, "/v2/catalog/titles/"+titleID+"/episodes?season="+strconv.Itoa(season)+"&clientId="+c.ClientID, &payload); err != nil {
		return nil, err
	}
	return payload.Episodes, nil
}

func (c *Client) requireCapability(capability string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, err := c.FetchVersion(ctx)
	if err != nil {
		return nil
	}
	if !version.HasCapability(capability) {
		return fmt.Errorf("server does not advertise capability %q (capabilities: %v) — upgrade the backend to use this workflow", capability, version.Capabilities)
	}
	return nil
}

// --- shared HTTP helpers ---

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	return c.HTTP.Do(req)
}

func decodeJSON(resp *http.Response, target any) error {
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

var errNoSource = errors.New("no results")
