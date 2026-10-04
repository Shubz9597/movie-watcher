package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var errProviderUnavailable = errors.New("catalog: provider unavailable")

type rateLimitError struct{ retryAfter time.Duration }

func (e *rateLimitError) Error() string { return ErrRateLimited.Error() }
func (e *rateLimitError) Unwrap() error { return ErrRateLimited }

type providerStatusError struct {
	code    int
	message string
}

func (e *providerStatusError) Error() string { return e.message }

func retryAfter(value string) time.Duration {
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		return max(time.Until(at), 0)
	}
	return 0
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
	var status *providerStatusError
	if errors.As(err, &status) && status.code < 500 {
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
		return &rateLimitError{retryAfter: retryAfter(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return &providerStatusError{code: resp.StatusCode, message: fmt.Sprintf("provider status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))}
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode provider response: %w", err)
	}
	return nil
}
