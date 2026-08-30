// Package imdb imports and serves the official IMDb non-commercial ratings dataset.
package imdb

import (
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const (
	DefaultDatasetURL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
	datasetName       = "imdb-title-ratings"
	maxDownloadSize   = 256 << 20
)

var ErrRatingNotFound = errors.New("IMDb rating not found")

type Rating struct {
	IMDbID string  `json:"imdbId"`
	Rating float64 `json:"rating"`
	Votes  int64   `json:"votes"`
}

type RefreshResult struct {
	Updated  bool
	RowCount int64
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Rating(ctx context.Context, imdbID string) (Rating, error) {
	var result Rating
	err := s.db.QueryRowContext(ctx, `
SELECT tconst, rating, votes
FROM imdb_ratings
WHERE tconst = $1`, imdbID).Scan(&result.IMDbID, &result.Rating, &result.Votes)
	if errors.Is(err, sql.ErrNoRows) {
		return Rating{}, ErrRatingNotFound
	}
	if err != nil {
		return Rating{}, fmt.Errorf("query IMDb rating: %w", err)
	}
	return result, nil
}

func (s *Store) RefreshIfDue(
	ctx context.Context,
	client *http.Client,
	datasetURL string,
	now time.Time,
	interval time.Duration,
) (RefreshResult, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if datasetURL == "" {
		datasetURL = DefaultDatasetURL
	}

	var (
		etag         sql.NullString
		lastModified sql.NullString
		checkedAt    sql.NullTime
	)
	err := s.db.QueryRowContext(ctx, `
SELECT etag, last_modified, checked_at
FROM dataset_imports
WHERE dataset = $1`, datasetName).Scan(&etag, &lastModified, &checkedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return RefreshResult{}, fmt.Errorf("read IMDb import state: %w", err)
	}
	if err == nil && checkedAt.Valid && now.Sub(checkedAt.Time) < interval {
		return RefreshResult{}, nil
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, datasetURL, nil)
	if err != nil {
		return RefreshResult{}, fmt.Errorf("create IMDb dataset request: %w", err)
	}
	if etag.Valid {
		request.Header.Set("If-None-Match", etag.String)
	}
	if lastModified.Valid {
		request.Header.Set("If-Modified-Since", lastModified.String)
	}
	response, err := client.Do(request)
	if err != nil {
		return RefreshResult{}, fmt.Errorf("download IMDb dataset: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNotModified {
		if _, err := s.db.ExecContext(ctx, `
UPDATE dataset_imports SET checked_at = $2 WHERE dataset = $1`, datasetName, now); err != nil {
			return RefreshResult{}, fmt.Errorf("record IMDb dataset check: %w", err)
		}
		return RefreshResult{}, nil
	}
	if response.StatusCode != http.StatusOK {
		return RefreshResult{}, fmt.Errorf("download IMDb dataset: unexpected HTTP status %d", response.StatusCode)
	}

	temporary, err := os.CreateTemp("", "torwatch-imdb-ratings-*.tsv.gz")
	if err != nil {
		return RefreshResult{}, fmt.Errorf("create IMDb download file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	written, copyErr := io.Copy(temporary, io.LimitReader(response.Body, maxDownloadSize+1))
	closeErr := temporary.Close()
	if copyErr != nil {
		return RefreshResult{}, fmt.Errorf("save IMDb dataset: %w", copyErr)
	}
	if closeErr != nil {
		return RefreshResult{}, fmt.Errorf("close IMDb dataset file: %w", closeErr)
	}
	if written > maxDownloadSize {
		return RefreshResult{}, fmt.Errorf("IMDb dataset exceeds %d bytes", maxDownloadSize)
	}

	rowCount, err := s.importFile(ctx, temporaryPath, response.Header.Get("ETag"), response.Header.Get("Last-Modified"), now)
	if err != nil {
		return RefreshResult{}, err
	}
	return RefreshResult{Updated: true, RowCount: rowCount}, nil
}

func (s *Store) importFile(ctx context.Context, path, etag, lastModified string, now time.Time) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open IMDb dataset: %w", err)
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return 0, fmt.Errorf("open IMDb dataset gzip stream: %w", err)
	}
	defer gzipReader.Close()

	reader := csv.NewReader(gzipReader)
	reader.Comma = '\t'
	reader.FieldsPerRecord = 3
	header, err := reader.Read()
	if err != nil {
		return 0, fmt.Errorf("read IMDb dataset header: %w", err)
	}
	if strings.Join(header, "\t") != "tconst\taverageRating\tnumVotes" {
		return 0, fmt.Errorf("unexpected IMDb dataset header %q", strings.Join(header, "\t"))
	}
	source := &ratingSource{reader: reader}

	connection, err := s.db.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("reserve IMDb import connection: %w", err)
	}
	defer connection.Close()
	err = connection.Raw(func(driverConnection any) error {
		stdlibConnection, ok := driverConnection.(*stdlib.Conn)
		if !ok {
			return fmt.Errorf("unexpected PostgreSQL driver connection %T", driverConnection)
		}
		return importRatings(ctx, stdlibConnection.Conn(), source, etag, lastModified, now)
	})
	if err != nil {
		return 0, fmt.Errorf("import IMDb ratings: %w", err)
	}
	return source.count, nil
}

func importRatings(
	ctx context.Context,
	connection *pgx.Conn,
	source *ratingSource,
	etag, lastModified string,
	now time.Time,
) error {
	transaction, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin import: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	if _, err := transaction.Exec(ctx, `
CREATE TEMP TABLE imdb_ratings_stage (
  tconst TEXT PRIMARY KEY,
  rating REAL NOT NULL,
  votes BIGINT NOT NULL
) ON COMMIT DROP`); err != nil {
		return fmt.Errorf("create staging table: %w", err)
	}
	if _, err := transaction.CopyFrom(
		ctx,
		pgx.Identifier{"imdb_ratings_stage"},
		[]string{"tconst", "rating", "votes"},
		source,
	); err != nil {
		return fmt.Errorf("copy ratings into staging table: %w", err)
	}

	var datasetUpdatedAt any
	if parsed, parseErr := http.ParseTime(lastModified); parseErr == nil {
		datasetUpdatedAt = parsed
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO imdb_ratings (tconst, rating, votes, dataset_updated_at, imported_at)
SELECT tconst, rating, votes, $1, $2 FROM imdb_ratings_stage
ON CONFLICT (tconst) DO UPDATE
SET rating = EXCLUDED.rating,
    votes = EXCLUDED.votes,
    dataset_updated_at = EXCLUDED.dataset_updated_at,
    imported_at = EXCLUDED.imported_at
WHERE imdb_ratings.rating IS DISTINCT FROM EXCLUDED.rating
   OR imdb_ratings.votes IS DISTINCT FROM EXCLUDED.votes`, datasetUpdatedAt, now); err != nil {
		return fmt.Errorf("merge ratings: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
DELETE FROM imdb_ratings current
WHERE NOT EXISTS (SELECT 1 FROM imdb_ratings_stage stage WHERE stage.tconst = current.tconst)`); err != nil {
		return fmt.Errorf("remove retired ratings: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO dataset_imports (dataset, etag, last_modified, row_count, checked_at, imported_at)
VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, $5, $5)
ON CONFLICT (dataset) DO UPDATE
SET etag = EXCLUDED.etag,
    last_modified = EXCLUDED.last_modified,
    row_count = EXCLUDED.row_count,
    checked_at = EXCLUDED.checked_at,
    imported_at = EXCLUDED.imported_at`, datasetName, etag, lastModified, source.count, now); err != nil {
		return fmt.Errorf("record import state: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit import: %w", err)
	}
	return nil
}

type ratingSource struct {
	reader *csv.Reader
	values []any
	err    error
	count  int64
}

func (s *ratingSource) Next() bool {
	record, err := s.reader.Read()
	if errors.Is(err, io.EOF) {
		return false
	}
	if err != nil {
		s.err = fmt.Errorf("read row %d: %w", s.count+2, err)
		return false
	}
	if !validIMDbID(record[0]) {
		s.err = fmt.Errorf("row %d has invalid IMDb id %q", s.count+2, record[0])
		return false
	}
	rating, err := strconv.ParseFloat(record[1], 32)
	if err != nil || rating < 0 || rating > 10 {
		s.err = fmt.Errorf("row %d has invalid rating %q", s.count+2, record[1])
		return false
	}
	votes, err := strconv.ParseInt(record[2], 10, 64)
	if err != nil || votes < 0 {
		s.err = fmt.Errorf("row %d has invalid vote count %q", s.count+2, record[2])
		return false
	}
	s.values = []any{record[0], float32(rating), votes}
	s.count++
	return true
}

func (s *ratingSource) Values() ([]any, error) {
	return s.values, nil
}

func (s *ratingSource) Err() error {
	return s.err
}

func validIMDbID(value string) bool {
	if len(value) < 3 || !strings.HasPrefix(value, "tt") {
		return false
	}
	for _, character := range value[2:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}
