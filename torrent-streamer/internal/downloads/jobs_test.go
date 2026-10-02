package downloads

import (
	"testing"
	"time"
)

func TestValidateTransition(t *testing.T) {
	legal := map[string][]string{
		StatePreparing: {StateReady, StateFailed, StateCancelled},
		StateReady:     {StateCancelled, StateExpired},
	}
	for from, tos := range legal {
		for _, to := range tos {
			if err := ValidateTransition(from, to); err != nil {
				t.Fatalf("expected %s -> %s to be legal: %v", from, to, err)
			}
		}
	}
	// Terminal states have no exits; a retry is a NEW job.
	for _, from := range []string{StateFailed, StateCancelled, StateExpired} {
		for _, to := range []string{StatePreparing, StateReady, StateFailed, StateCancelled, StateExpired} {
			if err := ValidateTransition(from, to); err == nil {
				t.Fatalf("terminal state %s must not transition to %s", from, to)
			}
		}
	}
	// No skipping the machine: preparing cannot jump to expired, ready
	// cannot go back to preparing.
	if err := ValidateTransition(StatePreparing, StateExpired); err == nil {
		t.Fatalf("preparing -> expired must be illegal")
	}
	if err := ValidateTransition(StateReady, StatePreparing); err == nil {
		t.Fatalf("ready -> preparing must be illegal")
	}
}

func TestValidateReason(t *testing.T) {
	if !ValidateReason(StatePreparing, ReasonNone) {
		t.Fatalf("preparing with empty reason is legal")
	}
	if !ValidateReason(StateFailed, ReasonSourceUnavailable) {
		t.Fatalf("failed/source_unavailable is legal")
	}
	if !ValidateReason(StateFailed, ReasonSubtitlesUnavailable) {
		t.Fatalf("failed/subtitles_unavailable is legal (migration 010)")
	}
	if ValidateReason(StateFailed, ReasonNone) {
		t.Fatalf("failed without a reason is illegal")
	}
	if ValidateReason(StateReady, ReasonPreparationFailed) {
		t.Fatalf("ready with a failure reason is illegal")
	}
	if ValidateReason(StateExpired, ReasonClientCancelled) {
		t.Fatalf("expired/cancelled is illegal")
	}
	if ValidateReason("unknown", ReasonNone) {
		t.Fatalf("unknown state must be rejected")
	}
}

func TestRenewedExpiry(t *testing.T) {
	ready := time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)
	expiry := InitialExpiry(ready)
	if !expiry.Equal(ready.Add(DefaultRetention)) {
		t.Fatalf("initial expiry must be ready + 48h, got %s", expiry)
	}

	// Renewal extends one step from NOW, not from the old expiry.
	now := expiry.Add(-4 * time.Hour)
	extended, err := RenewedExpiry(ready, expiry, now)
	if err != nil {
		t.Fatalf("renewal before expiry must succeed: %v", err)
	}
	if !extended.Equal(now.Add(RenewalStep)) {
		t.Fatalf("renewal must extend from the renewal instant, got %s", extended)
	}

	// An expired job cannot be renewed — the device prepares again.
	if _, err := RenewedExpiry(ready, expiry, expiry.Add(time.Second)); err == nil {
		t.Fatalf("renewal after expiry must fail")
	}

	// The total-age cap binds: near the cap, extension clamps to
	// ready + MaxTotalAge.
	late := ready.Add(MaxTotalAge - time.Hour)
	capped, err := RenewedExpiry(ready, late.Add(RenewalStep), late)
	if err != nil {
		t.Fatalf("renewal near cap must succeed: %v", err)
	}
	if !capped.Equal(ready.Add(MaxTotalAge)) {
		t.Fatalf("renewal must clamp to the 14-day cap, got %s", capped)
	}
}
