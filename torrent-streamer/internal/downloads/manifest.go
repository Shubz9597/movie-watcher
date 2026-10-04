package downloads

import (
	"fmt"
	"strings"
	"time"
)

// ManifestVersion is the only manifest schema this package validates
// (contracts.md §4). Clients reject unknown versions.
const ManifestVersion = 1

// Asset kinds. The v1 manifest carries exactly one video and zero or more
// requested subtitle sidecars.
const (
	AssetKindVideo    = "video"
	AssetKindSubtitle = "subtitle"
)

// Asset is one immutable downloadable file (contracts.md §4).
type Asset struct {
	Kind      string `json:"kind"`
	Lang      string `json:"lang,omitempty"` // subtitles: ISO 639-1
	Path      string `json:"path"`           // ORIGIN-RELATIVE, no scheme/authority/query
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"` // strong validator: exact expected bytes
}

// Manifest is the ready-package payload of a completed preparation job.
// Revision is immutable for the job's lifetime; a different validator means a
// different revision and resume data MUST be discarded.
type Manifest struct {
	ManifestVersion int     `json:"manifestVersion"`
	JobID           string  `json:"jobId"`
	Revision        int64   `json:"revision"`
	ExpiresAt       string  `json:"expiresAt"` // RFC3339 UTC
	Video           Asset   `json:"video"`
	Subtitles       []Asset `json:"subtitles"`
}

// assetPathPrefix is the required origin-relative prefix; the job id segment
// in the path MUST match the manifest's job (URL-ownership rule).
func assetPathPrefix(jobID string) string {
	return "/v1/downloads/jobs/" + jobID + "/assets/"
}

func validateAsset(a Asset, jobID string, requireLang bool) error {
	if a.Kind != AssetKindVideo && a.Kind != AssetKindSubtitle {
		return fmt.Errorf("invalid asset kind %q", a.Kind)
	}
	if requireLang {
		if len(a.Lang) != 2 || a.Lang != strings.ToLower(a.Lang) {
			return fmt.Errorf("subtitle asset requires a lowercase ISO 639-1 lang")
		}
	} else if a.Lang != "" {
		return fmt.Errorf("video asset must not carry a lang")
	}
	if !strings.HasPrefix(a.Path, assetPathPrefix(jobID)) {
		return fmt.Errorf("asset path %q is not owned by job %s", a.Path, jobID)
	}
	rest := strings.TrimPrefix(a.Path, assetPathPrefix(jobID))
	if rest == "" || strings.Contains(a.Path, "..") || strings.Contains(a.Path, "//") ||
		strings.Contains(a.Path, "\\") || strings.Contains(a.Path, "?") || strings.Contains(a.Path, "#") {
		return fmt.Errorf("asset path %q contains forbidden segments", a.Path)
	}
	// Server-generated asset paths are simple names; the whitelist makes
	// credentials, tokens, spaces, and control characters structurally
	// impossible in any served URL.
	for _, r := range a.Path {
		if !(r == '/' || r == '_' || r == '.' || r == '-' ||
			(r >= '0' && r <= '9') || (r >= 'a' && r <= 'z')) {
			return fmt.Errorf("asset path %q contains a forbidden character %q", a.Path, string(r))
		}
	}
	if a.SizeBytes <= 0 {
		return fmt.Errorf("asset %q must declare a positive size", a.Path)
	}
	if len(a.SHA256) != 64 || !isLowerHex(a.SHA256) {
		return fmt.Errorf("asset %q sha256 must be 64 lowercase hex characters", a.Path)
	}
	return nil
}

func isLowerHex(s string) bool {
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// ValidateManifest enforces the contract's URL-ownership and completeness
// rules (contracts.md §4): version 1, owned origin-relative paths, positive
// sizes, strong validators, and an expiry after the manifest is served.
// Clients and the server both use this validation.
func ValidateManifest(m Manifest, now time.Time) error {
	if m.ManifestVersion != ManifestVersion {
		return fmt.Errorf("unsupported manifestVersion %d", m.ManifestVersion)
	}
	if m.JobID == "" {
		return fmt.Errorf("manifest jobId is required")
	}
	if m.Revision <= 0 {
		return fmt.Errorf("manifest revision must be positive")
	}
	expiresAt, err := time.Parse(time.RFC3339, m.ExpiresAt)
	if err != nil {
		return fmt.Errorf("manifest expiresAt must be RFC3339: %w", err)
	}
	if !expiresAt.After(now) {
		return fmt.Errorf("manifest expiresAt is in the past")
	}
	if err := validateAsset(m.Video, m.JobID, false); err != nil {
		return fmt.Errorf("video asset: %w", err)
	}
	if m.Video.Kind != AssetKindVideo {
		return fmt.Errorf("video field must be a video asset")
	}
	seenLang := map[string]bool{}
	for _, sub := range m.Subtitles {
		if err := validateAsset(sub, m.JobID, true); err != nil {
			return fmt.Errorf("subtitle asset: %w", err)
		}
		if seenLang[sub.Lang] {
			return fmt.Errorf("duplicate subtitle language %q", sub.Lang)
		}
		seenLang[sub.Lang] = true
	}
	return nil
}
