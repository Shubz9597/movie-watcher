package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegressionDownloadPreflight(t *testing.T) {
	h := newDownloadsTestHandlers(&fakeDownloadService{})
	h.AllowedOrigins = []string{"http://localhost:5173"}
	m := http.NewServeMux()
	h.Register(m)
	r := httptest.NewRequest("OPTIONS", "/v1/downloads/jobs", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.Header.Set("Access-Control-Request-Method", "POST")
	r.Header.Set("Access-Control-Request-Headers", "content-type")
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("download POST preflight methods=%q, want POST allowed", w.Header().Get("Access-Control-Allow-Methods"))
	}
}
func TestRegressionTastePreflight(t *testing.T) {
	m := http.NewServeMux()
	RegisterTasteRoutes(m, nil)
	r := httptest.NewRequest("OPTIONS", "/v1/taste/visited", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.Header.Set("Access-Control-Request-Method", "POST")
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code >= 400 {
		t.Errorf("taste preflight returned %d, want success", w.Code)
	}
}
