package introdetect

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
)

// Store keeps fingerprints and learned songs in Postgres (migration 014).
type Store struct{ DB *sql.DB }

// Ref identifies one video file and the episode it is.
type Ref struct {
	InfoHash  string // lowercase hex
	FileIndex int
	SeriesKey string // canonical series id (anilist:6033, tmdb:tv:95396)
	Season    int
	Episode   int
	ShowKind  string // anime, tv, movie
}

func (s *Store) SaveFile(ctx context.Context, ref Ref, file File) error {
	_, err := s.DB.ExecContext(ctx, `
INSERT INTO skip_fingerprints (infohash, file_index, series_key, season, episode, show_kind, duration_s, data)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (infohash, file_index) DO UPDATE SET series_key=EXCLUDED.series_key, season=EXCLUDED.season,
  episode=EXCLUDED.episode, show_kind=EXCLUDED.show_kind, duration_s=EXCLUDED.duration_s, data=EXCLUDED.data`,
		ref.InfoHash, ref.FileIndex, ref.SeriesKey, ref.Season, ref.Episode, ref.ShowKind, file.Duration,
		EncodeParts(file.Head, file.Tail))
	return err
}

func (s *Store) LoadFile(ctx context.Context, infoHash string, fileIndex int) (File, bool, error) {
	row := s.DB.QueryRowContext(ctx, `
SELECT season, episode, duration_s, data FROM skip_fingerprints WHERE infohash=$1 AND file_index=$2`, infoHash, fileIndex)
	file := File{Key: fileKey(infoHash, fileIndex)}
	var data []byte
	if err := row.Scan(&file.Season, &file.Episode, &file.Duration, &data); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return File{}, false, nil
		}
		return File{}, false, err
	}
	var err error
	if file.Head, file.Tail, err = DecodeParts(data); err != nil {
		return File{}, false, err
	}
	return file, true, nil
}

// Neighbours returns other files of the show, nearest episodes first.
func (s *Store) Neighbours(ctx context.Context, ref Ref, limit int) ([]File, error) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT infohash, file_index, season, episode, duration_s, data FROM skip_fingerprints
WHERE series_key=$1 AND NOT (infohash=$2 AND file_index=$3)
ORDER BY abs((season*1000 + episode) - $4), created_at DESC
LIMIT $5`, ref.SeriesKey, ref.InfoHash, ref.FileIndex, ref.Season*1000+ref.Episode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []File
	for rows.Next() {
		var infoHash string
		var fileIndex int
		var data []byte
		file := File{}
		if err := rows.Scan(&infoHash, &fileIndex, &file.Season, &file.Episode, &file.Duration, &data); err != nil {
			return nil, err
		}
		file.Key = fileKey(infoHash, fileIndex)
		if file.Head, file.Tail, err = DecodeParts(data); err != nil {
			continue
		}
		files = append(files, file)
	}
	return files, rows.Err()
}

func (s *Store) Themes(ctx context.Context, seriesKey string) ([]Theme, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT kind, source, data FROM skip_themes WHERE series_key=$1 ORDER BY id`, seriesKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var themes []Theme
	for rows.Next() {
		var kind, source string
		var data []byte
		if err := rows.Scan(&kind, &source, &data); err != nil {
			return nil, err
		}
		points, err := DecodePoints(data)
		if err != nil {
			continue
		}
		themes = append(themes, Theme{Kind: Kind(kind), Points: points, Source: source})
	}
	return themes, rows.Err()
}

func (s *Store) HasTheme(ctx context.Context, seriesKey, source string) (bool, error) {
	var n int
	err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM skip_themes WHERE series_key=$1 AND source=$2`, seriesKey, source).Scan(&n)
	return n > 0, err
}

// SaveTheme keeps a song; added is false when the show already has it.
func (s *Store) SaveTheme(ctx context.Context, seriesKey string, theme Theme) (added bool, err error) {
	res, err := s.DB.ExecContext(ctx, `
INSERT INTO skip_themes (series_key, kind, source, data) VALUES ($1,$2,$3,$4)
ON CONFLICT (series_key, kind, source) DO NOTHING`, seriesKey, string(theme.Kind), theme.Source, EncodePoints(theme.Points))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func fileKey(infoHash string, fileIndex int) string {
	return infoHash + "#" + strconv.Itoa(fileIndex)
}
