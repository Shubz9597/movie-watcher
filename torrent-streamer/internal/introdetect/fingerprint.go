// Package introdetect finds a show's opening and ending in its own files.
//
// An opening or ending song is the same audio in every episode that has it,
// wherever it falls (Dragon Ball Z Kai opens after a 25-35 s scene; American
// shows after a cold open of any length). Each file's audio becomes a run of
// 32-bit fingerprints (Haitsma-Kalker style: the sign of energy changes
// across frequency bands and time), and the stretch two episodes share is
// the song. Learned songs are kept per show and found again in later
// episodes without another episode to compare with.
package introdetect

import (
	"math"
	"math/cmplx"
	"slices"
)

const (
	// SampleRate of the mono PCM fingerprints are computed from.
	SampleRate = 8000
	// PointsPerSecond is the fingerprint resolution (one point per 50 ms).
	PointsPerSecond = 20
	hop             = SampleRate / PointsPerSecond
	window          = 2048 // 256 ms: consecutive points overlap 80%
	bands           = 33   // 32 bits from 33 band-energy differences
	minHz, maxHz    = 150.0, 3800.0
	// Frames quieter than silenceShare of the file's typical (median) level,
	// or than silenceFloor, are too quiet to identify; they never match
	// (silence in two files is not a shared song). Relative, because a TV
	// 5.1 mix folded to mono runs far quieter than anime stereo (Severance:
	// RMS ~600 against Dragon Ball Z Kai's ~1300).
	silenceShare = 0.1
	silenceFloor = 20.0
)

// Invalid is the point value of a silent (unidentifiable) frame.
const Invalid uint32 = 0

var (
	hann       [window]float64
	bandEdges  [bands + 1]int
	twiddles   []complex128
	bitReverse []int
)

func init() {
	for i := range hann {
		hann[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(window-1))
	}
	binHz := float64(SampleRate) / window
	for b := 0; b <= bands; b++ {
		hz := minHz * math.Pow(maxHz/minHz, float64(b)/bands)
		bandEdges[b] = int(math.Round(hz / binHz))
	}
	twiddles = make([]complex128, window/2)
	for k := range twiddles {
		twiddles[k] = cmplx.Exp(complex(0, -2*math.Pi*float64(k)/window))
	}
	bits := 0
	for 1<<bits < window {
		bits++
	}
	bitReverse = make([]int, window)
	for i := range bitReverse {
		r := 0
		for b := 0; b < bits; b++ {
			if i&(1<<b) != 0 {
				r |= 1 << (bits - 1 - b)
			}
		}
		bitReverse[i] = r
	}
}

// Fingerprint turns mono 16-bit PCM at SampleRate into one point per
// 1/PointsPerSecond second; silent frames are Invalid.
func Fingerprint(samples []int16) []uint32 {
	if len(samples) < window {
		return nil
	}
	frames := (len(samples)-window)/hop + 1
	points := make([]uint32, frames)
	levels := make([]float64, frames)
	for f := range levels {
		var sumSquares float64
		for _, v := range samples[f*hop : f*hop+window] {
			sumSquares += float64(v) * float64(v)
		}
		levels[f] = math.Sqrt(sumSquares / window)
	}
	sorted := slices.Clone(levels)
	slices.Sort(sorted)
	silence := math.Max(silenceFloor, silenceShare*sorted[len(sorted)/2])
	buf := make([]complex128, window)
	var previous [bands]float64
	havePrevious := false
	for f := 0; f < frames; f++ {
		if levels[f] < silence {
			points[f] = Invalid
			havePrevious = false
			continue
		}
		start := f * hop
		for i := 0; i < window; i++ {
			buf[bitReverse[i]] = complex(float64(samples[start+i])*hann[i], 0)
		}
		fft(buf)
		var energy [bands]float64
		for b := 0; b < bands; b++ {
			for k := bandEdges[b]; k < bandEdges[b+1] && k < window/2; k++ {
				re, im := real(buf[k]), imag(buf[k])
				energy[b] += re*re + im*im
			}
		}
		if havePrevious {
			var point uint32
			for b := 0; b < bands-1; b++ {
				if (energy[b]-energy[b+1])-(previous[b]-previous[b+1]) > 0 {
					point |= 1 << b
				}
			}
			if point == Invalid {
				point = 1
			}
			points[f] = point
		}
		previous, havePrevious = energy, true
	}
	return points
}

// fft is an in-place radix-2 FFT of a bit-reversed window.
func fft(buf []complex128) {
	n := len(buf)
	for size := 2; size <= n; size <<= 1 {
		half, step := size/2, n/size
		for start := 0; start < n; start += size {
			for k := 0; k < half; k++ {
				t := twiddles[k*step] * buf[start+k+half]
				buf[start+k+half] = buf[start+k] - t
				buf[start+k] += t
			}
		}
	}
}

// Seconds converts a point index or count to seconds.
func Seconds(points int) float64 { return float64(points) / PointsPerSecond }
