package subsync

import "testing"

// Dragon Ball Z Kai episode 50 (the Goku-Frieza fight, BlackRabbit
// release): the English dub captions fit the dub audio at only 0.21, but
// far better than the video's own translation (-0.24) and the other file.
func TestPickDubByClearMargin(t *testing.T) {
	judged := []Judged{
		{Candidate: Candidate{Name: "dub captions"}, Match: Match{R: 0.21}},
		{Candidate: Candidate{Name: "other"}, Match: Match{R: -0.23}},
	}
	if best, ok := PickDub(judged, -0.24); !ok || best.Name != "dub captions" {
		t.Fatalf("clear winner not taken: %+v %v", best, ok)
	}
	if _, ok := PickDub(judged, 0.05); ok {
		t.Fatal("0.21 against a video track at 0.05 is not clear")
	}
	close := []Judged{{Match: Match{R: 0.21}}, {Match: Match{R: 0.12}}}
	if _, ok := PickDub(close, -0.24); ok {
		t.Fatal("two close candidates: neither is clearly the dub's")
	}
	if _, ok := PickDub([]Judged{{Match: Match{R: 0.12}}}, -0.5); ok {
		t.Fatal("below SyncMinR is noise")
	}
	if _, ok := PickDub([]Judged{{Match: Match{R: 0.46}}, {Match: Match{R: 0.07}}}, 0.07); !ok {
		t.Fatal("episode 20's strong match still taken")
	}
}
