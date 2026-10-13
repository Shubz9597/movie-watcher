package downloads

import (
	"context"
	"errors"
	"log"
	"strconv"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/subsync"
)

// SubtitleCandidates is implemented by sources that can return several
// ranked subtitles, so the one that fits the video's own audio is chosen
// rather than the first by release name.
type SubtitleCandidates interface {
	FetchSubtitleCandidates(ctx context.Context, q SubtitleQuery, limit int) ([]ProviderSubtitle, error)
}

// ProviderSubtitle is one subtitle a provider offered (WebVTT or SRT text).
type ProviderSubtitle struct {
	Name string
	Data []byte
	Ext  string
}

// subtitleCandidateLimit bounds the subtitles fetched per language: each is
// a small text file, scored against the audio in milliseconds.
const subtitleCandidateLimit = 6

// dialogueSeconds bounds how much audio is measured: a release offset is
// the same throughout, and 30 minutes holds hundreds of lines.
const dialogueSeconds = 30 * 60

// subtitleChoice is the sidecar packaged for one language.
type subtitleChoice struct {
	data []byte
	ext  string
	why  string // for the log
}

// ErrNoMatch reports that no subtitle follows the video's audio in the
// language better than its own track (or the video has no such audio).
var ErrNoMatch = errors.New("no subtitle matches this audio")

// Matched is a provider subtitle moved onto a video's dialogue.
type Matched struct {
	Data   []byte // WebVTT
	Dub    bool   // the video also has audio in another language
	Offset float64
	Fit    float64
	Why    string
}

// MatchToAudio returns the provider subtitle that follows the lang audio's
// dialogue of input (a file path or URL; at most seconds of it are
// measured) clearly better than ownTrack (the video's own lang subtitle, nil
// when it has none), moved onto that dialogue. Online subtitles are often
// timed for another release (Dragon Ball Z Kai's dub captions ran 4 s late),
// and a dual-audio release's own track usually translates the original
// language rather than following its dub; a well-timed own track is never
// replaced (a candidate must fit twice as well).
func MatchToAudio(ctx context.Context, input, lang string, seconds int, ownTrack []byte, candidates []ProviderSubtitle) (Matched, error) {
	if len(candidates) == 0 {
		return Matched{}, ErrNoMatch
	}
	ffmpeg, ffprobe := ffTool(config.FFmpegPath(), "ffmpeg"), ffTool(config.FFprobePath(), "ffprobe")
	tracks, err := subsync.ProbeAudio(ctx, ffprobe, input, nil)
	if err != nil {
		return Matched{}, err
	}
	langAudio, ok, dualAudio := subsync.TrackFor(tracks, lang)
	if !ok {
		return Matched{}, ErrNoMatch
	}
	env, err := subsync.MeasureDialogue(ctx, ffmpeg, input, nil, langAudio, seconds)
	if err != nil {
		return Matched{}, err
	}
	baseline := 0.0
	if ownTrack != nil {
		baseline = subsync.Align(env, subsync.ParseCues(string(ownTrack)), subsync.MaxShift).R
	}
	texts := make([]subsync.Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		texts = append(texts, subsync.Candidate{Name: candidate.Name, Text: string(candidate.Data)})
	}
	best, ok := subsync.PickDub(subsync.Judge(env, texts), baseline)
	if !ok {
		return Matched{}, ErrNoMatch
	}
	note := ""
	if dualAudio {
		note = subsync.DubNote
	}
	return Matched{
		Data: []byte(subsync.Shift(best.Text, best.Offset(), note)), Dub: dualAudio,
		Offset: best.Offset(), Fit: best.R,
		Why: describeFit("follows the "+lang+" audio", best, baseline),
	}, nil
}

// chooseSubtitle picks a requested language's sidecar once the video is
// staged: a provider subtitle that follows the video's lang audio clearly
// better than its own track (MatchToAudio), else the video's own track,
// else the provider subtitle that best fits the main audio, moved onto it.
// It returns ok=false when neither the video nor a provider has one.
func chooseSubtitle(ctx context.Context, jobID, videoPath, lang string, embedded []byte, candidates []ProviderSubtitle) (subtitleChoice, bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if len(candidates) > 0 {
		matched, err := MatchToAudio(ctx, videoPath, lang, dialogueSeconds, embedded, candidates)
		if err == nil {
			return subtitleChoice{data: matched.Data, ext: "vtt", why: matched.Why}, true
		}
		if !errors.Is(err, ErrNoMatch) {
			log.Printf("[downloads] job %s: %s subtitle not matched to the audio: %v", jobID, lang, err)
		}
	}
	if embedded != nil {
		return subtitleChoice{data: embedded, ext: "vtt", why: "the video's own track"}, true
	}
	if len(candidates) == 0 {
		return subtitleChoice{}, false
	}
	// Provider subtitles only and no audio tagged lang: sync the best fit
	// against the main audio.
	ffmpeg, ffprobe := ffTool(config.FFmpegPath(), "ffmpeg"), ffTool(config.FFprobePath(), "ffprobe")
	if tracks, err := subsync.ProbeAudio(ctx, ffprobe, videoPath, nil); err == nil && len(tracks) > 0 {
		if env, err := subsync.MeasureDialogue(ctx, ffmpeg, videoPath, nil, tracks[0], dialogueSeconds); err == nil {
			texts := make([]subsync.Candidate, 0, len(candidates))
			for _, candidate := range candidates {
				texts = append(texts, subsync.Candidate{Name: candidate.Name, Text: string(candidate.Data)})
			}
			if judged := subsync.Judge(env, texts); len(judged) > 0 && judged[0].R >= subsync.SyncMinR {
				best := judged[0]
				return subtitleChoice{
					data: []byte(subsync.Shift(best.Text, best.Offset(), "")), ext: "vtt",
					why: describeFit("best fit to the main audio", best, 0),
				}, true
			}
		}
	}
	return fallbackSubtitle(nil, candidates)
}

// fallbackSubtitle is the choice without audio: the video's own track, else
// the provider's first by release name.
func fallbackSubtitle(embedded []byte, candidates []ProviderSubtitle) (subtitleChoice, bool) {
	if embedded != nil {
		return subtitleChoice{data: embedded, ext: "vtt", why: "the video's own track"}, true
	}
	if len(candidates) > 0 {
		return subtitleChoice{data: candidates[0].Data, ext: candidates[0].Ext, why: "provider's first match (not synced)"}, true
	}
	return subtitleChoice{}, false
}

func describeFit(what string, best subsync.Judged, baseline float64) string {
	return what + ": " + best.Name +
		" (fit " + formatFloat(best.R) + ", own track " + formatFloat(baseline) +
		", moved " + formatFloat(best.Offset()) + " s)"
}

func formatFloat(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }
