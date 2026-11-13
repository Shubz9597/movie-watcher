package recommendations

import (
	"context"
	"log"
	"time"

	"torrent-streamer/internal/profiles"
)

type modelEntry struct {
	model  *Model
	loaded time.Time
}

// modelFor returns the profile's learned model (nil: the prior), re-read at
// most every 10 minutes.
func (s *Service) modelFor(ctx context.Context, profileID string) *Model {
	if s.feedback == nil {
		return nil
	}
	s.modelMu.Lock()
	entry, ok := s.models[profileID]
	s.modelMu.Unlock()
	if ok && s.now().Sub(entry.loaded) < 10*time.Minute {
		return entry.model
	}
	model, err := s.feedback.LoadModel(ctx, profileID)
	if err != nil {
		log.Printf("[recommendations] model for %s: %v", profileID, err)
		return entry.model
	}
	s.setModel(profileID, model)
	return model
}

func (s *Service) setModel(profileID string, model *Model) {
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	if s.models == nil {
		s.models = map[string]modelEntry{}
	}
	s.models[profileID] = modelEntry{model: model, loaded: s.now()}
}

// Learns reports whether this server records what happens to
// recommendations.
func (s *Service) Learns() bool { return s != nil && s.feedback != nil }

// Seen records the request's profile seeing these cards (position: their
// place in the row), with the features they were ranked by.
func (s *Service) Seen(ctx context.Context, ids []string, positions []int) error {
	if s.feedback == nil {
		return nil
	}
	profileID := profiles.From(ctx).ID
	s.mu.Lock()
	var known map[string]Features
	if entry := s.stale[profileID]; entry != nil {
		known = entry.result.features
	}
	s.mu.Unlock()
	features := make([]Features, len(ids))
	for i, id := range ids {
		features[i] = known[id]
	}
	return s.feedback.Seen(ctx, profileID, ids, positions, features)
}

// NotInterested records (undo: removes) the request's profile turning a
// title down. It leaves the cached recommendations at once and the rest are
// recomputed in the background.
func (s *Service) NotInterested(ctx context.Context, id, title string, undo bool) error {
	profile := profiles.From(ctx)
	if err := s.feedback.SetNotInterested(ctx, profile.ID, id, title, undo); err != nil {
		return err
	}
	s.mu.Lock()
	for _, entries := range []map[string]*cacheEntry{s.cache, s.stale} {
		entry := entries[profile.ID]
		if entry == nil || undo {
			continue
		}
		kept := make([]Item, 0, len(entry.result.Items))
		for _, item := range entry.result.Items {
			if item.CanonicalID != id {
				kept = append(kept, item)
			}
		}
		updated := *entry
		updated.result.Items = kept
		entries[profile.ID] = &updated
	}
	// The taste changed: the next load recomputes.
	if entry := s.cache[profile.ID]; entry != nil {
		updated := *entry
		updated.taste = ""
		s.cache[profile.ID] = &updated
	}
	s.mu.Unlock()
	if revision, err := s.library.Revision(ctx); err == nil {
		s.refreshInBackground(profile, revision)
	}
	return nil
}

// Stats sums what came of the request's profile's recommendations.
func (s *Service) Stats(ctx context.Context, days int) (Stats, error) {
	if s.feedback == nil {
		return Stats{Days: days}, nil
	}
	return s.feedback.Stats(ctx, profiles.From(ctx).ID, days, s.now())
}

// Train fits the profile's model on what came of its recommendations so far
// (too few outcomes: it keeps the prior).
func (s *Service) Train(ctx context.Context, profileID string) (*Model, error) {
	if s.feedback == nil {
		return nil, nil
	}
	samples, err := s.feedback.Samples(ctx, profileID, s.now())
	if err != nil {
		return nil, err
	}
	model := Train(samples, s.now())
	if err := s.feedback.SaveModel(ctx, profileID, model); err != nil {
		return nil, err
	}
	s.setModel(profileID, model)
	if model != nil {
		log.Printf("[recommendations] profile %s: trained on %d outcome(s), %d wanted, fit %.2f", profileID, model.Samples, model.Positives, model.AUC)
	}
	return model, nil
}

// TrainLoop retrains every profile now and then (first after a minute).
func (s *Service) TrainLoop(ctx context.Context, list func(context.Context) []profiles.Profile, interval time.Duration) {
	if s.feedback == nil {
		return
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		for _, profile := range list(ctx) {
			trainCtx, cancel := context.WithTimeout(ctx, time.Minute)
			if _, err := s.Train(trainCtx, profile.ID); err != nil {
				log.Printf("[recommendations] training for %s: %v", profile.ID, err)
			}
			cancel()
		}
		timer.Reset(interval)
	}
}

// ContentChanged marks every cached result out of date (new title
// embeddings arrived): the next load serves it once more and recomputes.
func (s *Service) ContentChanged() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, entry := range s.cache {
		updated := *entry
		updated.computedAt = time.Time{}
		s.cache[id] = &updated
	}
}
