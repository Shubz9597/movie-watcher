// Package downloads holds the offline-download contract logic (feature
// docs/offline-downloads, D01). Pure, dependency-light decision code that the
// D02 HTTP handlers and prep workers call; the semantics here are the tested
// contract, finalized BEFORE any server consumer exists. See
// docs/offline-downloads/contracts.md — this package and that document are
// maintained together.
package downloads

import (
	"fmt"
	"time"
)

// Job states (contracts.md §3). Enforced by the download_jobs CHECK
// constraint and ValidateTransition here.
const (
	StatePreparing = "preparing"
	StateReady     = "ready"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
	StateExpired   = "expired"
)

// Safe reason codes (contracts.md §3). Closed enumeration: payloads never
// carry internal error details.
const (
	ReasonNone                    = ""
	ReasonSourceUnavailable       = "source_unavailable"
	ReasonInsufficientServerSpace = "insufficient_server_storage"
	ReasonPreparationFailed       = "preparation_failed"
	// ReasonSubtitlesUnavailable: a requested subtitle language could not be
	// found in the torrent or the subtitle provider (migration 010).
	ReasonSubtitlesUnavailable = "subtitles_unavailable"
	ReasonClientCancelled      = "client_cancelled"
	ReasonReplaced             = "replaced"
	ReasonRetentionExpired     = "retention_expired"
)

// ValidReasonCodes maps every state to its allowed reason codes. A persisted
// (state, reason) pair outside this table is a defect.
var ValidReasonCodes = map[string]map[string]bool{
	StatePreparing: {ReasonNone: true},
	StateReady:     {ReasonNone: true},
	StateFailed: {
		ReasonSourceUnavailable:       true,
		ReasonInsufficientServerSpace: true,
		ReasonPreparationFailed:       true,
		ReasonSubtitlesUnavailable:    true,
	},
	StateCancelled: {
		ReasonClientCancelled: true,
		ReasonReplaced:        true,
	},
	StateExpired: {ReasonRetentionExpired: true},
}

// ValidateReason reports whether (state, reason) is a legal pair.
func ValidateReason(state, reason string) bool {
	allowed, ok := ValidReasonCodes[state]
	if !ok {
		return false
	}
	return allowed[reason]
}

// allowedTransitions lists the legal state changes. failed/cancelled/expired
// are terminal: a retry is a NEW job with a new idempotency key.
var allowedTransitions = map[string]map[string]bool{
	StatePreparing: {StateReady: true, StateFailed: true, StateCancelled: true},
	StateReady:     {StateCancelled: true, StateExpired: true},
	StateFailed:    {},
	StateCancelled: {},
	StateExpired:   {},
}

// ValidateTransition enforces the job state machine (contracts.md §3).
func ValidateTransition(from, to string) error {
	if _, ok := allowedTransitions[from]; !ok {
		return fmt.Errorf("unknown job state %q", from)
	}
	if !allowedTransitions[from][to] {
		return fmt.Errorf("illegal job transition %s -> %s", from, to)
	}
	return nil
}

// Retention policy (contracts.md §5): independent of watch heartbeats;
// default 48h from ready, renewable in 48h steps, capped at 14 days of total
// age from ready.
const (
	DefaultRetention = 48 * time.Hour
	RenewalStep      = 48 * time.Hour
	MaxTotalAge      = 14 * 24 * time.Hour
)

// InitialExpiry returns the first expiry for a job that became ready at
// readyAt.
func InitialExpiry(readyAt time.Time) time.Time {
	return readyAt.Add(DefaultRetention)
}

// RenewedExpiry extends an unexpired job by one renewal step from `now`,
// capped at readyAt + MaxTotalAge. An already-expired job cannot be renewed
// (the device must prepare again).
func RenewedExpiry(readyAt, currentExpiry, now time.Time) (time.Time, error) {
	if !now.Before(currentExpiry) {
		return time.Time{}, fmt.Errorf("job expired at %s", currentExpiry.UTC().Format(time.RFC3339))
	}
	capAt := readyAt.Add(MaxTotalAge)
	extended := now.Add(RenewalStep)
	if extended.After(capAt) {
		extended = capAt
	}
	return extended, nil
}
