package recommendations

// Learning from what happens to recommendations (migration 019):
//
//   - Impressions: every card seen on screen is recorded with the ranking
//     features it had. A title shown again and again without being opened
//     sinks, and after views ignored it rests for a while.
//   - Not interested: never recommended again (until undone); titles like it
//     count against.
//   - Outcomes: opened, saved, started, finished, dropped, rejected; read from
//     the profile's own activity after the title was first shown.
//   - Model: per profile, a logistic model over the features, trained on
//     those outcomes. It starts as the hand-set prior score and moves from it
//     only as far as the evidence pulls it (L2 towards the prior).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

// Feature names, in model order. Each is computed for every candidate.
var featureNames = []string{
	"prior",     // the hand-set score (below); the untrained model is exactly this
	"seed",      // summed weight of the profile's titles whose "more like this" lists it
	"seedTop",   // weight of the strongest of them
	"consensus", // how many more of those titles list it (beyond the first)
	"cross",     // support from crossover lists (other media type, shared themes)
	"genre",     // share of the profile's taste weight its genres overlap (0..1)
	"sim",       // how alike in content it is to what the profile likes (embeddings)
	"neg",       // how alike it is to what the profile dropped or rejected
	"popular",   // place in the provider's popularity order (0..1)
	"fresh",     // released this year or last
	"views",     // log(1 + times shown without being opened)
	"explore",   // not listed by any of the profile's titles
}

// Features of one candidate (by name).
type Features map[string]float64

// priorScore is the hand-set ranking: support from the strongest title that
// lists it (with diminishing returns), a fixed bonus when others agree,
// content likeness, genre and freshness; minus what resembles rejected
// titles and what was ignored. Summing the supporters let two heavy shows
// that both list a generic title (Fantasy Island for Severance and Game of
// Thrones) outrank titles plainly like one of them (checked against real
// data, 2026-11-13).
func priorScore(f Features) float64 {
	return 2*math.Log1p(f["seedTop"]+f["cross"]) + 0.6*min(f["consensus"], 2) + 1.0*f["sim"] + 0.5*f["genre"] -
		1.0*f["neg"] - 0.8*f["views"] + 0.3*f["popular"] + 0.2*f["fresh"]
}

// Model is a profile's learned ranking: score = Σ weight·feature.
type Model struct {
	Weights   map[string]float64 `json:"weights"`
	Bias      float64            `json:"bias"`
	Samples   int                `json:"samples"`
	Positives int                `json:"positives"`
	TrainedAt time.Time          `json:"trainedAt"`
	// Fit on the training data (for the stats line and logs).
	AUC float64 `json:"auc"`
}

func priorWeights() map[string]float64 {
	return map[string]float64{"prior": 1}
}

// Score ranks a candidate. A nil model is the prior.
func (m *Model) Score(f Features) float64 {
	if m == nil || len(m.Weights) == 0 {
		return f["prior"]
	}
	var score float64
	for name, weight := range m.Weights {
		score += weight * f[name]
	}
	return score
}

// Sample is one shown title with its outcome.
type Sample struct {
	ID       string
	Features Features
	Label    float64 // 1 = wanted it, 0 = did not
	Weight   float64 // how much the outcome says
}

// minSamples / minEach: below these a profile keeps the prior.
const (
	minSamples = 20
	minEach    = 3
	// l2 pulls weights towards the prior; with few samples the prior wins.
	l2 = 1.0
)

