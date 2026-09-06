package main

import (
	"context"
	"testing"
)

// TestDualClientSharedBackendAndProgressVisibility is the harness-level
// demonstration of quickstart §3 / SC-002: two independent clients
// (different persisted client ids, zero per-client backend changes) use the
// SAME backend, see the same catalog, and share household progress.
// The interactive Electron + reference-client run remains the recorded
// acceptance evidence (see evidence/p6-dual-client.md).
func TestDualClientSharedBackendAndProgressVisibility(t *testing.T) {
	server := newStubBackend(t)
	ctx := context.Background()

	clientA := newTestClient(t, server)
	clientB := newTestClient(t, server)
	if clientA.ClientID == clientB.ClientID {
		t.Fatal("the two clients must have independent client ids")
	}

	// Both clients search the same title through the same endpoints.
	titlesA, err := clientA.Search(ctx, "frieren")
	if err != nil {
		t.Fatalf("client A search: %v", err)
	}
	titlesB, err := clientB.Search(ctx, "frieren")
	if err != nil {
		t.Fatalf("client B search: %v", err)
	}
	if len(titlesA) != 1 || len(titlesB) != 1 || titlesA[0].ID != titlesB[0].ID {
		t.Fatalf("both clients must see identical catalog results: %+v vs %+v", titlesA, titlesB)
	}

	// Client A saves progress; client B observes the shared saved progress
	// under the same household subject and can resume from it.
	if err := clientA.Heartbeat(ctx, HeartbeatRequest{
		SubjectID: "household-subject", SeriesID: "tmdb:209867", Season: 1, Episode: 1,
		PositionS: 640, DurationS: 1440, ClientID: clientA.ClientID, Seq: 10,
	}); err != nil {
		t.Fatalf("client A heartbeat: %v", err)
	}

	stateB, err := clientB.Resume(ctx, "household-subject", "tmdb:209867")
	if err != nil {
		t.Fatalf("client B resume: %v", err)
	}
	if !stateB.Found || stateB.PositionS != 625 {
		t.Fatalf("client B must observe client A's shared progress (640 - 15 rewind): %+v", stateB)
	}

	// Client B continues from there; the shared state moves for both.
	if err := clientB.Heartbeat(ctx, HeartbeatRequest{
		SubjectID: "household-subject", SeriesID: "tmdb:209867", Season: 1, Episode: 1,
		PositionS: 900, DurationS: 1440, ClientID: clientB.ClientID, Seq: 5,
	}); err != nil {
		t.Fatalf("client B heartbeat: %v", err)
	}
	stateA, err := clientA.Resume(ctx, "household-subject", "tmdb:209867")
	if err != nil {
		t.Fatalf("client A resume: %v", err)
	}
	if !stateA.Found || stateA.PositionS != 885 {
		t.Fatalf("client A must observe client B's newer shared progress (900 - 15): %+v", stateA)
	}
}
