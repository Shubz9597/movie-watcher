// Package stremiosync brings what a profile watches in Stremio (a TV,
// another phone) into its Continue Watching.
//
// Stremio keeps each account's library on its API (api.strem.io): every
// title watched, with the episode and position (stremio-core,
// types/library/library_item.rs). A profile links its account once (the
// server keeps the session key, never the password); the server then reads
// the library every few minutes and applies newer positions with the same
// rules as offline progress (newer wins, a finished episode stays
// finished). The API is Stremio's own and undocumented: a change on their
// side stops only this sync.
package stremiosync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultAPI is Stremio's account API.
const DefaultAPI = "https://api.strem.io/api/"

// DefaultLinkAPI is Stremio's device-link service (what its TV apps sign in
// with): a short code the viewer approves on stremio.com, no password
// through TorWatch (stremio-core models/link.rs).
const DefaultLinkAPI = "https://link.stremio.com/api/v2/"

var (
	// ErrBadLogin: Stremio refused the email or password.
	ErrBadLogin = errors.New("wrong Stremio email or password")
	// ErrSession: the session key no longer works (signed out, password
	// changed); the account must be linked again.
	ErrSession = errors.New("stremio session ended")
)

type Client struct {
	Base     string // default DefaultAPI
	LinkBase string // default DefaultLinkAPI
	HTTP     *http.Client
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP == nil {
		return &http.Client{Timeout: 30 * time.Second}
	}
	return c.HTTP
}

type apiError struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	WrongPass bool   `json:"wrongPass"`
}

func (c *Client) call(ctx context.Context, method string, body any, out any) error {
	base := c.Base
	if base == "" {
		base = DefaultAPI
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/"+method, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("stremio %s: %w", method, err)
	}
	defer resp.Body.Close()
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *apiError       `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("stremio %s: HTTP %d: %w", method, resp.StatusCode, err)
	}
	if envelope.Error != nil {
		switch {
		case envelope.Error.WrongPass || method == "login" && envelope.Error.Code == 3:
			return ErrBadLogin
		case envelope.Error.Code == 1: // "Session does not exist"
			return ErrSession
		}
		return fmt.Errorf("stremio %s: %s (code %d)", method, envelope.Error.Message, envelope.Error.Code)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}

// Login signs in and returns the session key.
func (c *Client) Login(ctx context.Context, email, password string) (string, error) {
	var out struct {
		AuthKey string `json:"authKey"`
	}
	err := c.call(ctx, "login", map[string]any{"type": "Login", "email": email, "password": password, "facebook": false}, &out)
	if err != nil {
		return "", err
	}
	if out.AuthKey == "" {
		return "", errors.New("stremio login: no session key in the answer")
	}
	return out.AuthKey, nil
}

// Logout ends the session (unlinking; failures are ignored by callers).
func (c *Client) Logout(ctx context.Context, authKey string) error {
	return c.call(ctx, "logout", map[string]any{"type": "Logout", "authKey": authKey}, nil)
}

// LibraryItem is one title in a Stremio library (stremio-core LibraryItem;
// times in milliseconds).
type LibraryItem struct {
	ID      string `json:"_id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Removed bool   `json:"removed"`
	Temp    bool   `json:"temp"`
	State   struct {
		LastWatched *time.Time `json:"lastWatched"`
		TimeOffset  float64    `json:"timeOffset"`
		Duration    float64    `json:"duration"`
		VideoID     string     `json:"video_id"`
	} `json:"state"`
}

// Library reads the account's whole library. Items that do not decode
// (old or odd records) are skipped, not fatal.
func (c *Client) Library(ctx context.Context, authKey string) ([]LibraryItem, error) {
	var raw []json.RawMessage
	err := c.call(ctx, "datastoreGet", map[string]any{
		"authKey": authKey, "collection": "libraryItem", "ids": []string{}, "all": true,
	}, &raw)
	if err != nil {
		return nil, err
	}
	items := make([]LibraryItem, 0, len(raw))
	for _, one := range raw {
		var item LibraryItem
		if json.Unmarshal(one, &item) == nil && item.ID != "" {
			items = append(items, item)
		}
	}
	return items, nil
}

// LinkCode is a device-link code and the page that approves it.
type LinkCode struct {
	Code string `json:"code"`
	Link string `json:"link"`
}

// linkGet calls the link service: {"result": ...} or {"error": ...}.
func (c *Client) linkGet(ctx context.Context, path string, out any) (*apiError, error) {
	base := c.LinkBase
	if base == "" {
		base = DefaultLinkAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/"+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("stremio link: %w", err)
	}
	defer resp.Body.Close()
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *apiError       `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("stremio link: HTTP %d: %w", resp.StatusCode, err)
	}
	if envelope.Error != nil {
		return envelope.Error, nil
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return &apiError{Message: "empty answer"}, nil
	}
	return nil, json.Unmarshal(envelope.Result, out)
}

// CreateLink asks for a new code.
func (c *Client) CreateLink(ctx context.Context) (LinkCode, error) {
	var code LinkCode
	apiErr, err := c.linkGet(ctx, "create?type=Create", &code)
	if err != nil {
		return LinkCode{}, err
	}
	if apiErr != nil || code.Code == "" || code.Link == "" {
		return LinkCode{}, fmt.Errorf("stremio link: no code (%v)", apiErr)
	}
	return code, nil
}

// ReadLink returns the session key once the code was approved ("" while it
// waits: the service answers an error until then).
func (c *Client) ReadLink(ctx context.Context, code string) (string, error) {
	var out struct {
		AuthKey string `json:"authKey"`
	}
	apiErr, err := c.linkGet(ctx, "read?type=Read&code="+url.QueryEscape(code), &out)
	if err != nil || apiErr != nil {
		return "", err
	}
	return out.AuthKey, nil
}

// Email is the account's email (to show which account is linked).
func (c *Client) Email(ctx context.Context, authKey string) (string, error) {
	var out struct {
		Email string `json:"email"`
	}
	if err := c.call(ctx, "getUser", map[string]any{"type": "GetUser", "authKey": authKey}, &out); err != nil {
		return "", err
	}
	return out.Email, nil
}
