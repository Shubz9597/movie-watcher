package torrentx

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"torrent-streamer/internal/scoring"
	"torrent-streamer/pkg/types"
)

var ErrNoCandidate = errors.New("no acceptable candidate")

type EnsureInput struct {
	SeriesID, SeriesTitle, Kind string
	Season, Episode             int
	AbsEpisode                  *int
	ProfileHash                 string
	ProfileCaps                 scoring.ProfileCaps
	EstRuntimeMin               float64
	Prior                       *types.Pick // optional: to favor same release group
}

type EnsureDeps struct {
	Repo   *Repo
	Search interface {
		Query(title string, season, episode int, abs *int) ([]types.Candidate, error)
	}
}

func EnsurePick(ctx context.Context, d EnsureDeps, in EnsureInput) (PickRow, error) {
	if p, ok, err := d.Repo.GetPick(ctx, in.SeriesID, in.Season, in.Episode, in.ProfileHash); err != nil {
		return PickRow{}, err
	} else if ok {
		return p, nil
	}

	key := searchKey(in.SeriesID, in.Season, in.Episode, in.ProfileHash)
	var cands []types.Candidate
	if cached, ok, _ := d.Repo.GetSearchCache(ctx, key); ok && len(cached) > 0 {
		cands = cached
	} else {
		found, err := d.Search.Query(in.SeriesTitle, in.Season, in.Episode, in.AbsEpisode)
		if err != nil {
			return PickRow{}, err
		}
		_ = d.Repo.PutSearchCache(ctx, key, found)
		cands = found
	}

	var best types.Candidate
	var bestSB types.ScoreBreakdown
	has := false
	for _, c := range cands {
		sb := scoring.Score(c, in.ProfileCaps, in.EstRuntimeMin, in.Prior, scoring.DefaultParams)
		if sb.Total < 0 {
			continue
		}
		if !has || sb.Total > bestSB.Total {
			best, bestSB, has = c, sb, true
		}
	}
	if !has {
		return PickRow{}, ErrNoCandidate
	}

	sbJSON, _ := json.Marshal(bestSB)
	row := PickRow{
		SeriesID: in.SeriesID, Season: in.Season, Episode: in.Episode,
		ProfileHash: in.ProfileHash,
		InfoHash:    best.InfoHash, Magnet: best.Magnet,
		ReleaseGroup: nz(best.ReleaseGroup),
		Resolution:   best.Resolution, Codec: best.Codec,
		FileIndex: best.FileIndex, SourceKind: best.SourceKind,
		SizeBytes: &best.SizeBytes, ScoreJSON: sbJSON, PickedAt: time.Now(),
	}
	id, err := d.Repo.InsertPick(ctx, row)
	if err != nil {
		return PickRow{}, err
	}
	row.ID = id
	return row, nil
}

func nz(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
