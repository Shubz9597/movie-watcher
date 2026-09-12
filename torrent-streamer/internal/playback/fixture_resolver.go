package playback

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FixtureResolver is a VALIDATION-ONLY source resolver: it serves media files
// from an explicitly configured fixture root so deterministic staging
// evidence (probe/plan/remux/transcode/HLS/VTT) can be produced without
// relying on torrent peer availability.
//
// It is ACTIVE only when the operator configures a fixture root (env
// TORWATCH_PLAYBACK_FIXTURE_ROOT). Production deployments leave it unset and
// the torrent resolver is used instead. Path safety: only regular files whose
// 40-char-hex basename (any media extension) exists DIRECTLY inside the
// configured root are resolvable; no subdirectories, no traversal.
type FixtureResolver struct {
	Root string
}

var _ Resolver = (*FixtureResolver)(nil)

var fixtureExtensions = []string{".mp4", ".mkv", ".webm", ".m4v", ".mov", ".avi"}

func (r *FixtureResolver) Resolve(_ context.Context, cat, sourceID string, fileIndex int) (ResolvedSource, error) {
	if !validCategory(cat) {
		return ResolvedSource{}, &Error{Code: "invalid_request", Message: "Unknown category."}
	}
	if err := validateSourceID(sourceID); err != nil {
		return ResolvedSource{}, err
	}
	root, err := filepath.Abs(r.Root)
	if err != nil {
		return ResolvedSource{}, &Error{Code: "internal", Message: "Fixture root is misconfigured."}
	}
	// Only direct children of the root are eligible.
	var matches []string
	for _, ext := range fixtureExtensions {
		candidate := filepath.Join(root, sourceID+ext)
		if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
			matches = append(matches, candidate)
		}
	}
	if len(matches) == 0 {
		return ResolvedSource{}, &Error{Code: ReasonMalformedSource, Message: "No fixture media exists for the requested source identifier."}
	}
	path := matches[0]
	name := filepath.Base(path)

	open := func() (io.ReadSeekCloser, error) {
		return os.Open(path)
	}
	resolved := ResolvedSource{
		Open: open,
		Name: strings.TrimSuffix(name, filepath.Ext(name)) + filepath.Ext(name),
		Size: fileSizeOf(path),
	}
	// Sidecar subtitle: <hex>.srt beside the media file (direct children only).
	// The label is human-safe copy, NEVER the fixture identifier — source
	// identifiers must not reach playlists or client-visible metadata.
	if sidecarPath, ok := existingFile(root, sourceID+".srt"); ok {
		resolved.Sidecars = append(resolved.Sidecars, Sidecar{
			Format:   "srt",
			Language: "en",
			Label:    "Subtitle (English)",
			Open: func() (io.ReadCloser, error) {
				return os.Open(sidecarPath)
			},
		})
	}
	return resolved, nil
}

func existingFile(dir, name string) (string, bool) {
	candidate := filepath.Join(dir, name)
	if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
		return candidate, true
	}
	return "", false
}

func fileSizeOf(path string) int64 {
	if info, err := os.Stat(path); err == nil {
		return info.Size()
	}
	return 0
}
