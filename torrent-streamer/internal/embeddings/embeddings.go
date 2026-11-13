// Package embeddings turns a title's description (name, kind, genres, plot)
// into a vector with a local text-embedding model (Hugging Face
// text-embeddings-inference on the server's GPU), so recommendations can tell
// what a title is about, not only which provider lists it. Vectors are kept
// in Postgres (title_embeddings) per model and text; a title is embedded once.
//
// Everything is optional: with no model server, or while it is down, Vectors
// returns what is already stored and recommendations rank without it.
package embeddings

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Client calls a text-embeddings-inference server (POST /embed).
type Client struct {
	Base  string // e.g. http://embeddings:80
	Model string // name recorded with each vector (changing it re-embeds)
	HTTP  *http.Client
}

// Batch is how many texts go in one request.
const Batch = 32

// Embed returns one unit-length vector per text.
func (c *Client) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if c == nil || c.Base == "" {
		return nil, errors.New("embeddings: no model server")
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += Batch {
		end := min(start+Batch, len(texts))
		body, _ := json.Marshal(map[string]any{"inputs": texts[start:end], "normalize": true, "truncate": true})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Base, "/")+"/embed", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("embeddings: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw[:min(len(raw), 200)])))
		}
		var vectors [][]float32
		if err := json.Unmarshal(raw, &vectors); err != nil {
			return nil, fmt.Errorf("embeddings: %w", err)
		}
		if len(vectors) != end-start {
			return nil, fmt.Errorf("embeddings: %d vectors for %d texts", len(vectors), end-start)
		}
		out = append(out, vectors...)
	}
	return out, nil
}

// Doc is one title to embed: its id and the text that describes it.
type Doc struct {
	ID   string
	Text string
}

// Text describes a title for the model: name and year, kind, genres, plot.
func Text(title string, year int, kind string, genres []string, overview string) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(title))
	if year > 0 {
		fmt.Fprintf(&b, " (%d)", year)
	}
	b.WriteString(". ")
	switch kind {
	case "movie":
		b.WriteString("Movie. ")
	case "anime":
		b.WriteString("Anime. ")
	case "series":
		b.WriteString("Series. ")
	}
	if len(genres) > 0 {
		b.WriteString("Genres: " + strings.Join(genres, ", ") + ". ")
	}
	overview = strings.Join(strings.Fields(overview), " ")
	if r := []rune(overview); len(r) > 900 {
		overview = string(r[:900])
	}
	b.WriteString(overview)
	return strings.TrimSpace(b.String())
}

// Index stores vectors and embeds what is missing.
type Index struct {
	DB     *sql.DB
	Client *Client
	// OnEmbedded is called after background embedding stored new vectors
	// (rankings computed before can now use them).
	OnEmbedded func(count int)

	mu      sync.Mutex
	memo    map[string]memoEntry // id → vector for the current model and text
	downAt  time.Time            // model server failed: skip it for a while
	pending map[string]Doc       // waiting for the background worker
	working bool
}

type memoEntry struct {
	hash   string
	vector []float32
}

// Model is the model name vectors are stored under ("" without a client).
func (x *Index) Model() string {
	if x == nil || x.Client == nil {
		return ""
	}
	return x.Client.Model
}

func hashText(text string) string {
	sum := sha1.Sum([]byte(text))
	return hex.EncodeToString(sum[:8])
}

// Vectors returns a vector for every doc it has or can make now. Missing
// ones are embedded (at most MaxNew per call) unless the model server failed
// within the last 2 minutes.
func (x *Index) Vectors(ctx context.Context, docs []Doc) map[string][]float32 {
	out := map[string][]float32{}
	if x == nil || x.Client == nil || x.DB == nil || len(docs) == 0 {
		return out
	}
	model := x.Client.Model
	hashes := make(map[string]string, len(docs))
	var lookup []string
	x.mu.Lock()
	if x.memo == nil {
		x.memo = map[string]memoEntry{}
	}
	for _, doc := range docs {
		if doc.ID == "" || doc.Text == "" {
			continue
		}
		hash := hashText(doc.Text)
		hashes[doc.ID] = hash
		if entry, ok := x.memo[doc.ID]; ok && entry.hash == hash {
			out[doc.ID] = entry.vector
		} else {
			lookup = append(lookup, doc.ID)
		}
	}
	x.mu.Unlock()

	if len(lookup) > 0 {
		rows, err := x.DB.QueryContext(ctx, `SELECT canonical_id, text_hash, vector FROM title_embeddings WHERE model=$1 AND canonical_id = ANY($2)`, model, lookup)
		if err == nil {
			for rows.Next() {
				var id, hash string
				var raw []byte
				if rows.Scan(&id, &hash, &raw) != nil || hashes[id] != hash {
					continue
				}
				if vector := decode(raw); vector != nil {
					out[id] = vector
					x.remember(id, hash, vector)
				}
			}
			rows.Close()
		}
	}

	var missing []Doc
	for _, doc := range docs {
		if _, ok := out[doc.ID]; !ok && hashes[doc.ID] != "" {
			missing = append(missing, doc)
		}
	}
	if len(missing) == 0 {
		return out
	}
	x.mu.Lock()
	down := !x.downAt.IsZero() && time.Since(x.downAt) < 2*time.Minute
	x.mu.Unlock()
	if down {
		return out
	}
	// Batch by batch while the caller can wait (each batch is stored as it
	// comes); whatever is left continues in the background.
	for len(missing) > 0 {
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < 5*time.Second {
			break
		}
		batch := missing[:min(Batch, len(missing))]
		vectors, err := x.embedAndStore(ctx, batch, hashes)
		if err != nil {
			if ctx.Err() == nil {
				x.failed(err, len(missing))
				return out
			}
			break
		}
		for id, vector := range vectors {
			out[id] = vector
		}
		missing = missing[len(batch):]
	}
	if len(missing) > 0 {
		x.queue(missing)
	}
	return out
}

