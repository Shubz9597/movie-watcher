package watch

import "testing"

func TestDecideOrderedWriteFirstWrite(t *testing.T) {
	decision := DecideOrderedWrite(ProgressRowState{}, ProgressUpdate{SessionID: "s1", Seq: 10})
	if !decision.Accepted || decision.NextRevision != 1 {
		t.Fatalf("first write = %+v", decision)
	}
}

func TestDecideOrderedWriteStaleSeqRejected(t *testing.T) {
	lastSeq := int64(10)
	state := ProgressRowState{Exists: true, Revision: 4, SessionID: "s1", LastSeq: &lastSeq}
	decision := DecideOrderedWrite(state, ProgressUpdate{SessionID: "s1", Seq: 9})
	if decision.Accepted || decision.Ignored != "stale_seq" {
		t.Fatalf("delayed retry must be ignored as stale_seq: %+v", decision)
	}
	decision = DecideOrderedWrite(state, ProgressUpdate{SessionID: "s1", Seq: 10})
	if decision.Accepted || decision.Ignored != "stale_seq" {
		t.Fatalf("seq equal to last accepted must be ignored: %+v", decision)
	}
}

func TestDecideOrderedWriteSameSessionAdvancingSeqAcceptsDeliberateRewind(t *testing.T) {
	lastSeq := int64(10)
	state := ProgressRowState{Exists: true, Revision: 4, SessionID: "s1", LastSeq: &lastSeq}
	// Deliberate rewind: advancing seq with a lower position is a valid write
	// (furthest-position-wins is prohibited).
	decision := DecideOrderedWrite(state, ProgressUpdate{SessionID: "s1", Seq: 11, Position: 120})
	if !decision.Accepted || decision.NextRevision != 5 {
		t.Fatalf("deliberate rewind = %+v", decision)
	}
}

func TestDecideOrderedWriteNewSessionAcceptsAnySeq(t *testing.T) {
	state := ProgressRowState{Exists: true, Revision: 4, SessionID: "s1"}
	decision := DecideOrderedWrite(state, ProgressUpdate{SessionID: "s2", Seq: 1})
	if !decision.Accepted || decision.NextRevision != 5 {
		t.Fatalf("different session must not be seq-guarded: %+v", decision)
	}
}

func TestDecideOrderedWriteLowFidelityNeverOverwritesExplicitSession(t *testing.T) {
	lastSeq := int64(41)
	state := ProgressRowState{Exists: true, Revision: 7, SessionID: "renderer-session", LastSeq: &lastSeq}
	decision := DecideOrderedWrite(state, ProgressUpdate{LowFidelity: true})
	if decision.Accepted || decision.Ignored != "stale_estimate" {
		t.Fatalf("stream estimate must not overwrite a heartbeat row: %+v", decision)
	}
}

func TestDecideOrderedWriteLowFidelityAllowedOnAnonymousRow(t *testing.T) {
	state := ProgressRowState{Exists: true, Revision: 3}
	decision := DecideOrderedWrite(state, ProgressUpdate{LowFidelity: true})
	if !decision.Accepted || decision.NextRevision != 4 {
		t.Fatalf("V1-style auto-save on an anonymous row must behave as V1 LWW: %+v", decision)
	}
}

func TestDecideOrderedWriteAnonymousLegacyWritesAlwaysCommitOrder(t *testing.T) {
	state := ProgressRowState{Exists: true, Revision: 2}
	decision := DecideOrderedWrite(state, ProgressUpdate{})
	if !decision.Accepted || decision.NextRevision != 3 {
		t.Fatalf("legacy anonymous write = %+v", decision)
	}
}

func TestDecideOrderedWriteRejectsRetryAfterAnotherSessionWrote(t *testing.T) {
	lastSeq := int64(10)
	state := ProgressRowState{Exists: true, Revision: 2, SessionID: "session-b", LastSeq: &lastSeq}
	decision := DecideOrderedWrite(state, ProgressUpdate{SessionID: "session-a", Seq: 9})
	if decision.Accepted || decision.Ignored != "stale_seq" {
		t.Fatalf("retry after another writer = %+v, want stale_seq", decision)
	}
}