// Train fits the model on samples (nil when there are too few to trust).
func Train(samples []Sample, now time.Time) *Model {
	positives, negatives := 0, 0
	for _, sample := range samples {
		if sample.Label >= 0.5 {
			positives++
		} else {
			negatives++
		}
	}
	if len(samples) < minSamples || positives < minEach || negatives < minEach {
		return nil
	}
	prior := priorWeights()
	weights := make([]float64, len(featureNames))
	center := make([]float64, len(featureNames))
	for i, name := range featureNames {
		center[i] = prior[name]
		weights[i] = prior[name]
	}
	x := make([][]float64, len(samples))
	for s, sample := range samples {
		x[s] = make([]float64, len(featureNames))
		for i, name := range featureNames {
			x[s][i] = sample.Features[name]
		}
	}
	// The prior score's scale is arbitrary: start the bias where the data's
	// base rate is, then gradient descent on weighted log-loss + L2.
	bias := 0.0
	var totalWeight float64
	for _, sample := range samples {
		totalWeight += sample.Weight
	}
	if totalWeight <= 0 {
		return nil
	}
	rate := 0.05
	for iteration := 0; iteration < 3000; iteration++ {
		gradW := make([]float64, len(weights))
		var gradB float64
		for s, sample := range samples {
			z := bias
			for i := range weights {
				z += weights[i] * x[s][i]
			}
			p := 1 / (1 + math.Exp(-z))
			diff := (p - sample.Label) * sample.Weight
			gradB += diff
			for i := range weights {
				gradW[i] += diff * x[s][i]
			}
		}
		for i := range weights {
			grad := gradW[i]/totalWeight + l2*(weights[i]-center[i])/totalWeight
			weights[i] -= rate * grad
		}
		bias -= rate * gradB / totalWeight
	}
	model := &Model{Weights: map[string]float64{}, Bias: bias, Samples: len(samples), Positives: positives, TrainedAt: now}
	for i, name := range featureNames {
		if weights[i] != 0 {
			model.Weights[name] = weights[i]
		}
	}
	model.AUC = auc(model, samples)
	return model
}

// auc: the chance a wanted title outranks an unwanted one under the model.
func auc(model *Model, samples []Sample) float64 {
	var pos, neg []float64
	for _, sample := range samples {
		if sample.Label >= 0.5 {
			pos = append(pos, model.Score(sample.Features))
		} else {
			neg = append(neg, model.Score(sample.Features))
		}
	}
	if len(pos) == 0 || len(neg) == 0 {
		return 0
	}
	var wins float64
	for _, p := range pos {
		for _, n := range neg {
			switch {
			case p > n:
				wins++
			case p == n:
				wins += 0.5
			}
		}
	}
	return wins / float64(len(pos)*len(neg))
}

// Impression is what a profile was shown of one title.
type Impression struct {
	Views     int
	FirstAt   time.Time
	LastAt    time.Time
	Opened    bool // opened, saved or started since first shown
	Interests bool
}

// Rejection is a title the profile said it isn't interested in.
type Rejection struct {
	ID    string
	Title string
}

// Stats sums what came of the last days' recommendations.
type Stats struct {
	Days          int        `json:"days"`
	Shown         int        `json:"shown"`
	Opened        int        `json:"opened"`
	Saved         int        `json:"saved"`
	Started       int        `json:"started"`
	Finished      int        `json:"finished"`
	NotInterested int        `json:"notInterested"`
	Model         *ModelInfo `json:"model,omitempty"`
}

// ModelInfo describes the profile's learned model.
type ModelInfo struct {
	Samples   int       `json:"samples"`
	Positives int       `json:"positives"`
	TrainedAt time.Time `json:"trainedAt"`
	AUC       float64   `json:"auc"`
}

// Feedback is the SQL store behind learning. A nil *Feedback learns nothing.
type Feedback struct {
	DB *sql.DB
}

// viewGap: seeing the same card again within this counts as the same view.
const viewGap = 6 * time.Hour

// Seen records cards seen on screen (position: their place in the row).
func (f *Feedback) Seen(ctx context.Context, profileID string, ids []string, positions []int, features []Features) error {
	if f == nil || f.DB == nil {
		return nil
	}
	for i, id := range ids {
		if strings.TrimSpace(id) == "" {
			continue
		}
		var raw []byte
		if i < len(features) && features[i] != nil {
			raw, _ = json.Marshal(features[i])
		}
		position := 0
		if i < len(positions) {
			position = positions[i]
		}
		_, err := f.DB.ExecContext(ctx, `
INSERT INTO rec_impressions (profile_id, canonical_id, best_position, features)
VALUES ($1, $2, $3, $4)
ON CONFLICT (profile_id, canonical_id) DO UPDATE SET
  views = rec_impressions.views + CASE WHEN rec_impressions.last_shown_at < now() - $5::interval THEN 1 ELSE 0 END,
  last_shown_at = now(),
  best_position = LEAST(rec_impressions.best_position, EXCLUDED.best_position),
  features = COALESCE(EXCLUDED.features, rec_impressions.features)`,
			profileID, id, position, nullJSON(raw), viewGap.String())
		if err != nil {
			return err
		}
	}
	return nil
}

