package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"torrent-streamer/internal/buildinfo"
	"torrent-streamer/internal/downloads"
	"torrent-streamer/internal/search"
	"torrent-streamer/internal/torrentx"
)

type fakeDownloadSourceResolver struct {
	result search.ResolveResult
	err    error
	last   search.ResolveRequest
}

func (f *fakeDownloadSourceResolver) Resolve(_ context.Context, request search.ResolveRequest) (search.ResolveResult, error) {
	f.last = request
	return f.result, f.err
}

type fakeDownloadPickStore struct {
	id   int64
	err  error
	last torrentx.PickRow
}

func (f *fakeDownloadPickStore) InsertPick(_ context.Context, pick torrentx.PickRow) (int64, error) {
	f.last = pick
	return f.id, f.err
}

// fakeDownloadService scripts the Service so the HTTP contract (status codes,
// envelope shapes, client scoping, safe errors) is pinned independently of
// PostgreSQL — same pattern as the other contract suites.
type fakeDownloadService struct {
	createJob    downloads.Job
	createNew    bool
	createErr    error
	getJob       downloads.Job
	getErr       error
	cancelErr    error
	renewErr     error
	manifest     downloads.Manifest
	manifestErr  error
	assetDisk    string
	assetSize    int64
	assetSHA     string
	assetErr     error
	lastCreate   downloads.CreateRequest
	lastGetScope [2]string
}

func (f *fakeDownloadService) Create(ctx context.Context, req downloads.CreateRequest) (downloads.Job, bool, error) {
	f.lastCreate = req
	if f.createErr != nil {
		return downloads.Job{}, false, f.createErr
	}
	return f.createJob, f.createNew, nil
}
func (f *fakeDownloadService) Get(ctx context.Context, clientID, jobID string) (downloads.Job, error) {
	f.lastGetScope = [2]string{clientID, jobID}
	if f.getErr != nil {
		return downloads.Job{}, f.getErr
	}
	return f.getJob, nil
}
func (f *fakeDownloadService) Cancel(ctx context.Context, clientID, jobID string) (downloads.Job, error) {
	if f.cancelErr != nil {
		return downloads.Job{}, f.cancelErr
	}
	return f.getJob, nil
}
func (f *fakeDownloadService) Renew(ctx context.Context, clientID, jobID string, now time.Time) (downloads.Job, error) {
	if f.renewErr != nil {
		return downloads.Job{}, f.renewErr
	}
	return f.getJob, nil
}
func (f *fakeDownloadService) Manifest(ctx context.Context, clientID, jobID string) (downloads.Manifest, error) {
	if f.manifestErr != nil {
		return downloads.Manifest{}, f.manifestErr
	}
	return f.manifest, nil
}
func (f *fakeDownloadService) MarkReady(ctx context.Context, jobID string, manifest downloads.Manifest, assets []downloads.AssetRow, now time.Time) error {
	return nil
}
func (f *fakeDownloadService) ExpireDue(ctx context.Context, now time.Time, limit int) ([]string, error) {
	return nil, nil
}
func (f *fakeDownloadService) AssetFile(ctx context.Context, clientID, jobID, urlPath string) (string, int64, string, error) {
	if f.assetErr != nil {
		return "", 0, "", f.assetErr
	}
	return f.assetDisk, f.assetSize, f.assetSHA, nil
}

func newDownloadsTestHandlers(svc downloads.Service) DownloadsHandlers {
	return DownloadsHandlers{
		Store: svc,
		Build: buildinfo.New(buildinfo.Options{ServerVersion: "2.0.0-test", Capabilities: []string{"catalog.bff.v2"}}),
		Now:   func() time.Time { return time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC) },
	}
}

func newDownloadsTestMux(svc downloads.Service) *http.ServeMux {
	mux := http.NewServeMux()
	newDownloadsTestHandlers(svc).Register(mux)
	return mux
}

