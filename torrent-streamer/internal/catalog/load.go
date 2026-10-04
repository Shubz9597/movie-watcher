package catalog

import (
	"context"
	"errors"
	"strconv"
	"sync"

	"golang.org/x/sync/singleflight"
)

type providerReply struct {
	value any
	err   error
	stale bool
}

type providerFailure struct{ err error }

// Close cancels and joins shared loads and stale-cache refreshes. An operation
// can outlive one disconnected caller, but cannot outlive the service.
func (s *Service) Close() {
	s.workMu.Lock()
	s.closed = true
	for _, cancel := range s.cancels {
		cancel()
	}
	s.workMu.Unlock()
	s.work.Wait()
}

func (s *Service) ownedCall(ctx context.Context, call func(context.Context) providerReply) providerReply {
	s.workMu.Lock()
	if s.closed {
		s.workMu.Unlock()
		return providerReply{err: context.Canceled}
	}
	// Singleflight work is shared across requests. A caller may cancel its wait
	// independently; the network call keeps its own short deadline and Close
	// owns cancellation on shutdown.
	callCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), min(s.options.ProviderTimeout, s.options.RequestTimeout))
	s.nextWork++
	id := s.nextWork
	s.cancels[id] = cancel
	s.work.Add(1)
	s.workMu.Unlock()
	defer func() {
		cancel()
		s.workMu.Lock()
		delete(s.cancels, id)
		s.workMu.Unlock()
		s.work.Done()
	}()
	return call(callCtx)
}

func (s *Service) failed(provider, key string) error {
	for _, candidate := range []string{"availability", key} {
		if value, state, ok := s.failures.Get(provider, candidate); ok && state == cacheStateFresh {
			return value.(providerFailure).err
		}
	}
	return nil
}

func (s *Service) fetchCached(ctx context.Context, provider, key string, fetch func(context.Context) (any, error)) providerReply {
	if value, state, ok := s.cache.Get(provider, key); ok {
		if state == cacheStateFresh {
			return providerReply{value: value}
		}
		if ctx.Err() == nil && s.failed(provider, key) == nil {
			s.fetchFlight(ctx, provider, key, fetch)
		}
		// Expiry never blocks a page on the upstream. Retain last-good data
		// while a single bounded refresh either replaces it or records failure.
		return providerReply{value: value, stale: true}
	}
	if err := ctx.Err(); err != nil {
		return providerReply{err: err}
	}
	if err := s.failed(provider, key); err != nil {
		return providerReply{err: err}
	}
	select {
	case result := <-s.fetchFlight(ctx, provider, key, fetch):
		reply := result.Val.(providerReply)
		reply.value = cloneCacheValue(reply.value)
		return reply
	case <-ctx.Done():
		return providerReply{err: ctx.Err()}
	}
}

func (s *Service) fetchFlight(ctx context.Context, provider, key string, fetch func(context.Context) (any, error)) <-chan singleflight.Result {
	// Each receiver gets its own mutable-field copies.
	return s.flights.DoChan(provider+"\x00"+key, func() (any, error) {
		if value, state, ok := s.cache.Get(provider, key); ok && state == cacheStateFresh {
			return providerReply{value: value}, nil
		}
		if err := s.failed(provider, key); err != nil {
			return providerReply{err: err}, nil
		}
		reply := s.ownedCall(ctx, func(callCtx context.Context) providerReply {
			// Eight concurrent network calls across all providers bound bursts
			// when several page rails or clients miss the cache together.
			select {
			case s.slots <- struct{}{}:
				defer func() { <-s.slots }()
			case <-callCtx.Done():
				return providerReply{err: callCtx.Err()}
			}
			value, err := fetch(callCtx)
			if err == nil {
				s.cache.Set(provider, key, value, s.options.CacheTTL)
			} else if !errors.Is(err, context.Canceled) {
				failureKey := "availability"
				var status *providerStatusError
				if errors.Is(err, ErrNotFound) || (errors.As(err, &status) && status.code < 500) {
					failureKey = key
				}
				ttl := s.options.FailureTTL
				var limited *rateLimitError
				if errors.As(err, &limited) {
					ttl = max(ttl, limited.retryAfter)
				}

				s.failures.Set(provider, failureKey, providerFailure{err: err}, ttl)
			}
			return providerReply{value: value, err: err}
		})
		return reply, nil
	})
}

// parallelReplies preserves provider priority by writing disjoint result slots
// and merging only after every worker exits. Responses never depend on arrival
// order, and one unavailable provider does not cancel its useful siblings.
func parallelReplies(count int, call func(int) providerReply) []providerReply {
	results := make([]providerReply, count)
	var workers sync.WaitGroup
	for i := range results {
		workers.Go(func() { results[i] = call(i) })
	}
	workers.Wait()
	return results
}

func (s *Service) rememberDetail(id string, result DetailResult) {
	if !result.Found {
		return
	}
	ttl := s.options.CacheTTL
	if len(result.DegradedProviders) > 0 {
		ttl = min(ttl, s.options.FailureTTL)
	}
	s.cache.Set("merged", "detail:"+id, result, ttl)
}

// refreshDetail has a shared owner so repeated stale reads do not fan out
// unbounded refreshes. It deliberately does not reserve a provider slot: its
// nested provider calls own those slots.
func (s *Service) refreshDetail(ctx context.Context, id string) {
	s.flights.DoChan("merged\x00detail:"+id, func() (any, error) {
		reply := s.ownedCall(ctx, func(callCtx context.Context) providerReply {
			result := s.computeDetail(callCtx, id)
			if !errors.Is(callCtx.Err(), context.Canceled) {
				s.rememberDetail(id, result)
			}
			return providerReply{value: result}
		})
		return reply, nil
	})
}

func mergedEpisodesKey(id string, season int) string {
	return "episodes:" + id + "\x00" + strconv.Itoa(season)
}

func (s *Service) rememberEpisodes(id string, season int, result EpisodeResult) {
	if len(result.Episodes) == 0 {
		return
	}
	ttl := s.options.CacheTTL
	if len(result.DegradedProviders) > 0 {
		ttl = min(ttl, s.options.FailureTTL)
	}
	s.cache.Set("merged", mergedEpisodesKey(id, season), result, ttl)
}

func (s *Service) refreshEpisodes(ctx context.Context, id string, season int) {
	s.flights.DoChan("merged\x00"+mergedEpisodesKey(id, season), func() (any, error) {
		reply := s.ownedCall(ctx, func(callCtx context.Context) providerReply {
			result := s.computeEpisodes(callCtx, id, season)
			if !errors.Is(callCtx.Err(), context.Canceled) {
				s.rememberEpisodes(id, season, result)
			}
			return providerReply{value: result}
		})
		return reply, nil
	})
}
