package introdetect

import (
	"math"
	"math/rand/v2"
	"os"
	"testing"
)

// Fingerprints recorded from real files (no audio): the AnimeRG Dragon Ball
// Z Kai pack (episodes 6, 15, 16: first 3 minutes, Japanese and English
// tracks; minutes 3-5 of the last five; the creditless OP1) and the d3g
// Severance S1E1-E3 Blu-ray releases (first 7.5 minutes). Truth: DBZ
// openings at 0:35 (ep 6) and 0:25 (eps 15, 16), 87 s long, by the OP1
// file; endings at 21:31 (AniSkip 1290-1291 s); Severance's pilot has no
// title sequence, episodes 2 and 3 have it at 5:30 and 2:14 (the dialogue
// gap in the subtitles: 327-409 s in episode 2).
func fixture(t *testing.T, name string) []uint32 {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name + ".fp")
	if err != nil {
		t.Fatal(err)
	}
	points, err := DecodePoints(data)
	if err != nil {
		t.Fatal(err)
	}
	return points
}

const dbzTailStart = 1082.0 + 180 // the stored tails start 3 minutes into the last 5

func dbzEpisodes(t *testing.T) []File {
	tail := func(name string) []Part { return []Part{{Track: 0, Start: dbzTailStart, Points: fixture(t, name)}} }
	return []File{
		{Key: "ep06", Season: 1, Episode: 6, Head: []Part{{Track: 1, Points: fixture(t, "dbz_ep06_head_ja")}}, Tail: tail("dbz_ep06_tail")},
		{Key: "ep15", Season: 1, Episode: 15, Head: []Part{{Track: 0, Points: fixture(t, "dbz_ep15_head")}, {Track: 1, Points: fixture(t, "dbz_ep15_head_ja")}}, Tail: tail("dbz_ep15_tail")},
		{Key: "ep16", Season: 1, Episode: 16, Head: []Part{{Track: 0, Points: fixture(t, "dbz_ep16_head")}}, Tail: tail("dbz_ep16_tail")},
	}
}

func near(t *testing.T, label string, segment *Segment, start, end, tolerance float64) {
	t.Helper()
	if segment == nil {
		t.Fatalf("%s: nothing found, want %.1f-%.1f", label, start, end)
	}
	if math.Abs(segment.Start-start) > tolerance || math.Abs(segment.End-end) > tolerance {
		t.Fatalf("%s: %.1f-%.1f, want %.1f-%.1f (±%.1f)", label, segment.Start, segment.End, start, end, tolerance)
	}
}

func TestAnimeOpeningsAndEndingsFromEpisodes(t *testing.T) {
	episodes := dbzEpisodes(t)
	want := map[string][2]float64{"ep06": {36.4, 119.7}, "ep15": {26.3, 109.7}, "ep16": {26.4, 109.7}}
	for _, target := range episodes {
		result, learned := Detect(target, episodes, nil, AnimeProfile)
		near(t, target.Key+" intro", result.Intro, want[target.Key][0], want[target.Key][1], 1.5)
		near(t, target.Key+" credits", result.Credits, 1291.2, 1350.2, 1.5)
		kinds := map[Kind]bool{}
		for _, theme := range learned {
			kinds[theme.Kind] = true
		}
		if !kinds[Intro] || !kinds[Credits] {
			t.Fatalf("%s learned %d songs without both opening and ending", target.Key, len(learned))
		}
	}
}

func TestCreditlessOpeningGivesExactTimes(t *testing.T) {
	op1 := []Theme{{Kind: Intro, Points: fixture(t, "dbz_op1_ja"), Source: "extra"}}
	episodes := dbzEpisodes(t)
	// Episode 16 carries only the English track here; its English opening
	// matches through the learned song (next test), not the Japanese OP1.
	for _, target := range episodes[:2] {
		result, _ := Detect(target, nil, op1, AnimeProfile)
		start := map[string]float64{"ep06": 35.0, "ep15": 25.0}[target.Key]
		near(t, target.Key+" intro", result.Intro, start, start+87.0, 0.6)
		if result.Intro.Method != "theme" || result.Credits != nil {
			t.Fatalf("%s: %+v", target.Key, result)
		}
	}
}

