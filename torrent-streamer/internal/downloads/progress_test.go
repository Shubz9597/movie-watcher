package downloads

import (
	"testing"
)

func baseUpdate() OfflineProgressUpdate {
	return OfflineProgressUpdate{
		ClientID:  "client-1",
		UpdateID:  "update-1",
		SeriesID:  "tmdb:tv:1396",
		Season:    1,
		Episode:   4,
		PositionS: 600,
		DurationS: 2820,
	}
}

func recordAt(rev int64, pos int) *ProgressRecord {
	return &ProgressRecord{Revision: rev, PositionS: pos, DurationS: 2820}
}

func TestOfflineProgressValidation(t *testing.T) {
	next := int64(13)
	if o := ApplyOfflineProgress(OfflineProgressUpdate{UpdateID: "u"}, 0, nil, nil, next); o.Kind != OutcomeInvalid {
		t.Fatalf("missing client id must be invalid, got %s", o.Kind)
	}
	if o := ApplyOfflineProgress(baseUpdate(), 0, nil, nil, 0); o.Kind != OutcomeInvalid {
		t.Fatalf("non-positive next revision must be invalid, got %s", o.Kind)
	}
	u := baseUpdate()
	u.Season = -1
	if o := ApplyOfflineProgress(u, 0, nil, nil, next); o.Kind != OutcomeInvalid {
		t.Fatalf("negative season must be invalid, got %s", o.Kind)
	}
}

func TestOfflineProgressCommittedOnAbsentRecordWithBaseZero(t *testing.T) {
	o := ApplyOfflineProgress(baseUpdate(), 0, nil, nil, 13)
	if o.Kind != OutcomeCommitted || o.Revision != 13 || o.PositionS != 600 {
		t.Fatalf("absent record + base 0 must commit at next revision, got %+v", o)
	}
}

func TestOfflineProgressCommittedOnMatchingBase(t *testing.T) {
	// Matching base commits regardless of position: deliberate rewind is a
	// valid write; furthest-position-wins is prohibited.
	o := ApplyOfflineProgress(baseUpdate(), 12, recordAt(12, 900), nil, 13)
	if o.Kind != OutcomeCommitted || o.PositionS != 600 {
		t.Fatalf("matching base must commit the device position (rewind allowed), got %+v", o)
	}
}

func TestOfflineProgressConflictOnStaleBase(t *testing.T) {
	// Another client moved the record forward while this device was offline:
	// conflict carrying the CURRENT position — never a blind overwrite.
	o := ApplyOfflineProgress(baseUpdate(), 11, recordAt(14, 900), nil, 13)
	if o.Kind != OutcomeConflict {
		t.Fatalf("stale base must conflict, got %s", o.Kind)
	}
	if o.Current == nil || o.Current.Revision != 14 || o.Current.PositionS != 900 {
		t.Fatalf("conflict must carry the current server position/revision, got %+v", o.Current)
	}
}

func TestOfflineProgressConflictWhenRecordVanished(t *testing.T) {
	// Device believed the record existed (base 12) but it is absent now:
	// conflict with the absent-state current, never a silent insert.
	o := ApplyOfflineProgress(baseUpdate(), 12, nil, nil, 13)
	if o.Kind != OutcomeConflict {
		t.Fatalf("absent record with non-zero base must conflict, got %s", o.Kind)
	}
	if o.Current == nil || o.Current.Revision != 0 || o.Current.PositionS != 0 {
		t.Fatalf("conflict must represent the absent record, got %+v", o.Current)
	}
}

func TestOfflineProgressIdempotentReplay(t *testing.T) {
	// A retried update replays its recorded result verbatim — even when the
	// record state has since moved on (the ledger wins).
	recorded := RecordedOutcome{Kind: OutcomeCommitted, Revision: 13, PositionS: 600, DurationS: 2820}
	o := ApplyOfflineProgress(baseUpdate(), 12, recordAt(15, 1200), &recorded, 16)
	if o.Kind != OutcomeDuplicate || o.Revision != 13 || o.PositionS != 600 {
		t.Fatalf("recorded update must replay verbatim, got %+v", o)
	}
	// The ledger entry for the same update is returned again, unchanged.
	o2 := ApplyOfflineProgress(baseUpdate(), 15, recordAt(15, 1200), &recorded, 16)
	if o2.Kind != OutcomeDuplicate || o2.Revision != 13 {
		t.Fatalf("duplicate replay must be stable, got %+v", o2)
	}
}

func TestOfflineProgressClampsLikeServerPath(t *testing.T) {
	// Position beyond duration clamps to the duration (parity with the
	// existing server-ordered write path).
	u := baseUpdate()
	u.PositionS = 99999
	o := ApplyOfflineProgress(u, 0, nil, nil, 13)
	if o.Kind != OutcomeCommitted || o.PositionS != u.DurationS {
		t.Fatalf("position must clamp to duration, got %+v", o)
	}
}
