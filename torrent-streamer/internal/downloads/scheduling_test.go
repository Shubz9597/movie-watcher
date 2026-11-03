package downloads

import (
	"reflect"
	"testing"
)

func source(id, hash string, claimed bool, index int) PreparingSource {
	return PreparingSource{JobID: id, Claimed: claimed, InfoHash: hash, SourceKind: "anime", FileIndex: &index}
}

// Kai Season 2 from one pack, oldest first, plus one film from another
// torrent queued later.
func TestPlanRunsOtherTorrentsInParallelAndReadsAheadTheSamePack(t *testing.T) {
	const pack, film = "5db1c595ced26a6607dd648b8f4f692d959dfd9a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	sources := []PreparingSource{
		source("e55", pack, true, 159),
		source("e56", pack, false, 160),
		source("e57", pack, false, 146),
		source("e58", pack, false, 145),
		source("film", film, false, 0),
	}
	got := plan(sources, 1) // one slot left beside e55
	if !reflect.DeepEqual(got.claim, []string{"film"}) {
		t.Fatalf("claim %v: the pack's next episode must not run beside e55; the film may", got.claim)
	}
	var ahead []string
	for _, src := range got.readAhead {
		ahead = append(ahead, src.JobID)
	}
	if !reflect.DeepEqual(ahead, []string{"e56", "e57"}) {
		t.Fatalf("read ahead %v, want the pack's next two", ahead)
	}
	if !got.protected[sourceKey("anime", pack)] || !got.protected[sourceKey("anime", film)] {
		t.Fatalf("protected %v: every waiting job's torrent keeps its data", got.protected)
	}
}

func TestPlanStartsTheOldestWhenIdle(t *testing.T) {
	const pack = "5db1c595ced26a6607dd648b8f4f692d959dfd9a"
	got := plan([]PreparingSource{source("e1", pack, false, 1), source("e2", pack, false, 2)}, 2)
	if !reflect.DeepEqual(got.claim, []string{"e1"}) {
		t.Fatalf("claim %v: one job per torrent", got.claim)
	}
	if len(got.readAhead) != 1 || got.readAhead[0].JobID != "e2" {
		t.Fatalf("read ahead %v", got.readAhead)
	}
}
