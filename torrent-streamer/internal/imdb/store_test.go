package imdb

import (
	"encoding/csv"
	"strings"
	"testing"
)

func TestRatingSourceParsesOfficialRows(t *testing.T) {
	t.Parallel()

	reader := csv.NewReader(strings.NewReader("tt0000001\t5.7\t2117\ntt1234567\t8.9\t42\n"))
	reader.Comma = '\t'
	reader.FieldsPerRecord = 3
	source := &ratingSource{reader: reader}
	var rows [][]any
	for source.Next() {
		values, err := source.Values()
		if err != nil {
			t.Fatalf("Values() error = %v", err)
		}
		rows = append(rows, values)
	}
	if err := source.Err(); err != nil {
		t.Fatalf("Err() = %v", err)
	}
	if len(rows) != 2 || rows[1][0] != "tt1234567" || rows[1][2] != int64(42) {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestRatingSourceRejectsMalformedRow(t *testing.T) {
	t.Parallel()

	reader := csv.NewReader(strings.NewReader("nm123\t11.2\t-1\n"))
	reader.Comma = '\t'
	reader.FieldsPerRecord = 3
	source := &ratingSource{reader: reader}
	if source.Next() {
		t.Fatal("Next() = true, want malformed row rejection")
	}
	if source.Err() == nil {
		t.Fatal("Err() = nil, want validation error")
	}
}
