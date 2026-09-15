package catalog

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

var errProviderUnavailable = errors.New("catalog: provider unavailable")

// Transient egress failures (ISP peering drops, provider 5xx bursts, the
// documented "sometimes TMDb results do not load" flake) get ONE bounded
// retry: cheap for the 99% clean path, and it removes the majority of the
// user-visible "content error" flashes without any VPN machinery. 429 keeps
// its dedicated rate-limit error; 404 is authoritative and never retried.
func isTransientProviderError(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

// fetchJSON performs one provider HTTP call, mapping status codes to catalog
// errors: 404 → ErrNotFound, 429 → ErrRateLimited, other 4xx/5xx → transport
// error. Responses are capped at 8 MiB.
func fetchJSON(ctx context.Context, client *http.Client, endpoint string, target any) error {
	return doProviderRequest(ctx, client, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	}, target)
}

// postJSON performs one provider POST call (GraphQL bodies).
func postJSON(ctx context.Context, client *http.Client, endpoint string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode provider request: %w", err)
	}
	return doProviderRequest(ctx, client, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	}, target)
}

func doProviderRequest(ctx context.Context, client *http.Client, newRequest func() (*http.Request, error), target any) error {
	err := doProviderRequestOnce(ctx, client, newRequest, target)
	if err == nil || ctx.Err() != nil {
		return err
	}
	// One bounded retry for transient failures. ErrNotFound/ErrRateLimited
	// are authoritative answers and are returned as-is.
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrRateLimited) {
		return err
	}
	select {
	case <-ctx.Done():
		return err
	case <-time.After(400 * time.Millisecond):
	}
	retryErr := doProviderRequestOnce(ctx, client, newRequest, target)
	if retryErr != nil && !errors.Is(retryErr, ErrNotFound) && !errors.Is(retryErr, ErrRateLimited) {
		return fmt.Errorf("%w (after one retry: %v)", err, retryErr)
	}
	return retryErr
}

func doProviderRequestOnce(ctx context.Context, client *http.Client, newRequest func() (*http.Request, error), target any) error {
	req, err := newRequest()
	if err != nil {
		return fmt.Errorf("create provider request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("provider request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return ErrRateLimited
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("provider status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode provider response: %w", err)
	}
	return nil
}
