package introdetect

import (
	"math"
	"sort"
	"strings"
)

// Kind is the part of an episode a song marks.
type Kind string

const (
	Intro   Kind = "intro"
	Credits Kind = "credits"
)

// Profile holds the limits for one kind of show. Anime openings and endings
// are full songs (Dragon Ball Z Kai: 83 s and 59 s); an American show's
// title sequence can be a 10 s card or a 79 s sequence (Severance), and
// some episodes have none (Severance's pilot).
type Profile struct {
	HeadSeconds, TailSeconds int     // audio measured at each end
	IntroMin, IntroMax       float64 // plausible lengths, seconds
	CreditsMin, CreditsMax   float64
	// LoneMatchMin: a stretch found in only one other episode is taken
	// when at least this long (recaps and previews are cut into short
	// pieces with narration over them); shorter needs a second episode.
	LoneMatchMin float64
}

var (
	AnimeProfile = Profile{HeadSeconds: 600, TailSeconds: 300, IntroMin: 20, IntroMax: 150, CreditsMin: 20, CreditsMax: 200, LoneMatchMin: 30}
	TVProfile    = Profile{HeadSeconds: 600, TailSeconds: 300, IntroMin: 10, IntroMax: 150, CreditsMin: 15, CreditsMax: 300, LoneMatchMin: 25}
)

func (p Profile) limits(kind Kind) (minimum, maximum float64) {
	if kind == Intro {
		return p.IntroMin, p.IntroMax
	}
	return p.CreditsMin, p.CreditsMax
}

// Part is the fingerprint of one audio track over one end of a file.
type Part struct {
	Track  int     // audio track (0-based among audio streams)
	Start  float64 // seconds from the start of the file
	Points []uint32
}

// File is one episode's fingerprints.
type File struct {
	Key      string // infohash#fileIndex
	Season   int
	Episode  int
	Duration float64
	Head     []Part
	Tail     []Part
}

func (f File) parts(kind Kind) []Part {
	if kind == Intro {
		return f.Head
	}
	return f.Tail
}

// Theme is a learned song (or a creditless OP/ED from the release).
type Theme struct {
	Kind   Kind
	Points []uint32
	Source string
}

// Segment is a detected stretch of a file, in seconds.
type Segment struct {
	Start, End float64
	Method     string // "theme" or "episodes"
}

// Result is what was found in one file.
type Result struct {
	Intro, Credits *Segment
}

// maxCompared bounds the other episodes compared when learning (nearest
// episodes first).
const maxCompared = 6

// edgeSlack extends a theme match by at most this much at either end: the
// first and last moments of a song often fail to match (fades, a cut
// mid-note), but a different cut of the song must not be swallowed.
const edgeSlack = 3.0

// Detect finds the file's intro and credits: first by searching the show's
// known songs, else by the stretch it shares with other episodes (learned
// songs are returned to be kept).
func Detect(target File, others []File, themes []Theme, profile Profile) (Result, []Theme) {
	var result Result
	var learned []Theme
	for _, kind := range []Kind{Intro, Credits} {
		segment, ok := searchThemes(target.parts(kind), themes, kind, profile)
		if !ok {
			segment, ok = learnFromEpisodes(target, others, kind, profile)
			if ok {
				learned = append(learned, songOnEveryTrack(target.parts(kind), kind, segment)...)
			}
		}
		if !ok {
			continue
		}
		seg := segment
		if kind == Intro {
			result.Intro = &seg
		} else {
			result.Credits = &seg
		}
	}
	return result, learned
}

func searchThemes(parts []Part, themes []Theme, kind Kind, profile Profile) (Segment, bool) {
	minimum, maximum := profile.limits(kind)
	var best Segment
	bestScore := 0.0
	for _, theme := range themes {
		// A release's creditless file is the whole song (exact start and
		// end); a song learned from episodes is trimmed by a second or two.
		bonus := 0.0
		if strings.HasPrefix(theme.Source, "extra") {
			bonus = 10000
		}
		if theme.Kind != kind || len(theme.Points) == 0 {
			continue
		}
		themeLength := Seconds(len(theme.Points))
		need := int(math.Max(minimum, 0.5*themeLength) * PointsPerSecond)
		for _, part := range parts {
			for _, region := range Shared(theme.Points, part.Points, need) {
				aStart, bStart, length := region.Seconds()
				start := part.Start + bStart - math.Min(aStart, edgeSlack)
				end := part.Start + bStart + length + math.Min(themeLength-(aStart+length), edgeSlack)
				start = math.Max(start, part.Start)
				if end-start > maximum || length+bonus <= bestScore {
					continue
				}
				best, bestScore = Segment{Start: start, End: end, Method: "theme"}, length+bonus
			}
		}
	}
	return best, bestScore > 0
}