func readyTestJob() downloads.Job {
	readyAt := time.Date(2026, 9, 29, 11, 0, 0, 0, time.UTC)
	expiresAt := readyAt.Add(48 * time.Hour)
	return downloads.Job{
		ID: "job-1", ClientID: "1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", SeriesID: "tmdb:movie:693134",
		State: downloads.StateReady, ReadyAt: &readyAt, ExpiresAt: &expiresAt,
	}
}

func TestDownloadsCreateContract(t *testing.T) {
	svc := &fakeDownloadService{createJob: readyTestJob(), createNew: true}
	mux := newDownloadsTestMux(svc)

	// A new attempt is 201 with the safe body.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs",
		strings.NewReader(`{"clientId":"1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f","idempotencyKey":"key-1","seriesId":"tmdb:movie:693134","pickId":42}`))
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`"jobId":"job-1"`, `"state":"ready"`, `"reasonCode":""`} {
		if !strings.Contains(body, want) {
			t.Fatalf("create body missing %s: %s", want, body)
		}
	}
	if svc.lastCreate.ClientID != "1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f" || svc.lastCreate.PickID != 42 {
		t.Fatalf("create request not forwarded: %+v", svc.lastCreate)
	}

	// Idempotent replay of the same attempt key is 200, same job.
	svc.createNew = false
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs",
		strings.NewReader(`{"clientId":"1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f","idempotencyKey":"key-1","seriesId":"tmdb:movie:693134","pickId":42}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("idempotent replay = %d %s", rec.Code, rec.Body.String())
	}

	// Bad JSON and invalid source map to safe errors.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs", strings.NewReader("not json")))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"bad_json"`) {
		t.Fatalf("bad json = %d %s", rec.Code, rec.Body.String())
	}
	svc.createErr = downloads.ErrInvalidSource
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs",
		strings.NewReader(`{"clientId":"c","idempotencyKey":"k","seriesId":"x","pickId":1}`)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"invalid_source"`) {
		t.Fatalf("invalid source = %d %s", rec.Code, rec.Body.String())
	}
}

func TestDownloadsCreateRegistersOpaqueSelectedSource(t *testing.T) {
	svc := &fakeDownloadService{createJob: readyTestJob(), createNew: true}
	resolver := &fakeDownloadSourceResolver{result: search.ResolveResult{
		MagnetURI: "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
		InfoHash:  "0123456789ABCDEF0123456789ABCDEF01234567",
	}}
	picks := &fakeDownloadPickStore{id: 77}
	handlers := newDownloadsTestHandlers(svc)
	handlers.SourceResolver = resolver
	handlers.Picks = picks
	mux := http.NewServeMux()
	handlers.Register(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs", strings.NewReader(
		`{"clientId":"device-1","idempotencyKey":"attempt-1","seriesId":"tmdb:tv:1396","season":1,"episode":4,"sourceId":"opaque-source","sourceKind":"tv","fileIndex":6}`,
	)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create from selected source = %d %s", rec.Code, rec.Body.String())
	}
	if resolver.last.SourceID != "opaque-source" {
		t.Fatalf("resolved source = %#v", resolver.last)
	}
	if svc.lastCreate.PickID != 77 {
		t.Fatalf("job pick id = %d, want registered pick 77", svc.lastCreate.PickID)
	}
	if picks.last.SeriesID != "tmdb:tv:1396" || picks.last.Season != 1 || picks.last.Episode != 4 ||
		picks.last.SourceKind != "tv" || picks.last.FileIndex == nil || *picks.last.FileIndex != 6 ||
		string(picks.last.ScoreJSON) != "{}" {
		t.Fatalf("registered pick = %#v", picks.last)
	}
}

func TestDownloadsCreatePassesSubtitleRequest(t *testing.T) {
	svc := &fakeDownloadService{createJob: readyTestJob(), createNew: true}
	mux := http.NewServeMux()
	newDownloadsTestHandlers(svc).Register(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs", strings.NewReader(
		`{"clientId":"device-1","idempotencyKey":"attempt-2","seriesId":"tmdb:movie:693134","pickId":5,`+
			`"subtitles":["en"],"subtitleHints":{"title":"Dune: Part Two","year":2024,"imdbId":"tt15239678"}}`,
	)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create with subtitles = %d %s", rec.Code, rec.Body.String())
	}
	got := svc.lastCreate
	if len(got.Subtitles) != 1 || got.Subtitles[0] != "en" {
		t.Fatalf("requested subtitles = %#v", got.Subtitles)
	}
	if got.SubtitleHints.Title != "Dune: Part Two" || got.SubtitleHints.Year != 2024 || got.SubtitleHints.IMDBID != "tt15239678" {
		t.Fatalf("subtitle hints = %#v", got.SubtitleHints)
	}
}

func TestDownloadsGetScopesByClient(t *testing.T) {
	svc := &fakeDownloadService{getJob: readyTestJob()}
	mux := newDownloadsTestMux(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"jobId":"job-1"`) {
		t.Fatalf("get = %d %s", rec.Code, rec.Body.String())
	}
	if svc.lastGetScope != [2]string{"1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", "job-1"} {
		t.Fatalf("get must scope by client and job id, got %v", svc.lastGetScope)
	}

	// A foreign or missing clientId must not leak the job.
	svc.getErr = downloads.ErrNotFound
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1?clientId=2f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"not_found"`) {
		t.Fatalf("foreign client get = %d %s", rec.Code, rec.Body.String())
	}
}

func TestDownloadsCancelAndRenewContract(t *testing.T) {
	svc := &fakeDownloadService{getJob: downloads.Job{ID: "job-1", State: downloads.StateCancelled, ReasonCode: downloads.ReasonClientCancelled}}
	mux := newDownloadsTestMux(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs/job-1/cancel?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("cancel = %d %s", rec.Code, rec.Body.String())
	}

	// A ready job is NOT server-cancellable: device removal is device-side.
	svc.cancelErr = downloads.ErrNotCancellable
	svc.getJob = readyTestJob()
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs/job-1/cancel?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"not_cancellable"`) {
		t.Fatalf("cancel ready = %d %s", rec.Code, rec.Body.String())
	}

	// Renewal success extends; an expired job reports retention_expired.
	svc.cancelErr = nil
	svc.renewErr = nil
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs/job-1/renew?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"expiresAt"`) {
		t.Fatalf("renew = %d %s", rec.Code, rec.Body.String())
	}
	svc.renewErr = downloads.ErrExpired
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/downloads/jobs/job-1/renew?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"retention_expired"`) {
		t.Fatalf("renew expired = %d %s", rec.Code, rec.Body.String())
	}
}

