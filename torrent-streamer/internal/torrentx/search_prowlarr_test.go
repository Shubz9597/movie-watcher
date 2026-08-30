package torrentx

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTorznabQueryBuildsMagnetFromInfoHashInsteadOfHTTPDownload(t *testing.T) {
	const hash = "0123456789ABCDEF0123456789ABCDEF01234567"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(w, `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Show S01E02 1080p</title><link>%s/download/123</link><size>1000</size><torznab:attr name="infohash" value="%s"/><torznab:attr name="seeders" value="12"/></item></channel></rss>`, serverURL(r), hash)
	}))
	defer server.Close()

	client := TorznabClient{BaseURL: server.URL, APIKey: "test", HTTP: server.Client()}
	results, err := client.Query(context.Background(), "Show", 1, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	want := "magnet:?xt=urn:btih:" + hash
	if results[0].Magnet != want {
		t.Fatalf("magnet = %q, want %q", results[0].Magnet, want)
	}
}

func TestTorznabQueryHonorsCancelledContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := TorznabClient{BaseURL: server.URL, APIKey: "test", HTTP: server.Client()}
	_, err := client.Query(ctx, "Show", 1, 2, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestValidInfoHashRejectsNonHexFortyCharacterValue(t *testing.T) {
	if validInfoHash("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ") {
		t.Fatal("invalid 40-character hash was accepted")
	}
	if !validInfoHash("0123456789abcdef0123456789abcdef01234567") {
		t.Fatal("valid hexadecimal hash was rejected")
	}
}

func serverURL(r *http.Request) string {
	return "http://" + r.Host
}
