package recommendations

import (
	"context"
	"errors"
	"testing"
)

type failingTaste struct{ calls int }

func (f *failingTaste) HouseholdSignals(context.Context) ([]TasteSignal, error) {
	f.calls++
	return nil, errors.New("taste store unavailable")
}
func TestRegressionTasteFailureFallback(t *testing.T) {
	taste := &failingTaste{}
	s := New(Deps{Library: &fakeLibrary{revision: 1}, Candidates: &fakeCandidates{}, SeedGenres: &fakeSeedGenres{}, Taste: taste})
	result, err := s.Recommend(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Degraded {
		t.Error("fallback must report degraded")
	}
	if taste.calls != 1 {
		t.Errorf("Recommend(taste failure) called taste %d times, want one followed by legacy fallback", taste.calls)
	}
}

func TestCancelledTasteFailureDoesNotRetry(t *testing.T) {
	taste := &failingTaste{}
	s := New(Deps{Library: &fakeLibrary{revision: 1}, Candidates: &fakeCandidates{}, SeedGenres: &fakeSeedGenres{}, Taste: taste})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.computeFromTaste(ctx, 1)
	if !errors.Is(err, context.Canceled) || taste.calls != 1 {
		t.Fatalf("calls=%d error=%v", taste.calls, err)
	}
}