func TestDownloadsManifestContract(t *testing.T) {
	svc := &fakeDownloadService{manifest: downloads.Manifest{
		ManifestVersion: 1, JobID: "job-1", Revision: 7,
		ExpiresAt: "2026-10-01T11:00:00Z",
		Video: downloads.Asset{
			Kind:      downloads.AssetKindVideo,
			Path:      "/v1/downloads/jobs/job-1/assets/video",
			SizeBytes: 2147483648, SHA256: strings.Repeat("a", 64),
		},
	}}
	mux := newDownloadsTestMux(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1/manifest?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"manifestVersion":1`) {
		t.Fatalf("manifest = %d %s", rec.Code, rec.Body.String())
	}

	// Not-ready and missing jobs are safe errors, never partial manifests.
	svc.manifestErr = downloads.ErrNotReady
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1/manifest?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusNotFound {
		// A not-ready manifest MUST NOT be served as a manifest; the surface
		// maps it to not_found so clients cannot mistake it for a package.
		t.Fatalf("not-ready manifest must not be served as 200, got %d %s", rec.Code, rec.Body.String())
	}
	svc.manifestErr = errors.New("internal explosion with secrets")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/downloads/jobs/job-1/manifest?clientId=1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", nil))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "secrets") {
		t.Fatalf("internal error must be a safe envelope, got %d %s", rec.Code, rec.Body.String())
	}
}
