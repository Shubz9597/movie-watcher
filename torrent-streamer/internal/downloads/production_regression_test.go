package downloads

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"torrent-streamer/migrations"
)

func regressionStore(t *testing.T) (*Store, Job) {
	t.Helper()
	if os.Getenv("TORWATCH_TEST_PG_DSN") == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	db, err := sql.Open("pgx", os.Getenv("TORWATCH_TEST_PG_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	s := NewStore(db)
	j, _, err := s.Create(ctx, CreateRequest{ClientID: "audit-client", IdempotencyKey: t.Name() + time.Now().Format("150405.000000000"), SeriesID: "tmdb:movie:1", PickID: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = s.DB.ExecContext(context.Background(), `DELETE FROM download_jobs WHERE id=$1`, j.ID) })
	return s, j
}
func TestRegressionRenewManifest(t *testing.T) {
	s, j := regressionStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	path := "/v1/downloads/jobs/" + j.ID + "/assets/video"
	m := Manifest{ManifestVersion: 1, JobID: j.ID, Revision: 1, ExpiresAt: now.Add(time.Hour).Format(time.RFC3339), Video: Asset{Kind: AssetKindVideo, Path: path, SizeBytes: 1, SHA256: strings.Repeat("a", 64)}}
	if err := s.MarkReady(ctx, j.ID, m, []AssetRow{{Kind: AssetKindVideo, URLPath: path, DiskPath: "ready/" + j.ID + "/video.mp4", SizeBytes: 1, SHA256: strings.Repeat("a", 64)}}, now.Add(-47*time.Hour)); err != nil {
		t.Fatal(err)
	}
	renewed, err := s.Renew(ctx, j.ClientID, j.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	m, err = s.Manifest(ctx, j.ClientID, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if m.Revision != 1 {
		t.Fatal("renewal changed immutable content revision")
	}
	if m.ExpiresAt != renewed.ExpiresAt.UTC().Format(time.RFC3339) {
		t.Errorf("Renew expiry=%s but Manifest expiry=%s, want same expiry", renewed.ExpiresAt, m.ExpiresAt)
	}
}
func TestRegressionSweepPreservesLiveClaim(t *testing.T) {
	s, j := regressionStore(t)
	ctx := context.Background()
	if _, err := s.ClaimPreparing(ctx, j.ID, "live-worker"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.ExecContext(ctx, `UPDATE download_jobs SET claimed_at=now()-interval '16 minutes' WHERE id=$1`, j.ID); err != nil {
		t.Fatal(err)
	}
	p := NewPrepper(s, nil, t.TempDir(), 2)
	p.Sweep(ctx)
	_, err := s.ClaimPreparing(ctx, j.ID, "second-worker")
	if err == nil {
		t.Errorf("ClaimPreparing admitted second worker for active job %s", j.ID)
	}
}

func TestRetentionCleanupRetriesFailedFileRemoval(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission failure requires an unprivileged test user")
	}
	s, j := regressionStore(t)
	ctx := context.Background()
	root := t.TempDir()
	p := NewPrepper(s, nil, root, 1)
	dir := p.readyDir(j.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "video.mp4")
	if err := os.WriteFile(file, []byte("video"), 0600); err != nil {
		t.Fatal(err)
	}
	asset := AssetRow{Kind: AssetKindVideo, URLPath: "/v1/downloads/jobs/" + j.ID + "/assets/video", DiskPath: "ready/" + j.ID + "/video.mp4", SizeBytes: 5, SHA256: strings.Repeat("a", 64)}
	old := time.Now().UTC().Add(-72 * time.Hour)
	if err := s.MarkReady(ctx, j.ID, buildManifest(j.ID, []AssetRow{asset}, old), []AssetRow{asset}, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0700) })
	p.Sweep(ctx)
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("expected simulated deletion failure: %v", err)
	}
	var cleaned bool
	if err := s.DB.QueryRowContext(ctx, `SELECT cleanup_completed_at IS NOT NULL FROM download_jobs WHERE id=$1`, j.ID).Scan(&cleaned); err != nil {
		t.Fatal(err)
	}
	if cleaned {
		t.Fatal("failed deletion was marked complete")
	}
	var assets int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM download_assets WHERE job_id=$1`, j.ID).Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if assets != 1 {
		t.Fatal("retry lost the asset record before deleting files")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	p.Sweep(ctx)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("retry did not remove files: %v", err)
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT cleanup_completed_at IS NOT NULL FROM download_jobs WHERE id=$1`, j.ID).Scan(&cleaned); err != nil {
		t.Fatal(err)
	}
	if !cleaned {
		t.Fatal("successful cleanup still pending")
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM download_assets WHERE job_id=$1`, j.ID).Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if assets != 0 {
		t.Fatal("successful cleanup retained asset rows")
	}
}

func TestRestartCleansUnpublishedDirectoriesAndPreservesReady(t *testing.T) {
	s, j := regressionStore(t)
	ctx := context.Background()
	p := NewPrepper(s, nil, t.TempDir(), 1)
	if _, err := s.ClaimPreparing(ctx, j.ID, "previous-process"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.stagingDir(j.ID), p.readyDir(j.ID)} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "partial.mp4"), []byte("partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ready, _, err := s.Create(ctx, CreateRequest{ClientID: j.ClientID, IdempotencyKey: t.Name() + "-ready", SeriesID: j.SeriesID, PickID: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.ExecContext(context.Background(), `DELETE FROM download_jobs WHERE id=$1`, ready.ID) })
	if _, err := s.DB.ExecContext(ctx, `UPDATE download_jobs SET state='ready',ready_at=now(),expires_at=now()+interval '1 day' WHERE id=$1`, ready.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(p.readyDir(ready.ID), 0700); err != nil {
		t.Fatal(err)
	}
	released, err := p.ReconcileStartup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if released < 1 {
		t.Fatal("abandoned worker claim retained")
	}
	for _, dir := range []string{p.stagingDir(j.ID), p.readyDir(j.ID)} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("orphan retained: %s: %v", dir, err)
		}
	}
	if _, err := os.Stat(p.readyDir(ready.ID)); err != nil {
		t.Fatalf("published package removed: %v", err)
	}
}

func TestSpaceAdmissionRejectsImpossibleAllocation(t *testing.T) {
	root := t.TempDir()
	if err := checkPreparationSpace(root, root, 1); err != nil {
		t.Fatal(err)
	}
	if err := checkPreparationSpace(root, root, 1<<62); err == nil {
		t.Fatal("impossible preparation admitted")
	}
}
