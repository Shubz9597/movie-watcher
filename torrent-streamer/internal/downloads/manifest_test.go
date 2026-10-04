package downloads

import (
	"strings"
	"testing"
	"time"
)

func validManifest() Manifest {
	return Manifest{
		ManifestVersion: 1,
		JobID:           "3f2a9a1e-1111-4222-8333-444455556666",
		Revision:        7,
		ExpiresAt:       "2026-09-30T10:00:00Z",
		Video: Asset{
			Kind:      AssetKindVideo,
			Path:      "/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/video",
			SizeBytes: 2147483648,
			SHA256:    strings.Repeat("a", 64),
		},
		Subtitles: []Asset{{
			Kind:      AssetKindSubtitle,
			Lang:      "en",
			Path:      "/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/subtitles/en",
			SizeBytes: 54321,
			SHA256:    strings.Repeat("b", 64),
		}},
	}
}

func TestValidateManifestAcceptsContractPayload(t *testing.T) {
	now := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	if err := ValidateManifest(validManifest(), now); err != nil {
		t.Fatalf("contract-shaped manifest must validate: %v", err)
	}
}

func TestValidateManifestRejectsForeignAndUnsafePaths(t *testing.T) {
	now := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	cases := map[string]func(*Manifest){
		"other job's asset path": func(m *Manifest) { m.Video.Path = "/v1/downloads/jobs/other-job/assets/video" },
		"absolute url": func(m *Manifest) {
			m.Video.Path = "http://evil.example/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/video"
		},
		"scheme-relative url": func(m *Manifest) { m.Video.Path = "//evil.example/v1/x" },
		"traversal": func(m *Manifest) {
			m.Video.Path = "/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/../video"
		},
		"query string (token)": func(m *Manifest) {
			m.Video.Path = "/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/video?token=x"
		},
		"backslash": func(m *Manifest) { m.Video.Path = `/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets\v` },
		"embedded credentials": func(m *Manifest) {
			m.Video.Path = "/v1/downloads/jobs/3f2a9a1e-1111-4222-8333-444455556666/assets/user:pass@video"
		},
		"wrong version":            func(m *Manifest) { m.ManifestVersion = 2 },
		"non-positive revision":    func(m *Manifest) { m.Revision = 0 },
		"past expiry":              func(m *Manifest) { m.ExpiresAt = "2026-09-01T00:00:00Z" },
		"bad expiry format":        func(m *Manifest) { m.ExpiresAt = "tomorrow" },
		"non-positive size":        func(m *Manifest) { m.Video.SizeBytes = 0 },
		"weak validator":           func(m *Manifest) { m.Video.SHA256 = "abc" },
		"uppercase validator":      func(m *Manifest) { m.Video.SHA256 = strings.Repeat("A", 64) },
		"subtitle without lang":    func(m *Manifest) { m.Subtitles[0].Lang = "" },
		"duplicate subtitle langs": func(m *Manifest) { m.Subtitles = append(m.Subtitles, m.Subtitles[0]) },
		"video with lang":          func(m *Manifest) { m.Video.Lang = "en" },
	}
	for name, mutate := range cases {
		m := validManifest()
		mutate(&m)
		if err := ValidateManifest(m, now); err == nil {
			t.Fatalf("%s: manifest must be rejected", name)
		}
	}
}
