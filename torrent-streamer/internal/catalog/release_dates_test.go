package catalog

import (
	"encoding/json"
	"testing"
)

func TestTMDbDigitalReleaseIsTheEarliestType4(t *testing.T) {
	var payload tmdbDetailResponse
	raw := `{"release_dates":{"results":[
		{"iso_3166_1":"US","release_dates":[{"release_date":"2026-12-18T00:00:00.000Z","type":3},{"release_date":"2027-03-10T00:00:00.000Z","type":4}]},
		{"iso_3166_1":"GB","release_dates":[{"release_date":"2027-02-28T00:00:00.000Z","type":4},{"release_date":"2027-04-01T00:00:00.000Z","type":5}]}
	]}}`
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	if got := tmdbDigitalRelease(payload); got != "2027-02-28" {
		t.Fatalf("digital release = %q, want 2027-02-28", got)
	}
	if got := tmdbDigitalRelease(tmdbDetailResponse{}); got != "" {
		t.Fatalf("no release dates = %q, want empty", got)
	}
}

func TestISODate(t *testing.T) {
	for in, want := range map[string]string{"2026-12-18": "2026-12-18", "2026-12-18T00:00:00.000Z": "2026-12-18", "2026": "", "": "", "Dec 2026!!": ""} {
		if got := isoDate(in); got != want {
			t.Errorf("isoDate(%q) = %q, want %q", in, got, want)
		}
	}
}
