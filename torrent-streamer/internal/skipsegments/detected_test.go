package skipsegments

import (
	"context"
	"net/url"
	"testing"
)

func TestDetectedReplacesProvidersOfTheSameKind(t *testing.T) {
	providers := []Segment{
		{Type: "recap", Start: 0, End: 20, Provider: "aniskip"},
		{Type: "intro", Start: 0, End: 165, Provider: "aniskip"}, // DBZ Kai ep 15: swallows 53 s of story
		{Type: "credits", Start: 1290, End: 1366, Provider: "aniskip"},
	}
	defer func() { Detected = nil }()
	Detected = func(context.Context, url.Values) (*Segment, *Segment, bool) {
		return &Segment{Type: "intro", Start: 25, End: 112, Provider: "torwatch"}, nil, true
	}
	got := withDetected(context.Background(), url.Values{}, providers)
	if len(got) != 3 || got[1].Type != "intro" || got[1].Start != 25 || got[1].Provider != "torwatch" || got[2].Provider != "aniskip" {
		t.Fatalf("merged = %+v", got)
	}
	if providers[1].Start != 0 {
		t.Fatal("the cached provider list was modified")
	}
	Detected = func(context.Context, url.Values) (*Segment, *Segment, bool) { return nil, nil, false }
	if got := withDetected(context.Background(), url.Values{}, providers); len(got) != 3 || got[1].Provider != "aniskip" {
		t.Fatalf("without detection = %+v", got)
	}
}