func nullJSON(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

// SetNotInterested records (or, undo, removes) a "not interested".
func (f *Feedback) SetNotInterested(ctx context.Context, profileID, id, title string, undo bool) error {
	if f == nil || f.DB == nil {
		return errors.New("recommendations: feedback is not stored on this server")
	}
	if undo {
		_, err := f.DB.ExecContext(ctx, `DELETE FROM rec_feedback WHERE profile_id=$1 AND canonical_id=$2`, profileID, id)
		return err
	}
	_, err := f.DB.ExecContext(ctx, `
INSERT INTO rec_feedback (profile_id, canonical_id, kind, title) VALUES ($1, $2, 'not_interested', $3)
ON CONFLICT (profile_id, canonical_id) DO UPDATE SET created_at=now(), title=EXCLUDED.title`, profileID, id, title)
	return err
}

// Rejections lists the profile's "not interested" titles.
func (f *Feedback) Rejections(ctx context.Context, profileID string) ([]Rejection, error) {
	if f == nil || f.DB == nil {
		return nil, nil
	}
	rows, err := f.DB.QueryContext(ctx, `SELECT canonical_id, title FROM rec_feedback WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 200`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Rejection
	for rows.Next() {
		var r Rejection
		if err := rows.Scan(&r.ID, &r.Title); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// outcomeSQL: per shown title, what the profile did with it after first
// seeing it (an hour's slack for clocks).
const outcomeSQL = `
SELECT i.canonical_id, i.views, i.first_shown_at, i.last_shown_at, COALESCE(i.features::text, ''),
  EXISTS (SELECT 1 FROM taste_events te WHERE te.subject_id=i.profile_id AND te.canonical_id=i.canonical_id
          AND te.created_at >= i.first_shown_at - interval '1 hour') AS opened,
  EXISTS (SELECT 1 FROM library_memberships lm JOIN profiles p ON p.household_id=lm.household_id
          WHERE p.id=i.profile_id AND lm.canonical_id=i.canonical_id AND (lm.favourite OR lm.watch_later)
            AND lm.updated_at >= i.first_shown_at - interval '1 hour') AS saved,
  EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.subject_id=i.profile_id AND wp.series_id=i.canonical_id
          AND wp.created_at >= i.first_shown_at - interval '1 hour' AND wp.position_s > 0) AS started,
  COALESCE((SELECT max(wp.percent) FROM watch_progress wp WHERE wp.subject_id=i.profile_id AND wp.series_id=i.canonical_id), 0) AS best,
  COALESCE((SELECT count(*) FROM watch_progress wp WHERE wp.subject_id=i.profile_id AND wp.series_id=i.canonical_id AND wp.percent >= 90), 0) AS finished,
  COALESCE((SELECT max(wp.updated_at) FROM watch_progress wp WHERE wp.subject_id=i.profile_id AND wp.series_id=i.canonical_id), 'epoch'::timestamptz) AS last_progress,
  EXISTS (SELECT 1 FROM rec_feedback f WHERE f.profile_id=i.profile_id AND f.canonical_id=i.canonical_id) AS rejected
FROM rec_impressions i
WHERE i.profile_id=$1`

type outcome struct {
	id                               string
	views                            int
	firstAt, lastAt, lastProgress    time.Time
	features                         Features
	opened, saved, started, rejected bool
	best                             float64
	finished                         int
}

func (f *Feedback) outcomes(ctx context.Context, profileID string) ([]outcome, error) {
	if f == nil || f.DB == nil {
		return nil, nil
	}
	rows, err := f.DB.QueryContext(ctx, outcomeSQL, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []outcome
	for rows.Next() {
		var o outcome
		var rawFeatures string
		if err := rows.Scan(&o.id, &o.views, &o.firstAt, &o.lastAt, &rawFeatures, &o.opened, &o.saved, &o.started,
			&o.best, &o.finished, &o.lastProgress, &o.rejected); err != nil {
			return nil, err
		}
		if rawFeatures != "" {
			_ = json.Unmarshal([]byte(rawFeatures), &o.features)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Impressions: what the profile was shown, and whether it took any up.
func (f *Feedback) Impressions(ctx context.Context, profileID string) (map[string]Impression, error) {
	outcomes, err := f.outcomes(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Impression, len(outcomes))
	for _, o := range outcomes {
		out[o.id] = Impression{Views: o.views, FirstAt: o.firstAt, LastAt: o.lastAt,
			Opened: o.opened || o.saved || o.started, Interests: o.saved || o.started}
	}
	return out, nil
}

// droppedAfter: started, under half watched and untouched this long: dropped.
const droppedAfter = 21 * 24 * time.Hour

// label turns an outcome into a training label (ok false: too early to say).
func label(o outcome, now time.Time) (Sample, bool) {
	sample := Sample{ID: o.id, Features: o.features}
	dropped := o.started && o.best < 50 && o.finished == 0 && now.Sub(o.lastProgress) > droppedAfter
	switch {
	case o.rejected:
		sample.Label, sample.Weight = 0, 2
	case o.finished > 0 || o.best >= 50:
		sample.Label, sample.Weight = 1, 1.5
	case dropped:
		sample.Label, sample.Weight = 0, 0.5
	case o.started || o.saved:
		sample.Label, sample.Weight = 1, 1
	case o.opened:
		sample.Label, sample.Weight = 1, 0.4
	case o.views >= 3:
		sample.Label, sample.Weight = 0, 1
	case o.views >= 2 && now.Sub(o.lastAt) > 14*24*time.Hour:
		sample.Label, sample.Weight = 0, 0.5
	default:
		return Sample{}, false
	}
	return sample, len(o.features) > 0
}

// Samples: the profile's labelled impressions.
func (f *Feedback) Samples(ctx context.Context, profileID string, now time.Time) ([]Sample, error) {
	outcomes, err := f.outcomes(ctx, profileID)
	if err != nil {
		return nil, err
	}
	samples := make([]Sample, 0, len(outcomes))
	for _, o := range outcomes {
		if sample, ok := label(o, now); ok {
			samples = append(samples, sample)
		}
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i].ID < samples[j].ID })
	return samples, nil
}

// Stats over titles shown in the last days.
func (f *Feedback) Stats(ctx context.Context, profileID string, days int, now time.Time) (Stats, error) {
	stats := Stats{Days: days}
	outcomes, err := f.outcomes(ctx, profileID)
	if err != nil {
		return stats, err
	}
	since := now.Add(-time.Duration(days) * 24 * time.Hour)
	for _, o := range outcomes {
		if o.lastAt.Before(since) {
			continue
		}
		stats.Shown++
		if o.opened {
			stats.Opened++
		}
		if o.saved {
			stats.Saved++
		}
		if o.started {
			stats.Started++
		}
		if o.started && (o.finished > 0 || o.best >= 90) {
			stats.Finished++
		}
		if o.rejected {
			stats.NotInterested++
		}
	}
	if model, err := f.LoadModel(ctx, profileID); err == nil && model != nil {
		stats.Model = &ModelInfo{Samples: model.Samples, Positives: model.Positives, TrainedAt: model.TrainedAt, AUC: model.AUC}
	}
	return stats, nil
}

// SaveModel stores (nil: removes) the profile's model.
func (f *Feedback) SaveModel(ctx context.Context, profileID string, model *Model) error {
	if f == nil || f.DB == nil {
		return nil
	}
	if model == nil {
		_, err := f.DB.ExecContext(ctx, `DELETE FROM rec_models WHERE profile_id=$1`, profileID)
		return err
	}
	raw, _ := json.Marshal(model)
	_, err := f.DB.ExecContext(ctx, `
INSERT INTO rec_models (profile_id, weights, samples, positives, trained_at) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (profile_id) DO UPDATE SET weights=EXCLUDED.weights, samples=EXCLUDED.samples, positives=EXCLUDED.positives, trained_at=EXCLUDED.trained_at`,
		profileID, string(raw), model.Samples, model.Positives, model.TrainedAt)
	return err
}

// LoadModel reads the profile's model (nil when it has none).
func (f *Feedback) LoadModel(ctx context.Context, profileID string) (*Model, error) {
	if f == nil || f.DB == nil {
		return nil, nil
	}
	var raw string
	err := f.DB.QueryRowContext(ctx, `SELECT weights::text FROM rec_models WHERE profile_id=$1`, profileID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var model Model
	if err := json.Unmarshal([]byte(raw), &model); err != nil {
		return nil, err
	}
	return &model, nil
}
