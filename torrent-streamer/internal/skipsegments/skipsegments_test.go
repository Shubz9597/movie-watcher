package skipsegments

import "testing"

func TestNormalizeSegmentClampsAndBounds(t *testing.T) {
	// End missing → whole remaining file, clamped to duration.
	seg := normalizeSegment("intro", 10, float64NaN(), 90, "theintrodb")
	if seg == nil || seg.Start != 10 || seg.End != 90 {
		t.Fatalf("open-ended intro: %+v", seg)
	}
	// Too short windows are dropped (< 3s).
	if seg := normalizeSegment("intro", 10, 12, 90, "theintrodb"); seg != nil {
		t.Fatalf("short window must be dropped: %+v", seg)
	}
	// Start clamped to 0; end clamped to duration.
	if seg := normalizeSegment("intro", -5, 500, 90, "theintrodb"); seg == nil || seg.Start != 0 || seg.End != 90 {
		t.Fatalf("clamp failed: %+v", seg)
	}
}

func float64NaN() float64 { return math_NaN() }

// math_NaN avoids importing math twice in the test for clarity.
func math_NaN() float64 {
	nan := 0.0
	return nan / nan
}

func TestNormalizeTheIntroDBMapsRows(t *testing.T) {
	payload := map[string]interface{}{
		"intro": []interface{}{
			map[string]interface{}{"start_ms": 500.0, "end_ms": 35000.0},
		},
		"credits": []interface{}{
			map[string]interface{}{"start_ms": 600000.0}, // open-ended
		},
	}
	segments := normalizeTheIntroDB(payload, 700)
	if len(segments) != 2 {
		t.Fatalf("segments = %+v", segments)
	}
	if segments[0].Type != "intro" || segments[0].Start != 0.5 || segments[0].End != 35 {
		t.Fatalf("intro: %+v", segments[0])
	}
	if segments[1].Type != "credits" || segments[1].End != 700 {
		t.Fatalf("credits: %+v", segments[1])
	}
}

func TestNormalizeAniSkipOffsetsSmallRuntimeDrift(t *testing.T) {
	payload := map[string]interface{}{
		"found": true,
		"results": []interface{}{
			map[string]interface{}{
				"skipType":      "op",
				"episodeLength": 1420.0,
				"interval":      map[string]interface{}{"startTime": 10.0, "endTime": 70.0},
			},
		},
	}
	segments := normalizeAniSkip(payload, 1440)
	if len(segments) != 1 {
		t.Fatalf("segments = %+v", segments)
	}
	if segments[0].Start != 30 || segments[0].End != 90 {
		t.Fatalf("offset not applied: %+v", segments[0])
	}

	// Large runtime differences mean a mismatched file: no wholesale shift.
	payload["results"].([]interface{})[0].(map[string]interface{})["episodeLength"] = 600.0
	segments = normalizeAniSkip(payload, 1440)
	if len(segments) != 1 || segments[0].Start != 10 {
		t.Fatalf("large drift must not shift: %+v", segments)
	}
}

func TestDedupeAndSortStableOrder(t *testing.T) {
	out := dedupeAndSort([]Segment{
		{Type: "intro", Start: 10, End: 80, Provider: "a"},
		{Type: "intro", Start: 10.01, End: 80, Provider: "b"}, // same 0.25s bucket
		{Type: "recap", Start: 0, End: 30, Provider: "c"},
	})
	if len(out) != 2 {
		t.Fatalf("dedupe failed: %+v", out)
	}
	if out[0].Type != "recap" {
		t.Fatalf("sort order wrong: %+v", out)
	}
}
