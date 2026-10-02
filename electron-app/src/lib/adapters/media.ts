// Card and Detail are the shapes the pages render; detailFromBackendTitle maps
// the server title detail onto Detail.
export type Card = {
  catalogId?: string;
  providerIds?: Record<string, string>;
  id: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  rating?: number | null;
  tmdbRatingPct?: number | null;
  tmdbPopularity?: number | null;
  originalLanguage?: string;
  isNew?: boolean;
  genreIds?: number[];
  sourceProvider?: 'tmdb' | 'anilist';
  sourceKind?: 'movie' | 'tv' | 'anime';
  sourceLabel?: string;
  malId?: number | null;
  /** Provider release format (tv, movie, ova, ona, special). */
  format?: string;
  popularity?: number;
};

export type Detail = {
  id: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  // Transparent title logo (TMDb images) — the player's buffering overlay
  // reveals it left-to-right with real buffering progress (Stremio-style).
  logoUrl?: string | null;
  genres?: string[];
  runtime?: number | null;
  cast?: { name: string; character?: string }[];
  trailerKey?: string | null;
  imdbId?: string | undefined;
  originalLanguage?: string;
  tmdbPopularity?: number | null;
  tmdbRatingPct?: number | null;
  rating?: number | null;
  imdbRating?: number | null;
  imdbVotes?: number | null;
  altTitles?: string[];
  tagline?: string | null;
  releaseDate?: string | null;
  status?: string | null;
  directors?: string[];
  writers?: string[];
  networks?: string[];
  totalEpisodes?: number | null;
  malId?: number | null;
};

export type BackendTitleDetail = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  artwork?: Record<string, string>;
  providerIds?: Record<string, string>;
  imdbId?: string;
  mergedFrom?: string[];
  runtime?: number;
  genres?: string[];
  externalLinks?: Record<string, string>;
  ratings?: { imdb?: { rating?: number; votes?: number; imdbId?: string } };
  seasons?: Array<{ number: number; name?: string; episodeCount?: number; airDate?: string; poster?: string }>;
  altTitles?: string[];
};

// detailFromBackendTitle maps the BFF title detail onto the renderer Detail
// shape (T042.3). Fields the backend contract does not supply (cast, tagline,
// directors, networks, trailer keys) stay unknown instead of being invented.
export function detailFromBackendTitle(row: BackendTitleDetail): Detail {
  const providerIds = row.providerIds ?? {};
  const canonical = row.type === 'anime' && providerIds.anilist
    ? 'anilist'
    : (row.mergedFrom?.[0] ?? row.id.split(':', 1)[0] ?? 'tmdb');
  // M3.1.1: tmdb external ids are media-qualified ("tv:209867"); strip the
  // qualifier for the numeric display id. Non-tmdb values pass through.
  const rawExternal = providerIds[canonical] ?? row.id.split(':').slice(1).join(':');
  const qualified = /^(movie|tv):(\d+)$/.exec(rawExternal ?? '');
  const externalID = qualified ? qualified[2] : rawExternal;
  const numericID = /^\d+$/.test(externalID ?? '') ? Number(externalID) : 0;
  const imdbRating = typeof row.ratings?.imdb?.rating === 'number' ? row.ratings.imdb.rating : null;
  const totalEpisodes = (row.seasons ?? []).reduce((sum, season) => sum + (season.episodeCount ?? 0), 0);
  return {
    id: numericID,
    title: row.title ?? '',
    year: row.year,
    overview: row.overview,
    posterUrl: row.artwork?.poster ?? null,
    backdropUrl: row.artwork?.background ?? null,
    logoUrl: row.artwork?.logo ?? null,
    genres: Array.isArray(row.genres) ? row.genres.filter((genre): genre is string => Boolean(genre)) : [],
    runtime: typeof row.runtime === 'number' && row.runtime > 0 ? row.runtime : null,
    cast: [],
    trailerKey: null,
    imdbId: row.imdbId || providerIds.imdb || undefined,
    tmdbPopularity: null,
    tmdbRatingPct: null,
    rating: null,
    imdbRating,
    imdbVotes: typeof row.ratings?.imdb?.votes === 'number' ? row.ratings.imdb.votes : null,
    // Torrent search fans out over these: anime indexers file releases under
    // the romaji/original title, not the localized display title. Merge the
    // backend's altTitles with the original title, deduped.
    altTitles: Array.from(new Set([
      ...(Array.isArray(row.altTitles) ? row.altTitles.filter((t): t is string => Boolean(t)) : []),
      ...(row.originalTitle ? [row.originalTitle] : []),
    ])),
    totalEpisodes: totalEpisodes > 0 ? totalEpisodes : null,
    malId: providerIds.jikan ? Number(providerIds.jikan) : null,
  };
}
