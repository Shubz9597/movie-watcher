package downloads

import (
	"strings"
)

// Offline progress import semantics (contracts.md §6). The pure decision
// function below is what the D02 SQL layer applies inside its transaction;
// every acceptance-relevant behavior (idempotency, conditional base
// revision, explicit conflicts, no furthest-position-wins, no wall-clock
// inference) is defined and tested HERE, before any server consumer exists.

// ProgressRecord is the server-side state of one progress row. Revision 0
// with Position 0 represents "record absent / never synced".
type ProgressRecord struct {
	Revision  int64
	PositionS int
	DurationS int
}

// AbsentRecord is the canonical "no record" state.
var AbsentRecord = ProgressRecord{Revision: 0, PositionS: 0, DurationS: 0}

// OfflineProgressUpdate is one device-side checkpoint offered for import.
// UpdateID is stable per attempt and device-persisted until acknowledged;
// BaseRevision is the server revision the device's offline state was based
// on (0 = record should be absent/never synced).
type OfflineProgressUpdate struct {
	ClientID  string
	UpdateID  string
	SeriesID  string
	Season    int
	Episode   int
	PositionS int
	DurationS int
}

// RecordedOutcome is the ledger entry for an already-seen updateId: the
// EXACT result previously returned, replayed verbatim (idempotency).
type RecordedOutcome struct {
	Kind      string // "committed" or "duplicate" (conflicts are NOT recorded; the device may retry or resolve)
	Revision  int64
	PositionS int
	DurationS int
}

// ImportOutcome is the decision for one update.
type ImportOutcome struct {
	Kind      string // "committed" | "duplicate" | "conflict" | "invalid"
	Revision  int64  // committed/duplicate: the resulting revision
	PositionS int    // committed/duplicate: the recorded position
	DurationS int
	// Current carries the server state for a conflict: the position/revision
	// the device must show in WF08. Revision 0 = record absent.
	Current *ProgressRecord
	// NextRevision is the revision the SQL layer must persist for a commit
	// (it passes its server-ordered next value in; the pure function never
	// invents revisions).
	NextRevision int64
}

// Outcome kinds.
const (
	OutcomeCommitted = "committed"
	OutcomeDuplicate = "duplicate"
	OutcomeConflict  = "conflict"
	OutcomeInvalid   = "invalid"
)

func clampPosition(update OfflineProgressUpdate) OfflineProgressUpdate {
	if update.PositionS < 0 {
		update.PositionS = 0
	}
	if update.DurationS < 0 {
		update.DurationS = 0
	}
	if update.DurationS > 0 && update.PositionS > update.DurationS {
		update.PositionS = update.DurationS
	}
	return update
}

// ApplyOfflineProgress decides the outcome of one offline import.
//
// Contract (contracts.md §6):
//   - an already-recorded updateId replays its recorded outcome verbatim
//     (idempotent retries; the ledger lookup happens inside the same
//     transaction);
//   - a commit applies ONLY when the record state matches the device's
//     base: absent with base 0, or present with base == record revision;
//   - deliberate rewind is a valid write; furthest-position-wins and
//     wall-clock comparison are prohibited — a mismatched base is a
//     conflict carrying the CURRENT server position/revision for WF08;
//   - conflicts are not ledgered: the device may retry (idempotent) or
//     resolve with a NEW updateId and fresh base.
func ApplyOfflineProgress(update OfflineProgressUpdate, baseRevision int64, existing *ProgressRecord, recorded *RecordedOutcome, nextRevision int64) ImportOutcome {
	if strings.TrimSpace(update.ClientID) == "" || strings.TrimSpace(update.UpdateID) == "" ||
		strings.TrimSpace(update.SeriesID) == "" || update.Season < 0 || update.Episode < 0 {
		return ImportOutcome{Kind: OutcomeInvalid}
	}
	if nextRevision <= 0 {
		return ImportOutcome{Kind: OutcomeInvalid}
	}
	update = clampPosition(update)
	if update.DurationS > 0 && update.PositionS == 0 && baseRevision == 0 {
		// A zero-position checkpoint for a never-synced record carries no
		// information; the device should not import it.
		return ImportOutcome{Kind: OutcomeInvalid}
	}

	// 1. Idempotency ledger wins over everything.
	if recorded != nil {
		return ImportOutcome{
			Kind:      OutcomeDuplicate,
			Revision:  recorded.Revision,
			PositionS: recorded.PositionS,
			DurationS: recorded.DurationS,
		}
	}

	// 2. Canonicalize the existing-record view.
	current := AbsentRecord
	recordPresent := existing != nil
	if recordPresent {
		current = *existing
		if current.Revision <= 0 {
			current.Revision = 0
			current.PositionS = 0
			current.DurationS = 0
			recordPresent = false
		}
	}

	// 3. Conditional application on the device's base revision.
	baseMatches := (baseRevision == 0 && !recordPresent) ||
		(recordPresent && baseRevision == current.Revision)
	if !baseMatches {
		currentCopy := current
		return ImportOutcome{Kind: OutcomeConflict, Current: &currentCopy}
	}

	return ImportOutcome{
		Kind:         OutcomeCommitted,
		Revision:     nextRevision,
		PositionS:    update.PositionS,
		DurationS:    update.DurationS,
		NextRevision: nextRevision,
	}
}
