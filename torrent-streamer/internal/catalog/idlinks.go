package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"maps"
	"sync"
)

// IDLink is what the catalog remembers about a title id across restarts: the
// provider ids that resolved it (e.g. tmdb tv:13916 and imdb tt0877057) and
// the title's type and format. A later request can then ask every provider
// at once, so a title still resolves when one provider is unreachable, and a
// result built from another provider keeps this title's own id, type and
// format.
type IDLink struct {
	ProviderIDs map[string]string
	Type        TitleType
	Format      string
	// Title and Year as the title's own provider names them.
	Title string
	Year  int
}

// IDLinks stores IDLinks by canonical title id. Failures are not fatal: the
// catalog then behaves as without links.
type IDLinks interface {
	GetLink(ctx context.Context, canonicalID string) (IDLink, bool)
	PutLink(ctx context.Context, canonicalID string, link IDLink)
}

// MemoryIDLinks keeps links in process memory (tests, or no database).
type MemoryIDLinks struct {
	mu    sync.Mutex
	links map[string]IDLink
}

func (m *MemoryIDLinks) GetLink(_ context.Context, canonicalID string) (IDLink, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	link, ok := m.links[canonicalID]
	if ok {
		link.ProviderIDs = maps.Clone(link.ProviderIDs)
	}
	return link, ok
}

func (m *MemoryIDLinks) PutLink(_ context.Context, canonicalID string, link IDLink) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.links == nil {
		m.links = map[string]IDLink{}
	}
	link.ProviderIDs = maps.Clone(link.ProviderIDs)
	m.links[canonicalID] = link
}

// SQLIDLinks keeps links in Postgres (table catalog_id_links), fronted by a
// memory copy so repeat lookups cost nothing.
type SQLIDLinks struct {
	DB     *sql.DB
	memory MemoryIDLinks
}

func (s *SQLIDLinks) GetLink(ctx context.Context, canonicalID string) (IDLink, bool) {
	if link, ok := s.memory.GetLink(ctx, canonicalID); ok {
		return link, true
	}
	var raw []byte
	var link IDLink
	var kind string
	err := s.DB.QueryRowContext(ctx,
		`SELECT provider_ids, title_type, title_format, title_name, title_year FROM catalog_id_links WHERE canonical_id=$1`,
		canonicalID).Scan(&raw, &kind, &link.Format, &link.Title, &link.Year)
	if err != nil || json.Unmarshal(raw, &link.ProviderIDs) != nil || len(link.ProviderIDs) == 0 {
		return IDLink{}, false
	}
	link.Type = TitleType(kind)
	s.memory.PutLink(ctx, canonicalID, link)
	return link, true
}

func (s *SQLIDLinks) PutLink(ctx context.Context, canonicalID string, link IDLink) {
	if existing, ok := s.memory.GetLink(ctx, canonicalID); ok && maps.Equal(existing.ProviderIDs, link.ProviderIDs) &&
		existing.Type == link.Type && existing.Format == link.Format && existing.Title == link.Title && existing.Year == link.Year {
		return // unchanged: no write
	}
	raw, err := json.Marshal(link.ProviderIDs)
	if err != nil {
		return
	}
	_, err = s.DB.ExecContext(ctx, `
INSERT INTO catalog_id_links (canonical_id, provider_ids, title_type, title_format, title_name, title_year, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (canonical_id) DO UPDATE SET provider_ids=EXCLUDED.provider_ids,
  title_type=EXCLUDED.title_type, title_format=EXCLUDED.title_format,
  title_name=EXCLUDED.title_name, title_year=EXCLUDED.title_year, updated_at=now()`,
		canonicalID, raw, string(link.Type), link.Format, link.Title, link.Year)
	if err == nil {
		s.memory.PutLink(ctx, canonicalID, link)
	}
}
