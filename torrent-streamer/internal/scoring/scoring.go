package scoring

import (
	"math"
	"strings"

	"torrent-streamer/pkg/types"
)

type ProfileCaps struct {
	PreferHDR  bool
	MaxBitrate int64           // bits per second budget (optional)
	AllowHi10P bool            // avoid hi10p on most TVs
	CodecAllow map[string]bool // e.g. {"h264":true,"hevc":true,"av1":false}
}

type Params struct {
	WHealth, WQuality, WSize, WConsistency float64
}

var DefaultParams = Params{WHealth: 0.45, WQuality: 0.35, WSize: 0.15, WConsistency: 0.05}

func HardReject(c types.Candidate, caps ProfileCaps) (string, bool) {
	// reject CAM/TS/TC, weird codecs, unsupported codec
	title := strings.ToLower(c.Title)
	if strings.Contains(title, "cam ") || strings.Contains(title, "hdcam") || strings.Contains(title, "ts ") || strings.Contains(title, "telesync") || strings.Contains(title, "telecine") {
		return "bad_source", true
	}
	if !caps.CodecAllow[strings.ToLower(c.Codec)] {
		return "unsupported_codec", true
	}
	if strings.ToLower(c.Codec) == "hi10p" && !caps.AllowHi10P {
		return "hi10p_tv_unfriendly", true
	}
	// absurdly large or tiny sizes (MB/min sanity)
	// leave size sanity to soft score; we only hard reject extremes if SizeBytes known
	return "", false
}

func logNormSeeders(s int) float64 {
	if s <= 0 {
		return 0
	}
	// log scale 0..1 (log1p base e / normalize by 10)
	v := math.Log1p(float64(s)) / math.Log1p(1000.0)
	if v > 1 {
		v = 1
	}
	return v
}

func qualityFit(c types.Candidate, caps ProfileCaps) float64 {
	// simple ladder: WEB-DL > WEBRip > HDTV > BluRay remux? (you can tweak)
	src := map[string]float64{"web-dl": 1.0, "webrip": 0.85, "hdtv": 0.7, "bluray": 0.9}
	base := src[strings.ToLower(c.Source)]
	if base == 0 {
		base = 0.7
	}

	// resolution weight
	res := map[string]float64{"2160p": 1.0, "1080p": 0.95, "720p": 0.8, "480p": 0.5}
	rw := res[strings.ToLower(c.Resolution)]
	if rw == 0 {
		rw = 0.6
	}

	// codec preference (device-aware), prefer hevc for lower bitrate if allowed
	codec := strings.ToLower(c.Codec)
	cw := 0.8
	switch codec {
	case "av1":
		cw = 1.0
	case "hevc", "x265":
		cw = 0.95
	case "h264", "x264":
		cw = 0.85
	case "hi10p":
		cw = 0.6
	default:
		cw = 0.7
	}
	if !caps.CodecAllow[codec] {
		cw = 0.0
	}

	return 0.5*base + 0.3*rw + 0.2*cw
}

func sizeSanity(c types.Candidate, estRuntimeMin float64, caps ProfileCaps) float64 {
	// MB/min sanity within device bandwidth budget; if no size, neutral 0.5
	if c.SizeBytes <= 0 || estRuntimeMin <= 0 {
		return 0.5
	}
	mb := float64(c.SizeBytes) / (1024 * 1024)
	mbpm := mb / estRuntimeMin
	// simple bands (tune later)
	switch {
	case mbpm < 3:
		return 0.4
	case mbpm < 8:
		return 0.8
	case mbpm < 14:
		return 1.0
	case mbpm < 20:
		return 0.7
	default:
		return 0.4
	}
}

func consistency(c types.Candidate, prior *types.Pick) float64 {
	if prior == nil || prior.ReleaseGroup == nil {
		return 0.5
	}
	if strings.EqualFold(c.ReleaseGroup, *prior.ReleaseGroup) {
		return 1.0
	}
	return 0.5
}

func Score(c types.Candidate, caps ProfileCaps, estRuntimeMin float64, prior *types.Pick, p Params) types.ScoreBreakdown {
	if why, reject := HardReject(c, caps); reject {
		return types.ScoreBreakdown{HardReject: why, Total: -1}
	}
	sb := types.ScoreBreakdown{}
	sb.Health = logNormSeeders(c.Seeders)
	sb.Quality = qualityFit(c, caps)
	sb.Size = sizeSanity(c, estRuntimeMin, caps)
	sb.Consistency = consistency(c, prior)
	sb.Total = p.WHealth*sb.Health + p.WQuality*sb.Quality + p.WSize*sb.Size + p.WConsistency*sb.Consistency
	return sb
}
