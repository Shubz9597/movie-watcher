package downloads

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"torrent-streamer/internal/config"
	"torrent-streamer/internal/subsync"
	"torrent-streamer/internal/transcribe"
)

// A dual-audio release's English track is usually a dub, and the English
// subtitles online translate the original language: the same story in other
// words, timed to the same lip movements (Dragon Ball Z Kai S2E1: the
// subtitle followed the dub's timing at 0.47 and shared 15% of its words).
// The dub's own words come from its audio (internal/transcribe).

// transcriptTimeout bounds one episode's speech-to-text (about 2 minutes
// for 23 minutes on 6 cores; others wait their turn in the queue).
const transcriptTimeout = 20 * time.Minute

// minTranscriptWords: fewer words heard is not a usable subtitle.
const minTranscriptWords = 100

// TranscriptPath keeps a download's transcript, made once.
func TranscriptPath(jobID string) string {
	return filepath.Join(config.DataRoot(), "transcripts", jobID+".json")
}

// DubTranscript returns the words spoken in videoPath's English audio when
// it is a dub (the video also has audio in another language), from the
// saved transcript or by transcribing it now. ok=false when the video has
// no such audio, speech-to-text is not installed, or it failed.
func DubTranscript(ctx context.Context, jobID, videoPath, title string, subtitles []string) ([]transcribe.Word, bool) {
	if jobID != "" {
		if words, err := transcribe.Load(TranscriptPath(jobID)); err == nil && len(words) >= minTranscriptWords {
			return words, true
		}
	}
	if !transcribe.Available() {
		return nil, false
	}
	ffmpeg, ffprobe := ffTool(config.FFmpegPath(), "ffmpeg"), ffTool(config.FFprobePath(), "ffprobe")
	tracks, err := subsync.ProbeAudio(ctx, ffprobe, videoPath, nil)
	if err != nil {
		return nil, false
	}
	english, ok, dualAudio := subsync.TrackFor(tracks, "en")
	if !ok || !dualAudio {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, transcriptTimeout)
	defer cancel()
	started := time.Now()
	words, err := transcribe.Transcribe(ctx, ffmpeg, videoPath, english.Index, transcribe.Prompt(title, subtitles))
	if err != nil {
		log.Printf("[downloads] job %s: transcribing the English audio failed: %v", jobID, err)
		return nil, false
	}
	log.Printf("[downloads] job %s: transcribed the English audio: %d words in %s", jobID, len(words), time.Since(started).Round(time.Second))
	if len(words) < minTranscriptWords {
		return nil, false
	}
	if jobID != "" {
		if err := transcribe.Save(TranscriptPath(jobID), words); err != nil {
			log.Printf("[downloads] job %s: keeping the transcript failed: %v", jobID, err)
		}
	}
	return words, true
}

// dubChoice picks the English subtitle for a dub from its transcript: the
// video's own track or an online subtitle written from the same words (a
// dub's script reads better than speech-to-text), else the transcript.
func dubChoice(ctx context.Context, jobID, videoPath string, words []transcribe.Word, embedded []byte, candidates []ProviderSubtitle) subtitleChoice {
	if embedded != nil {
		if match := transcribe.WordMatch(words, string(embedded)); match >= transcribe.DubWordMatch {
			return subtitleChoice{data: embedded, ext: "vtt", own: true, why: fmt.Sprintf("the video's own track has the dub's words (%.0f%%)", match*100)}
		}
	}
	best := 0.0
	var scripts []ProviderSubtitle
	for _, candidate := range candidates {
		match := transcribe.WordMatch(words, string(candidate.Data))
		if match > best {
			best = match
		}
		if match >= transcribe.DubWordMatch {
			scripts = append(scripts, candidate)
		}
	}
	if len(scripts) > 0 {
		matchCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		if matched, err := MatchToAudio(matchCtx, videoPath, "en", dialogueSeconds, nil, scripts); err == nil {
			return subtitleChoice{data: matched.Data, ext: "vtt", why: matched.Why + fmt.Sprintf("; the dub's words (%.0f%%)", best*100)}
		}
	}
	cues := transcribe.Cues(words)
	return subtitleChoice{
		data: []byte(transcribe.WebVTT(cues, subsync.DubNote)), ext: "vtt",
		why: fmt.Sprintf("written from the English audio (%d lines; online subtitles share at most %.0f%% of its words)", len(cues), best*100),
	}
}
