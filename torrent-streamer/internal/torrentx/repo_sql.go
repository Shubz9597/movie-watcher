package torrentx

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"time"

	"torrent-streamer/pkg/types"
)

type Repo struct{ DB *sql.DB }

type PickRow struct {
	ID           int64     `json:"id"`
	SeriesID     string    `json:"seriesId"`
	Season       int       `json:"season"`
	Episode      int       `json:"episode"`
	ProfileHash  string    `json:"profileHash"`
	InfoHash     string    `json:"infoHash"`
	Magnet       string    `json:"magnet"`
	ReleaseGroup *string   `json:"releaseGroup,omitempty"`
	Resolution   string    `json:"resolution"`
	Codec        string    `json:"codec"`
	FileIndex    *int      `json:"fileIndex,omitempty"`
	SourceKind   string    `json:"sourceKind"`
	SizeBytes    *int64    `json:"sizeBytes,omitempty"`
	ScoreJSON    []byte    `json:"-"`
	PickedAt     time.Time `json:"pickedAt"`
	ReplacesPick *int64    `json:"replacesPickId,omitempty"`
}

func (r *Repo) GetPick(ctx context.Context, seriesID string, season, episode int, profileHash string) (PickRow, bool, error) {
	var p PickRow
	err := r.DB.QueryRowContext(ctx, `
SELECT id, series_id, season, episode, profile_hash, infohash, magnet, release_group, resolution, codec, file_index,
       source_kind, size_bytes, score, picked_at, replaces_pick_id
FROM picks
WHERE series_id=$1 AND season=$2 AND episode=$3 AND profile_hash=$4`,
		seriesID, season, episode, profileHash).
		Scan(&p.ID, &p.SeriesID, &p.Season, &p.Episode, &p.ProfileHash, &p.InfoHash, &p.Magnet, &p.ReleaseGroup,
			&p.Resolution, &p.Codec, &p.FileIndex, &p.SourceKind, &p.SizeBytes, &p.ScoreJSON, &p.PickedAt, &p.ReplacesPick)
	if err != nil {
		if err == sql.ErrNoRows {
			return PickRow{}, false, nil
		}
		return PickRow{}, false, err
	}
	return p, true, nil
}

func (r *Repo) InsertPick(ctx context.Context, p PickRow) (int64, error) {
	var id int64
	err := r.DB.QueryRowContext(ctx, `
INSERT INTO picks (series_id, season, episode, profile_hash, infohash, magnet, release_group, resolution, codec,
                   file_index, source_kind, size_bytes, score, picked_at, replaces_pick_id, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())
ON CONFLICT (series_id, season, episode, profile_hash) DO UPDATE
SET infohash=EXCLUDED.infohash, magnet=EXCLUDED.magnet, release_group=EXCLUDED.release_group,
    resolution=EXCLUDED.resolution, codec=EXCLUDED.codec, file_index=EXCLUDED.file_index,
    source_kind=EXCLUDED.source_kind, size_bytes=EXCLUDED.size_bytes, score=EXCLUDED.score,
    picked_at=EXCLUDED.picked_at, replaces_pick_id=EXCLUDED.replaces_pick_id, updated_at=now()
RETURNING id;`,
		p.SeriesID, p.Season, p.Episode, p.ProfileHash, p.InfoHash, p.Magnet, p.ReleaseGroup, p.Resolution, p.Codec,
		p.FileIndex, p.SourceKind, p.SizeBytes, p.ScoreJSON, p.PickedAt, p.ReplacesPick).
		Scan(&id)
	return id, err
}

func searchKey(seriesID string, season, episode int, profileHash string) string {
	return seriesID + "|S" + strconv.Itoa(season) + "E" + strconv.Itoa(episode) + "|" + profileHash
}

func (r *Repo) GetSearchCache(ctx context.Context, key string, maxAge time.Duration) ([]types.Candidate, bool, error) {
	var raw []byte
	var fetchedAt time.Time
	err := r.DB.QueryRowContext(ctx, `SELECT candidates, fetched_at FROM search_cache WHERE key=$1`, key).Scan(&raw, &fetchedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, err
	}
	if maxAge <= 0 || time.Since(fetchedAt) > maxAge {
		return nil, false, nil
	}
	var out []types.Candidate
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

func (r *Repo) PutSearchCache(ctx context.Context, key string, cands []types.Candidate) error {
	raw, err := json.Marshal(cands)
	if err != nil {
		return err
	}
	_, err = r.DB.ExecContext(ctx, `
INSERT INTO search_cache (key, candidates, fetched_at) VALUES ($1,$2,now())
ON CONFLICT (key) DO UPDATE SET candidates=EXCLUDED.candidates, fetched_at=now()`, key, raw)
	return err
}