func (x *Index) failed(err error, count int) {
	x.mu.Lock()
	x.downAt = time.Now()
	x.mu.Unlock()
	log.Printf("[embeddings] %d title(s) not embedded: %v", count, err)
}

// embedAndStore embeds one batch and stores it.
func (x *Index) embedAndStore(ctx context.Context, docs []Doc, hashes map[string]string) (map[string][]float32, error) {
	texts := make([]string, len(docs))
	for i, doc := range docs {
		texts[i] = doc.Text
	}
	vectors, err := x.Client.Embed(ctx, texts)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]float32, len(docs))
	for i, doc := range docs {
		hash := hashes[doc.ID]
		if hash == "" {
			hash = hashText(doc.Text)
		}
		out[doc.ID] = vectors[i]
		x.remember(doc.ID, hash, vectors[i])
		_, err := x.DB.ExecContext(context.WithoutCancel(ctx), `
INSERT INTO title_embeddings (canonical_id, model, text_hash, vector) VALUES ($1, $2, $3, $4)
ON CONFLICT (canonical_id, model) DO UPDATE SET text_hash=EXCLUDED.text_hash, vector=EXCLUDED.vector, updated_at=now()`,
			doc.ID, x.Client.Model, hash, encode(vectors[i]))
		if err != nil {
			log.Printf("[embeddings] storing %s: %v", doc.ID, err)
		}
	}
	return out, nil
}

// queue hands docs to the background worker (started if idle).
func (x *Index) queue(docs []Doc) {
	x.mu.Lock()
	if x.pending == nil {
		x.pending = map[string]Doc{}
	}
	for _, doc := range docs {
		x.pending[doc.ID] = doc
	}
	start := !x.working
	x.working = true
	x.mu.Unlock()
	if start {
		go x.work()
	}
}

func (x *Index) work() {
	total := 0
	defer func() {
		x.mu.Lock()
		x.working = false
		x.mu.Unlock()
		if total > 0 {
			log.Printf("[embeddings] embedded %d title(s) in the background", total)
			if x.OnEmbedded != nil {
				x.OnEmbedded(total)
			}
		}
	}()
	for {
		x.mu.Lock()
		batch := make([]Doc, 0, Batch)
		for id, doc := range x.pending {
			batch = append(batch, doc)
			delete(x.pending, id)
			if len(batch) == Batch {
				break
			}
		}
		x.mu.Unlock()
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		_, err := x.embedAndStore(ctx, batch, nil)
		cancel()
		if err != nil {
			x.failed(err, len(batch))
			x.mu.Lock()
			x.pending = nil // retried when rankings ask again
			x.mu.Unlock()
			return
		}
		total += len(batch)
	}
}

func (x *Index) remember(id, hash string, vector []float32) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if len(x.memo) > 20000 {
		x.memo = map[string]memoEntry{}
	}
	x.memo[id] = memoEntry{hash: hash, vector: vector}
}

func encode(vector []float32) []byte {
	raw := make([]byte, 4*len(vector))
	for i, value := range vector {
		binary.LittleEndian.PutUint32(raw[4*i:], math.Float32bits(value))
	}
	return raw
}

func decode(raw []byte) []float32 {
	if len(raw) == 0 || len(raw)%4 != 0 {
		return nil
	}
	vector := make([]float32, len(raw)/4)
	for i := range vector {
		vector[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[4*i:]))
	}
	return vector
}

// Cosine of two unit vectors (0 when either is missing or sizes differ).
func Cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var sum float64
	for i := range a {
		sum += float64(a[i]) * float64(b[i])
	}
	return sum
}
