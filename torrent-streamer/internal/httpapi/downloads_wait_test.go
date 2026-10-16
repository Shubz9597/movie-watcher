package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"torrent-streamer/internal/downloads"
)

// The phone's downloader asks for a manifest with the app closed and waits
// on the server while it prepares: 202 while preparing, 410 once the job
// failed, the manifest once ready.
func TestManifestWaitsWhilePreparing(t *testing.T) {
	ask := func(svc *fakeDownloadService) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1/manifest?wait=1&clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil)
		req.Header.Set("Accept", "application/json")
		newDownloadsTestMux(svc).ServeHTTP(rec, req)
		return rec
	}
	preparing := readyTestJob()
	preparing.State = downloads.StatePreparing
	if rec := ask(&fakeDownloadService{getJob: preparing, manifestErr: downloads.ErrNotFound}); rec.Code != http.StatusAccepted {
		t.Fatalf("preparing: %d %s", rec.Code, rec.Body)
	}
	failed := readyTestJob()
	failed.State, failed.ReasonCode = downloads.StateFailed, "source_unavailable"
	if rec := ask(&fakeDownloadService{getJob: failed, manifestErr: downloads.ErrNotFound}); rec.Code != http.StatusGone {
		t.Fatalf("failed: %d %s", rec.Code, rec.Body)
	}
	if rec := ask(&fakeDownloadService{getJob: readyTestJob(), manifest: downloads.Manifest{ManifestVersion: 1, JobID: "job-1"}}); rec.Code != http.StatusOK {
		t.Fatalf("ready: %d %s", rec.Code, rec.Body)
	}
}
