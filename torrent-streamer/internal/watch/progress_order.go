package watch

// Ordered-write decision logic for watch progress (spec Clarification 3,
// FR-006, contracts/leases-and-progress.md §Rules):
//
//  1. Last-write-wins by successful SERVER commit order — the revision is
//     server-assigned and monotonic per row; client timestamps are never used.
//  2. Per-session sequence guard: within one stream session, an update whose
//     seq is <= the highest accepted seq for that session is ignored
//     ("stale_seq") so a delayed heartbeat retry cannot move progress backward.
//  3. A deliberate rewind from a currently valid session is a valid new write
//     (any position is accepted; only the seq must advance).
//  4. Furthest-position-wins is prohibited and is not implemented anywhere.
//  5. Low-fidelity stream auto-save estimates never overwrite a row written
//     by an explicit client session ("stale_estimate") — renderer heartbeats
//     remain the preferred high-fidelity source (contract rule 6).
//  6. Legacy V1 bodies (no clientID/sessionID/seq) behave as anonymous
//     single-session writes with commit-order LWW — identical to V1 outcomes
//     (contract rule 7).
//
// ClientID is last-writer metadata only and is never the sole ownership key.

// ProgressRowState is the locked current state of a progress row.
type ProgressRowState struct {
	Exists   bool
	Revision int64
	// SessionID is the stream session that produced the current row ("" when
	// written anonymously, e.g. by V1 callers or the stream auto-save).
	SessionID string
	// LastSeq is the last accepted sequence for the incoming session, even
	// when another session produced the current progress row. Nil means unseen.
	LastSeq *int64
}

// OrderedDecision is the outcome of applying the ordering rules.
type OrderedDecision struct {
	Accepted     bool
	Ignored      string // "stale_seq" | "stale_estimate" when not accepted
	NextRevision int64
}

// DecideOrderedWrite is pure so the ordering contract is unit-testable
// without a database; the SQL store applies the decision inside its row
// transaction.
func DecideOrderedWrite(state ProgressRowState, update ProgressUpdate) OrderedDecision {
	if !state.Exists {
		return OrderedDecision{Accepted: true, NextRevision: 1}
	}
	if update.LowFidelity && state.SessionID != "" {
		return OrderedDecision{Ignored: "stale_estimate"}
	}
	if update.SessionID != "" && state.LastSeq != nil && update.Seq <= *state.LastSeq {
		return OrderedDecision{Ignored: "stale_seq"}
	}
	return OrderedDecision{Accepted: true, NextRevision: state.Revision + 1}
}
