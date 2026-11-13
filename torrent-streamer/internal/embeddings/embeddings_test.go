package embeddings

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"torrent-streamer/migrations"
)

func TestTextDescribesTheTitle(t *testing.T) {
	got := Text("Severance", 2022, "series", []string{"Drama", "Mystery"}, "  Office workers'\nmemories are   split. ")
	want := "Severance (2022). Series. Genres: Drama, Mystery. Office workers' memories are split."
	if got != want {
		t.Fatalf("Text = %q", got)
	}
	long := Text("X", 0, "", nil, strings.Repeat("a", 2000))
	if len([]rune(long)) > 920 {
		t.Fatalf("overview not trimmed: %d runes", len([]rune(long)))
	}
}

func TestEncodeRoundTripAndCosine(t *testing.T) {
	v := []float32{0.6, 0.8, 0}
	if got := decode(encode(v)); len(got) != 3 || got[1] != 0.8 {
		t.Fatalf("round trip = %v", got)
	}
	if c := Cosine(v, v); c < 0.999 || c > 1.001 {
		t.Fatalf("cos(v,v) = %v", c)
	}
	if Cosine(v, []float32{1}) != 0 || Cosine(nil, v) != 0 {
		t.Fatal("mismatched vectors must give 0")
	}
}

// fakeTEI answers /embed with a vector derived from each text's length; it
// counts texts and can be made slow or failing.
type fakeTEI struct {
	texts atomic.Int64
	delay time.Duration
	fail  atomic.Bool
}

func (f *fakeTEI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.fail.Load() {
		http.Error(w, "model loading", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Inputs []string `json:"inputs"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	time.Sleep(f.delay)
	f.texts.Add(int64(len(req.Inputs)))
	out := make([][]float32, len(req.Inputs))
	for i, text := range req.Inputs {
		out[i] = []float32{float32(len(text)%7) / 7, 1}
	}
	_ = json.NewEncoder(w).Encode(out)
}

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	base := os.Getenv("TORWATCH_TEST_PG_DSN")
	if base == "" {
		t.Skip("TORWATCH_TEST_PG_DSN not set")
	}
	schema := fmt.Sprintf("emb_%d", time.Now().UnixNano())
	db, err := sql.Open("pgx", base+"&search_path="+schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

func docs(n int, prefix string) []Doc {
	out := make([]Doc, n)
	for i := range out {
		out[i] = Doc{ID: fmt.Sprintf("tmdb:tv:%d", i), Text: fmt.Sprintf("%s title %d", prefix, i)}
	}
	return out
}

// Stored once, then served from the database and memory; a changed text is
// embedded again.
func TestIndexStoresAndReuses(t *testing.T) {
	db := testDB(t)
	tei := &fakeTEI{}
	server := httptest.NewServer(tei)
	defer server.Close()
	index := &Index{DB: db, Client: &Client{Base: server.URL, Model: "test-model"}}
	ctx := context.Background()

	got := index.Vectors(ctx, docs(40, "first"))
	if len(got) != 40 || tei.texts.Load() != 40 {
		t.Fatalf("first call: %d vectors, %d embedded", len(got), tei.texts.Load())
	}
	var stored int
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM title_embeddings WHERE model='test-model'`).Scan(&stored)
	if stored != 40 {
		t.Fatalf("stored %d", stored)
	}

	// A new index (as after a restart) reads them back without the model.
	fresh := &Index{DB: db, Client: &Client{Base: server.URL, Model: "test-model"}}
	if got := fresh.Vectors(ctx, docs(40, "first")); len(got) != 40 || tei.texts.Load() != 40 {
		t.Fatalf("reuse: %d vectors, %d embedded in all", len(got), tei.texts.Load())
	}
	// A changed description is embedded again.
	changed := docs(40, "first")
	changed[3].Text = "a new plot"
	fresh.Vectors(ctx, changed)
	if tei.texts.Load() != 41 {
		t.Fatalf("changed text: %d embedded in all, want 41", tei.texts.Load())
	}
}

// What doesn't fit in the caller's time continues in the background and is
// announced; a failing model server is left alone for a while.
func TestIndexContinuesInTheBackgroundAndBacksOff(t *testing.T) {
	db := testDB(t)
	tei := &fakeTEI{delay: 300 * time.Millisecond}
	server := httptest.NewServer(tei)
	defer server.Close()
	announced := make(chan int, 4)
	index := &Index{DB: db, Client: &Client{Base: server.URL, Model: "test-model"}, OnEmbedded: func(n int) { announced <- n }}

	ctx, cancel := context.WithTimeout(context.Background(), 5200*time.Millisecond)
	defer cancel()
	got := index.Vectors(ctx, docs(100, "slow"))
	if len(got) >= 100 {
		t.Fatalf("all %d embedded within the caller's time; the test needs a slower server", len(got))
	}
	select {
	case n := <-announced:
		if len(got)+n != 100 {
			t.Fatalf("now %d + background %d, want 100", len(got), n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("background embedding never finished")
	}
	if all := index.Vectors(context.Background(), docs(100, "slow")); len(all) != 100 {
		t.Fatalf("after the background run: %d", len(all))
	}

	tei.fail.Store(true)
	before := tei.texts.Load()
	if got := index.Vectors(context.Background(), docs(5, "down")); len(got) != 0 {
		t.Fatalf("down server returned %d", len(got))
	}
	tei.fail.Store(false)
	if got := index.Vectors(context.Background(), docs(5, "down")); len(got) != 0 || tei.texts.Load() != before {
		t.Fatal("a server that just failed must be left alone for a while")
	}
}
