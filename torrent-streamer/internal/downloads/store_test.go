package downloads

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver
)

// TestStoreLifecycle verifies the SQL Store against a disposable PostgreSQL
// database: idempotent create, client scoping, cancel/renew state rules,
// manifest roundtrip, and expiry flipping. Skipped (pending, never passed)
// when no disposable database is provided.
func TestStoreLifecycle(t *testing.T) {
	dsn := os.Getenv("TORWATCH_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set; store verification pending a disposable database")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("configured test database failed: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	store := NewStore(db)
	req := CreateRequest{
		ClientID:       "1f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f",
		IdempotencyKey: "store-test-" + strings.ToLower(strings.ReplaceAll(now.Format("150405.000000000"), ".", "-")),
		SeriesID:       "tmdb:movie:693134",
		PickID:         1,
	}

	// Create + idempotent replay return the SAME job.
	job, created, err := store.Create(ctx, req)
	if err != nil || !created {
		t.Fatalf("create: created=%v err=%v", created, err)
	}
	replay, createdAgain, err := store.Create(ctx, req)
	if err != nil || createdAgain || replay.ID != job.ID {
		t.Fatalf("replay must return the same job without creating: created=%v err=%v", createdAgain, err)
	}

	// Client scoping: another client cannot see the job.
	if _, err := store.Get(ctx, "2f0e3d1c-5a2b-4c7d-9e8f-0a1b2c3d4e5f", job.ID); err != ErrNotFound {
		t.Fatalf("foreign client get must be ErrNotFound, got %v", err)
	}

	// Manifest before ready is refused.
	if _, err := store.Manifest(ctx, req.ClientID, job.ID); err != ErrNotFound {
		t.Fatalf("manifest before ready must be ErrNotFound, got %v", err)
	}

	// MarkReady attaches the manifest and starts the retention clock.
	manifest := Manifest{
		ManifestVersion: ManifestVersion, JobID: job.ID, Revision: 1,
		ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
		Video: Asset{
			Kind: AssetKindVideo, Path: "/v1/downloads/jobs/" + job.ID + "/assets/video",
			SizeBytes: 1024, SHA256: strings.Repeat("a", 64),
		},
	}
	if err := store.MarkReady(ctx, job.ID, manifest, now); err != nil {
		t.Fatalf("mark ready: %v", err)
	}
	got, err := store.Manifest(ctx, req.ClientID, job.ID)
	if err != nil || got.Video.SHA256 != manifest.Video.SHA256 {
		t.Fatalf("manifest roundtrip: %v %+v", err, got)
	}

	// A ready job cannot be cancelled server-side (device removal is
	// device-side) and CAN be renewed.
	if _, err := store.Cancel(ctx, req.ClientID, job.ID); err != ErrNotCancellable {
		t.Fatalf("cancel ready must be ErrNotCancellable, got %v", err)
	}
	renewed, err := store.Renew(ctx, req.ClientID, job.ID, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if renewed.ExpiresAt == nil || !renewed.ExpiresAt.After(now.Add(time.Hour)) {
		t.Fatalf("renewal must extend the expiry, got %+v", renewed.ExpiresAt)
	}

	// Expiry flipping: force the window into the past, then ExpireDue.
	past := now.Add(-2 * time.Hour)
	if _, err := db.ExecContext(ctx, `UPDATE download_jobs SET expires_at=$1 WHERE id=$2`, past, job.ID); err != nil {
		t.Fatalf("force expiry: %v", err)
	}
	ids, err := store.ExpireDue(ctx, now, 50)
	if err != nil {
		t.Fatalf("expire due: %v", err)
	}
	found := false
	for _, id := range ids {
		if id == job.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("expired job id missing from ExpireDue result: %v", ids)
	}
	final, err := store.Get(ctx, req.ClientID, job.ID)
	if err != nil || final.State != StateExpired || final.ReasonCode != ReasonRetentionExpired {
		t.Fatalf("expired state: %+v err=%v", final, err)
	}
	// An expired job is terminal: no further renewal.
	if _, err := store.Renew(ctx, req.ClientID, job.ID, now); err != ErrExpired && err != ErrNotCancellable {
		t.Fatalf("renew expired must be refused, got %v", err)
	}
}
