package catalog

import (
	"context"
	"sync/atomic"
	"testing"
)

func TestDetailCacheKeepsCrossLinksAndAvoidsRepeatedCalls(t *testing.T) {
	var primaryCalls, secondaryCalls atomic.Int32
	primary := &fakeProvider{name: "anilist", detailFn: func(context.Context, DetailRequest) (Title, error) {
		primaryCalls.Add(1)
		return Title{ID: "anilist:1", Title: "Anime", Type: TypeAnime,
			ProviderIDs: map[string]string{"anilist": "1", "jikan": "2"}}, nil
	}}
	secondary := &fakeProvider{name: "jikan", detailFn: func(_ context.Context, request DetailRequest) (Title, error) {
		secondaryCalls.Add(1)
		if request.ProviderIDs["jikan"] != "2" {
			return Title{}, ErrNotFound
		}
		return Title{ID: "jikan:2", Overview: "Enriched", ProviderIDs: map[string]string{"jikan": "2"}}, nil
	}}
	s := NewService([]Provider{primary, secondary}, Options{})
	first := s.Detail(context.Background(), "anilist:1")
	first.Title.ProviderIDs["jikan"] = "outside"
	second := s.Detail(context.Background(), "anilist:1")
	if !second.Found || second.Title.ProviderIDs["jikan"] != "2" || second.Title.Overview != "Enriched" {
		t.Fatalf("cached Detail(anilist:1) = %+v, want original cross-links and enrichment", second)
	}
	if primaryCalls.Load() != 1 || secondaryCalls.Load() != 1 {
		t.Fatalf("detail provider calls = (%d,%d), want (1,1)", primaryCalls.Load(), secondaryCalls.Load())
	}
}
