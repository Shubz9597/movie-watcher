package catalog

import (
	"context"
	"strings"
)

// imdbReverseLinks finds a title by its IMDb id (SQLIDLinks).
type imdbReverseLinks interface {
	CanonicalForIMDb(ctx context.Context, imdb string) (string, bool)
}

// TitleForIMDb maps an IMDb id (as Stremio names titles) to the id this
// catalog uses for it: the linked title when one is known, else the TMDb id
// Cinemeta lists (remembered as a link), else "imdb:<id>", which the
// catalog also serves. kind is Stremio's "movie" or "series".
func (s *Service) TitleForIMDb(ctx context.Context, imdb, kind string) string {
	imdb = strings.TrimSpace(imdb)
	if !strings.HasPrefix(imdb, "tt") {
		return ""
	}
	if links, ok := s.options.Links.(imdbReverseLinks); ok {
		if id, found := links.CanonicalForIMDb(ctx, imdb); found {
			return id
		}
	}
	if kind != "movie" {
		kind = "series"
	}
	for _, provider := range s.providers {
		cinemeta, ok := provider.(*Cinemeta)
		if !ok {
			continue
		}
		meta, err := cinemeta.fetchMeta(ctx, imdb, kind)
		if err != nil {
			break
		}
		tmdb := cinemetaTMDbID(meta)
		if tmdb == "" {
			break
		}
		id := "tmdb:" + tmdb
		if s.options.Links != nil {
			link, known := s.options.Links.GetLink(ctx, id)
			if !known {
				link = IDLink{ProviderIDs: map[string]string{}, Type: TypeSeries, Title: meta.Meta.Name, Year: yearFromReleaseInfo(meta.Meta.ReleaseInfo)}
				if kind == "movie" {
					link.Type = TypeMovie
				}
			}
			// A known title keeps its type and names (an anime stays anime);
			// it gains the IMDb id.
			link.ProviderIDs["imdb"], link.ProviderIDs["tmdb"] = imdb, tmdb
			s.options.Links.PutLink(ctx, id, link)
		}
		return id
	}
	return "imdb:" + imdb
}

// StremioTitle is how Stremio names a title: its IMDb id, display name,
// kind ("movie" or "series") and poster.
type StremioTitle struct {
	IMDb   string
	Name   string
	Kind   string
	Poster string
}

// StremioTitle describes a catalog title for Stremio (ok false: unknown).
func (s *Service) StremioTitle(ctx context.Context, id string) (StremioTitle, bool) {
	if imdb, found := strings.CutPrefix(id, "imdb:"); found && strings.HasPrefix(imdb, "tt") {
		out := StremioTitle{IMDb: imdb, Kind: "series"}
		if result := s.Detail(ctx, id); result.Found {
			out.Name, out.Poster = result.Title.Title, result.Title.Artwork["poster"]
			if result.Title.Type == TypeMovie {
				out.Kind = "movie"
			}
		}
		return out, true
	}
	result := s.Detail(ctx, id)
	if !result.Found {
		return StremioTitle{}, false
	}
	out := StremioTitle{IMDb: strings.TrimSpace(result.Title.IMDBID), Name: result.Title.Title, Kind: "series", Poster: result.Title.Artwork["poster"]}
	if result.Title.Type == TypeMovie {
		out.Kind = "movie"
	}
	return out, true
}
