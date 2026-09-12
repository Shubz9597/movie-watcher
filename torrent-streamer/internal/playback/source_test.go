package playback

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type fakeSeeker struct{ r *strings.Reader }

func (f *fakeSeeker) Read(p []byte) (int, error)                { return f.r.Read(p) }
func (f *fakeSeeker) Seek(off int64, whence int) (int64, error) { return f.r.Seek(off, whence) }
func (f *fakeSeeker) Close() error                              { return nil }

func openFake(size int64) func() (io.ReadSeekCloser, error) {
	return func() (io.ReadSeekCloser, error) {
		return &fakeSeeker{strings.NewReader(strings.Repeat("x", int(size)))}, nil
	}
}

// 7. Session/source identifiers are cryptographically random and opaque.
func TestRandomTokensAreOpaqueAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		token, err := randomToken()
		if err != nil {
			t.Fatalf("randomToken: %v", err)
		}
		if len(token) != 64 { // 256-bit hex
			t.Fatalf("token length = %d", len(token))
		}
		if seen[token] {
			t.Fatalf("token collision after %d", i)
		}
		seen[token] = true
	}
}

// 8. No magnet anywhere in source URLs.
func TestMediaSourceURLsContainNoMagnet(t *testing.T) {
	ms, err := NewMediaSource()
	if err != nil {
		t.Skipf("loopback listener unavailable: %v", err)
	}
	defer ms.Close()
	magnet := "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some%20Movie"
	token, url, err := ms.Issue(openFake(1024), "movie.mp4", 1024, time.Minute)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if strings.Contains(url, "magnet") || strings.Contains(url, "btih") || strings.Contains(url, "0123456789") {
		t.Fatalf("source URL leaks source material: %s", url)
	}
	if !strings.HasPrefix(url, "http://127.0.0.1:") || !strings.Contains(url, token) {
		t.Fatalf("source URL shape wrong: %s", url)
	}
	_ = magnet // deliberately never given to the source
}

// The source answers authorized range requests and refuses unknown tokens.
func TestMediaSourceServesRangesAndRejectsUnknownTokens(t *testing.T) {
	ms, err := NewMediaSource()
	if err != nil {
		t.Skipf("loopback listener unavailable: %v", err)
	}
	defer ms.Close()
	_, url, err := ms.Issue(openFake(4096), "movie.mp4", 4096, time.Minute)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	// Range request honored.
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Range", "bytes=100-199")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || len(body) != 100 {
		t.Fatalf("range: status=%d len=%d", resp.StatusCode, len(body))
	}

	// Unknown token → 404, generic body.
	badURL := strings.Replace(url, url[strings.LastIndex(url, "/")+1:],
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 1)
	resp2, err := http.Get(badURL)
	if err != nil {
		t.Fatalf("unknown-token do: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown token status = %d", resp2.StatusCode)
	}

	// Revocation works.
	ms.Revoke(url[strings.LastIndex(url, "/")+1:])
	resp3, err := http.Get(url)
	if err != nil {
		t.Fatalf("post-revoke do: %v", err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusNotFound {
		t.Fatalf("post-revoke status = %d", resp3.StatusCode)
	}
}

var _ = context.Background
