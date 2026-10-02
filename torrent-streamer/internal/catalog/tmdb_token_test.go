package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTMDbAccessTokenUsesBearerHeader(t *testing.T) {
	var gotAuth, gotKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotKey = r.Header.Get("Authorization"), r.URL.Query().Get("api_key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer server.Close()

	provider := NewTMDb(TMDbOptions{BaseURL: server.URL, AccessToken: "v4-token", HTTP: server.Client()})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: "dark"}); err != nil {
		t.Fatalf("search: %v", err)
	}
	if gotAuth != "Bearer v4-token" || gotKey != "" {
		t.Fatalf("auth = %q, api_key = %q; want bearer header and no api_key", gotAuth, gotKey)
	}
}

func TestTMDbWithoutCredentialIsUnavailable(t *testing.T) {
	provider := NewTMDb(TMDbOptions{BaseURL: "http://127.0.0.1:1"})
	if _, err := provider.Search(context.Background(), SearchQuery{Query: "dark"}); err != errProviderUnavailable {
		t.Fatalf("err = %v, want errProviderUnavailable", err)
	}
}