// candidate is one other episode's shared stretch, in target coordinates.
type candidate struct {
	other      string
	start, end float64 // seconds in the target file
}

// songOnEveryTrack keeps the song's stretch from each audio track: a dub's
// opening can be another recording than the original's (Dragon Ball Z
// Kai's early English episodes), and either may be all a later file has.
func songOnEveryTrack(parts []Part, kind Kind, segment Segment) []Theme {
	var themes []Theme
	for _, part := range parts {
		from := int(math.Round((segment.Start - part.Start) * PointsPerSecond))
		to := int(math.Round((segment.End - part.Start) * PointsPerSecond))
		if from < 0 || to > len(part.Points) || to-from < PointsPerSecond {
			continue
		}
		points := part.Points[from:to]
		valid := 0
		for _, p := range points {
			if p != Invalid {
				valid++
			}
		}
		if valid*2 < len(points) {
			continue // the track is (mostly) silent there
		}
		themes = append(themes, Theme{Kind: kind, Points: append([]uint32(nil), points...), Source: "episodes"})
	}
	return themes
}

func learnFromEpisodes(target File, others []File, kind Kind, profile Profile) (Segment, bool) {
	minimum, maximum := profile.limits(kind)
	nearest := make([]File, 0, len(others))
	for _, other := range others {
		if other.Key != target.Key {
			nearest = append(nearest, other)
		}
	}
	sort.SliceStable(nearest, func(i, j int) bool {
		return distance(target, nearest[i]) < distance(target, nearest[j])
	})
	if len(nearest) > maxCompared {
		nearest = nearest[:maxCompared]
	}
	minPoints := int(minimum * PointsPerSecond)
	var found []candidate
	for _, other := range nearest {
		var best *candidate
		for _, mine := range target.parts(kind) {
			for _, theirs := range other.parts(kind) {
				for _, region := range Shared(mine.Points, theirs.Points, minPoints) {
					aStart, _, length := region.Seconds()
					if length > maximum {
						continue
					}
					if best == nil || length > best.end-best.start {
						best = &candidate{other: other.Key, start: mine.Start + aStart, end: mine.Start + aStart + length}
					}
				}
			}
		}
		if best != nil {
			found = append(found, *best)
		}
	}
	if len(found) == 0 {
		return Segment{}, false
	}
	// Episodes agreeing on the same stretch of this file confirm it: a
	// recap or preview is shared with one neighbour only.
	sort.SliceStable(found, func(i, j int) bool { return found[i].end-found[i].start > found[j].end-found[j].start })
	var bestGroup []candidate
	for _, anchor := range found {
		var group []candidate
		for _, c := range found {
			if overlapShare(anchor.start, anchor.end, c.start, c.end) >= 0.5 {
				group = append(group, c)
			}
		}
		if len(group) > len(bestGroup) {
			bestGroup = group
		}
	}
	lead := bestGroup[0] // longest in the group (found is sorted)
	if len(bestGroup) < 2 && lead.end-lead.start < profile.LoneMatchMin {
		return Segment{}, false
	}
	return Segment{Start: lead.start, End: lead.end, Method: "episodes"}, true
}

func distance(a, b File) int {
	d := (a.Season-b.Season)*1000 + (a.Episode - b.Episode)
	if d < 0 {
		d = -d
	}
	return d
}

func overlapShare(aStart, aEnd, bStart, bEnd float64) float64 {
	overlap := math.Min(aEnd, bEnd) - math.Max(aStart, bStart)
	shorter := math.Min(aEnd-aStart, bEnd-bStart)
	if overlap <= 0 || shorter <= 0 {
		return 0
	}
	return overlap / shorter
}