func TestLearnedSongFindsLaterEpisodesAlone(t *testing.T) {
	episodes := dbzEpisodes(t)
	_, learned := Detect(episodes[1], episodes[:2], nil, AnimeProfile) // ep 15 with ep 6
	result, more := Detect(episodes[2], nil, learned, AnimeProfile)     // ep 16, nothing else
	near(t, "ep16 intro", result.Intro, 26.4, 109.7, 3.5)
	near(t, "ep16 credits", result.Credits, 1291.2, 1350.2, 3.5)
	if len(more) != 0 {
		t.Fatalf("known songs relearned: %d", len(more))
	}
}

func TestAmericanShowIntroIsOptional(t *testing.T) {
	episodes := []File{
		{Key: "e1", Season: 1, Episode: 1, Head: []Part{{Points: fixture(t, "sev_e1_head")}}},
		{Key: "e2", Season: 1, Episode: 2, Head: []Part{{Points: fixture(t, "sev_e2_head")}}},
		{Key: "e3", Season: 1, Episode: 3, Head: []Part{{Points: fixture(t, "sev_e3_head")}}},
	}
	if result, _ := Detect(episodes[0], episodes, nil, TVProfile); result.Intro != nil {
		t.Fatalf("the pilot has no title sequence, found %+v", *result.Intro)
	}
	result, _ := Detect(episodes[1], episodes, nil, TVProfile)
	near(t, "e2 intro", result.Intro, 329.8, 408.9, 1.5)
	result, _ = Detect(episodes[2], episodes, nil, TVProfile)
	near(t, "e3 intro", result.Intro, 134.3, 213.4, 1.5)
}

// A stretch shared with one neighbour only is taken when long (a full
// song), not when short (recap and preview pieces).
func TestShortStretchNeedsASecondEpisode(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	noise := func(n int) []uint32 {
		out := make([]uint32, n)
		for i := range out {
			out[i] = r.Uint32() | 1
		}
		return out
	}
	shared := noise(15 * PointsPerSecond) // 15 s: a recap piece
	a := append(append(noise(60*PointsPerSecond), shared...), noise(60*PointsPerSecond)...)
	b := append(append(noise(30*PointsPerSecond), shared...), noise(90*PointsPerSecond)...)
	files := []File{{Key: "a", Episode: 1, Head: []Part{{Points: a}}}, {Key: "b", Episode: 2, Head: []Part{{Points: b}}}}
	if result, _ := Detect(files[0], files, nil, TVProfile); result.Intro != nil {
		t.Fatalf("15 s shared with one episode taken as the intro: %+v", *result.Intro)
	}
	c := append(append(noise(45*PointsPerSecond), shared...), noise(75*PointsPerSecond)...)
	files = append(files, File{Key: "c", Episode: 3, Head: []Part{{Points: c}}})
	result, _ := Detect(files[0], files, nil, TVProfile)
	near(t, "confirmed by two episodes", result.Intro, 60, 75, 0.6)
}

func TestMoviesAreNotDetected(t *testing.T) {
	if _, ok := ProfileFor("movie"); ok {
		t.Fatal("movies have no recurring opening")
	}
	if ShowKindFor("tmdb:movie:27205", "movie") != "movie" || ShowKindFor("anilist:6033", "anime") != "anime" || ShowKindFor("tmdb:tv:95396", "tv") != "tv" {
		t.Fatal("show kinds")
	}
}

func TestPartsRoundTrip(t *testing.T) {
	head := []Part{{Track: 0, Start: 0, Points: []uint32{1, 2, 3}}, {Track: 1, Start: 0, Points: []uint32{4}}}
	tail := []Part{{Track: 0, Start: 1262.5, Points: []uint32{5, 6}}}
	gotHead, gotTail, err := DecodeParts(EncodeParts(head, tail))
	if err != nil || len(gotHead) != 2 || len(gotTail) != 1 || gotTail[0].Start != 1262.5 || gotHead[1].Track != 1 || gotTail[0].Points[1] != 6 {
		t.Fatalf("round trip: %+v %+v %v", gotHead, gotTail, err)
	}
}

func TestSilenceNeverMatches(t *testing.T) {
	silent := make([]int16, SampleRate*30)
	points := Fingerprint(silent)
	if len(Shared(points, points, 5*PointsPerSecond)) != 0 {
		t.Fatal("silence matched silence")
	}
}
