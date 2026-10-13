package introdetect

import (
	"math"
	"math/bits"
	"sort"
)

const (
	// maxBitErrors: points of the same audio from two files differ in a few
	// bits; unrelated audio agrees this closely about 2.5% of the time.
	maxBitErrors = 10
	// A shared stretch keeps at least this share of matching points in
	// every second (tolerates a dropped frame or a bar of different sound).
	minDensity   = 0.5
	densityWidth = PointsPerSecond
)

// Region is audio two fingerprints share: points [AStart, AStart+Length) of
// a equal [BStart, BStart+Length) of b.
type Region struct {
	AStart, BStart, Length int
}

// Seconds of the region's start in a and b, and its length.
func (r Region) Seconds() (aStart, bStart, length float64) {
	return Seconds(r.AStart), Seconds(r.BStart), Seconds(r.Length)
}

func matches(x, y uint32) bool {
	return x != Invalid && y != Invalid && bits.OnesCount32(x^y) <= maxBitErrors
}

// Shared returns the stretches of at least minPoints that a and b share, at
// any offset, longest first. Overlapping finds of the same audio at nearby
// offsets are merged into the longest.
func Shared(a, b []uint32, minPoints int) []Region {
	if minPoints < densityWidth {
		minPoints = densityWidth
	}
	var found []Region
	hit := make([]bool, 0, max(len(a), len(b)))
	for offset := -(len(b) - minPoints); offset <= len(a)-minPoints; offset++ {
		// a[i] lines up with b[i-offset].
		from := max(0, offset)
		to := min(len(a), len(b)+offset)
		if to-from < minPoints {
			continue
		}
		hit = hit[:0]
		for i := from; i < to; i++ {
			hit = append(hit, matches(a[i], b[i-offset]))
		}
		for _, run := range denseRuns(hit, minPoints) {
			found = append(found, Region{AStart: from + run[0], BStart: from + run[0] - offset, Length: run[1] - run[0]})
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Length > found[j].Length })
	var kept []Region
	for _, region := range found {
		overlapsKept := false
		for _, k := range kept {
			if overlaps(region.AStart, region.Length, k.AStart, k.Length) || overlaps(region.BStart, region.Length, k.BStart, k.Length) {
				overlapsKept = true
				break
			}
		}
		if !overlapsKept {
			kept = append(kept, region)
		}
	}
	return kept
}

func overlaps(aStart, aLen, bStart, bLen int) bool {
	return aStart < bStart+bLen && bStart < aStart+aLen
}

// denseRuns returns [start, end) runs of hit where every densityWidth-long
// window keeps minDensity matches, trimmed to matching ends, at least
// minPoints long.
func denseRuns(hit []bool, minPoints int) [][2]int {
	n := len(hit)
	if n < densityWidth {
		return nil
	}
	prefix := make([]int, n+1)
	for i, h := range hit {
		prefix[i+1] = prefix[i]
		if h {
			prefix[i+1]++
		}
	}
	need := int(math.Ceil(densityWidth * minDensity))
	var runs [][2]int
	start := -1
	for w := 0; w+densityWidth <= n; w++ {
		dense := prefix[w+densityWidth]-prefix[w] >= need
		if dense && start < 0 {
			start = w
		}
		if !dense && start >= 0 {
			runs = appendRun(runs, hit, start, w+densityWidth-1, minPoints)
			start = -1
		}
	}
	if start >= 0 {
		runs = appendRun(runs, hit, start, n, minPoints)
	}
	return runs
}

func appendRun(runs [][2]int, hit []bool, start, end, minPoints int) [][2]int {
	for start < end && !hit[start] {
		start++
	}
	for end > start && !hit[end-1] {
		end--
	}
	if end-start >= minPoints {
		runs = append(runs, [2]int{start, end})
	}
	return runs
}
