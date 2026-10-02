package downloads

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCopyExactDoesNotCrossTorrentFileBoundary(t *testing.T) {
	video := []byte("selected video bytes")
	trailing := []byte("adjacent torrent file bytes")
	var dest bytes.Buffer

	size, hash, err := copyExact(
		context.Background(),
		&dest,
		bytes.NewReader(append(append([]byte{}, video...), trailing...)),
		int64(len(video)),
		"video.mp4",
	)
	if err != nil {
		t.Fatalf("copyExact: %v", err)
	}
	if size != int64(len(video)) {
		t.Fatalf("copied %d bytes, want %d", size, len(video))
	}
	if !bytes.Equal(dest.Bytes(), video) {
		t.Fatalf("copied bytes crossed the selected file boundary: %q", dest.Bytes())
	}
	wantHash := sha256.Sum256(video)
	if hash != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("hash = %s, want %s", hash, hex.EncodeToString(wantHash[:]))
	}
}

func TestCopyExactRejectsTruncatedSource(t *testing.T) {
	var dest bytes.Buffer
	_, _, err := copyExact(context.Background(), &dest, strings.NewReader("short"), 10, "video.mp4")
	if err == nil || !strings.Contains(err.Error(), "incomplete copy") {
		t.Fatalf("expected incomplete-copy error, got %v", err)
	}
}

func TestBuildManifestShapesTheReadyPackage(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	jobID := "3f2a9a1e-1111-4222-8333-444455556666"
	assets := []AssetRow{
		{Kind: AssetKindVideo, URLPath: "/v1/downloads/jobs/" + jobID + "/assets/video",
			DiskPath: "ready/" + jobID + "/video.mkv", SizeBytes: 2147483648, SHA256: strings.Repeat("a", 64)},
		{Kind: AssetKindSubtitle, Lang: "en", URLPath: "/v1/downloads/jobs/" + jobID + "/assets/subtitles/en",
			DiskPath: "ready/" + jobID + "/subtitles.en.srt", SizeBytes: 54321, SHA256: strings.Repeat("b", 64)},
	}
	m := buildManifest(jobID, assets, now)
	if m.Video.Path != assets[0].URLPath || m.Video.SHA256 != assets[0].SHA256 {
		t.Fatalf("video asset mismatch: %+v", m.Video)
	}
	if len(m.Subtitles) != 1 || m.Subtitles[0].Lang != "en" {
		t.Fatalf("subtitle assets mismatch: %+v", m.Subtitles)
	}
	// The manifest must validate under its own contract.
	if err := ValidateManifest(m, now); err != nil {
		t.Fatalf("built manifest must validate: %v", err)
	}
	if exp, _ := time.Parse(time.RFC3339, m.ExpiresAt); !exp.Equal(now.Add(DefaultRetention)) {
		t.Fatalf("expiry must start the retention clock, got %s", m.ExpiresAt)
	}
}

func TestIsSafeExt(t *testing.T) {
	for _, ok := range []string{".mkv", ".mp4", ".srt", ".ass", ".vtt"} {
		if !isSafeExt(ok) {
			t.Fatalf("%s must be a safe extension", ok)
		}
	}
	for _, bad := range []string{"", ".", "..", ".exe ", ".M KV", ".x1y2z3w4v9u8", ".<script>"} {
		if isSafeExt(bad) {
			t.Fatalf("%q must be rejected", bad)
		}
	}
}

func TestRelativeDownloadPathContainment(t *testing.T) {
	if !isRelativeDownloadPath("ready/job-1/video.mkv") {
		t.Fatalf("a plain relative path is legal")
	}
	for _, bad := range []string{
		"/etc/passwd", `C:\Windows\system32\evil`, `ready\job\file`, "../escape",
		"ready/../staging/x", "",
	} {
		if isRelativeDownloadPath(bad) {
			t.Fatalf("%q must be rejected", bad)
		}
	}
}

func TestJobDirsCannotEscapeTheRoot(t *testing.T) {
	p := NewPrepper(nil, nil, `/data/downloads`, 1)
	// A hostile job id (URL fragment, traversal) must collapse under Base.
	evil := "../../somewhere/else"
	if want := filepath.Join(`/data/downloads`, "ready", "else"); p.readyDir(evil) != want {
		t.Fatalf("readyDir must be contained: %s", p.readyDir(evil))
	}
	if got := p.stagingDir(evil); strings.Contains(got, "..") {
		t.Fatalf("stagingDir must be contained: %s", got)
	}
}
