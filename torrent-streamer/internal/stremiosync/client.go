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
	"strings"
	"time"
)

// DefaultAPI is Stremio's account API.
const DefaultAPI = "https://api.strem.io/api/"

var (
	// ErrBadLogin: Stremio refused the email or password.
	ErrBadLogin = errors.New("wrong Stremio email or password")
	// ErrSession: the session key no longer works (signed out, password
	// changed); the account must be linked again.
	ErrSession = errors.New("stremio session ended")
)

type Client struct {
	Base string // default DefaultAPI
	HTTP *http.Client
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
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
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
