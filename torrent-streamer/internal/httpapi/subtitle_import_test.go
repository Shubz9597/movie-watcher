package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSubtitleImportRoundTripAndLimits(t *testing.T) {
	t.Setenv("SUB_CACHE_DIR", t.TempDir())
	for _, tc := range []struct {
		name, content string
		status        int
	}{
		{"styled.ass", "[Script Info]\nTitle: Style preserved\n", http.StatusOK},
		{"empty.srt", "", http.StatusBadRequest},
		{"too-large.srt", string(bytes.Repeat([]byte("x"), (4<<20)+(65<<10))), http.StatusBadRequest},
		{"wrong.txt", "text", http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			part, err := writer.CreateFormFile("file", tc.name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := part.Write([]byte(tc.content)); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/subtitles/import", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			res := httptest.NewRecorder()
			handleSubtitleImport(res, req)
			if res.Code != tc.status {
				t.Fatalf("upload %s status=%d body=%s, want %d", tc.name, res.Code, res.Body, tc.status)
			}
			if res.Code != http.StatusOK {
				return
			}
			var payload struct {
				URL string `json:"url"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			get := httptest.NewRecorder()
			handleSubtitleExternal(get, httptest.NewRequest(http.MethodGet, payload.URL, nil))
			if get.Code != http.StatusOK || get.Body.String() != tc.content {
				t.Fatalf("download status=%d content=%q, want original ASS", get.Code, get.Body)
			}
		})
	}
}

// Retention bounds: expired files are swept on the next import and the
// oldest imports are evicted when the total cache cap is exceeded.
func TestSubtitleImportRetention(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "imported")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// An expired file and a fresh file.
	expired := filepath.Join(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.srt")
	fresh := filepath.Join(dir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.vtt")
	if err := os.WriteFile(expired, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fresh, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-importRetention - time.Hour)
	if err := os.Chtimes(expired, stale, stale); err != nil {
		t.Fatal(err)
	}
	sweepSubtitleImports(dir)
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatalf("expired import must be removed, err=%v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh import must survive the sweep: %v", err)
	}

	// Cache cap: create several fresh 5 MiB files (ids matching the server
	// pattern), then run the sweep and require the total to fall back under
	// the cap.
	var total int64
	for i := 0; i < 20; i++ {
		id := strings.Repeat("c", 30) + padHex(i)
		name := filepath.Join(dir, id+".srt")
		if err := os.WriteFile(name, bytes.Repeat([]byte("y"), 5<<20), 0o644); err != nil {
			t.Fatal(err)
		}
		total += 5 << 20
	}
	if total <= importCacheMaxBytes {
		t.Fatalf("test setup: total %d must exceed cap %d", total, importCacheMaxBytes)
	}
	sweepSubtitleImports(dir)
	var remaining int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil {
			remaining += info.Size()
		}
	}
	if remaining > importCacheMaxBytes {
		t.Fatalf("cache cap not enforced: %d bytes remain, cap %d", remaining, importCacheMaxBytes)
	}
}

func padHex(i int) string {
	const hexDigits = "0123456789abcdef"
	return string([]byte{hexDigits[i/16%16], hexDigits[i%16]})
}
