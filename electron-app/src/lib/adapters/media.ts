// Data adapters - copied from Next.js to transform API responses
export type Card = {
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
};

export type Detail = {
  id: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
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

const tmdbImg = (p?: string | null, size: 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w342') =>
  p ? `https://image.tmdb.org/t/p/${size}${p}` : null;

function animeLanguageFromCountry(country?: string | null): string | undefined {
  const normalized = country?.trim().toLocaleUpperCase();
  if (normalized === 'JP') return 'ja';
  if (normalized === 'CN' || normalized === 'TW') return 'zh';
  if (normalized === 'KR') return 'ko';
  return normalized?.toLocaleLowerCase() || undefined;
}

type TmdbMovieItem = {
  id: number;
  title?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genre_ids?: number[];
};

type TmdbTvItem = {
  id: number;
  name?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genre_ids?: number[];
};

type AniListAnimeItem = {
  id: number;
  idMal?: number | null;
  title?: {
    english?: string | null;
    romaji?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  };
  synonyms?: string[] | null;
  format?: string | null;
  status?: string | null;
  description?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  episodes?: number | null;
  duration?: number | null;
  countryOfOrigin?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null } | null;
  bannerImage?: string | null;
  genres?: string[] | null;
  averageScore?: number | null;
  popularity?: number | null;
  trailer?: { id?: string | null; site?: string | null } | null;
  externalLinks?: Array<{ site?: string | null; url?: string | null }> | null;
};

type JikanAnimeItem = {
  mal_id?: number;
  title?: string;
  title_english?: string;
  title_japanese?: string;
  title_synonyms?: string[];
  titles?: Array<{ title?: string }>;
  type?: string;
  episodes?: number | null;
  duration?: string | null;
  status?: string | null;
  synopsis?: string | null;
  score?: number | null;
  aired?: { from?: string | null };
  images?: {
    jpg?: { image_url?: string | null; large_image_url?: string | null };
    webp?: { image_url?: string | null; large_image_url?: string | null };
  };
  trailer?: {
    youtube_id?: string | null;
    images?: { maximum_image_url?: string | null };
  };
  genres?: Array<{ name?: string }>;
  explicit_genres?: Array<{ name?: string }>;
  themes?: Array<{ name?: string }>;
  studios?: Array<{ name?: string }>;
  external?: Array<{ name?: string; url?: string }>;
};

type TmdbMovieDetail = {
  id: number;
  title?: string;
  release_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genres?: Array<{ name?: string }>;
  runtime?: number;
  credits?: {
    cast?: Array<{ name?: string; character?: string }>;
    crew?: Array<{ name?: string; job?: string }>;
  };
  videos?: { results?: Array<{ type?: string; site?: string; key?: string }> };
  external_ids?: { imdb_id?: string | null };
  tagline?: string | null;
  status?: string | null;
};

type TmdbTvDetail = {
  id: number;
  name?: string;
  first_air_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genres?: Array<{ name?: string }>;
  episode_run_time?: number[];
  credits?: {
    cast?: Array<{ name?: string; character?: string }>;
    crew?: Array<{ name?: string; job?: string }>;
  };
  videos?: { results?: Array<{ type?: string; site?: string; key?: string }> };
  external_ids?: { imdb_id?: string | null };
  tagline?: string | null;
  status?: string | null;
  networks?: Array<{ name?: string }>;
  number_of_episodes?: number | null;
};

export function cardFromTmdbMovie(it: TmdbMovieItem): Card {
  const vote = typeof it.vote_average === 'number' ? it.vote_average : null;
  return {
    id: it.id,
    title: it.title ?? '',
    year: it.release_date ? Number(String(it.release_date).slice(0, 4)) : undefined,
    posterPath: tmdbImg(it.poster_path, 'w342'),
    backdropUrl: tmdbImg(it.backdrop_path, 'w780'),
    overview: it.overview,
    rating: vote,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    tmdbPopularity: typeof it.popularity === 'number' ? it.popularity : null,
    originalLanguage: it.original_language,
    genreIds: Array.isArray(it.genre_ids) ? it.genre_ids : [],
    sourceProvider: 'tmdb',
    sourceKind: 'movie',
    sourceLabel: 'TMDB',
    isNew: !!it.release_date && new Date(it.release_date) > new Date(Date.now() - 30 * 864e5),
  };
}

export function cardFromTmdbTv(it: TmdbTvItem): Card {
  const vote = typeof it.vote_average === 'number' ? it.vote_average : null;
  return {
    id: it.id,
    title: it.name ?? '',
    year: it.first_air_date ? Number(String(it.first_air_date).slice(0, 4)) : undefined,
    posterPath: tmdbImg(it.poster_path, 'w342'),
    backdropUrl: tmdbImg(it.backdrop_path, 'w780'),
    overview: it.overview,
    rating: vote,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    tmdbPopularity: typeof it.popularity === 'number' ? it.popularity : null,
    originalLanguage: it.original_language,
    genreIds: Array.isArray(it.genre_ids) ? it.genre_ids : [],
    sourceProvider: 'tmdb',
    sourceKind: 'tv',
    sourceLabel: 'TMDB',
    isNew: !!it.first_air_date && new Date(it.first_air_date) > new Date(Date.now() - 30 * 864e5),
  };
}

export function cardFromAniList(anime: AniListAnimeItem): Card {
  const score = typeof anime.averageScore === 'number' ? anime.averageScore : null;

  return {
    id: anime.id,
    title: anime.title?.english || anime.title?.userPreferred || anime.title?.romaji || anime.title?.native || '',
    year: anime.startDate?.year || undefined,
    posterPath: anime.coverImage?.large || anime.coverImage?.extraLarge || anime.coverImage?.medium || null,
    backdropUrl: anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || null,
    overview: cleanAnimeDescription(anime.description),
    rating: score != null ? score / 10 : null,
    tmdbRatingPct: score,
    tmdbPopularity: typeof anime.popularity === 'number' ? anime.popularity : null,
    originalLanguage: animeLanguageFromCountry(anime.countryOfOrigin),
    genreIds: [16],
    sourceProvider: 'anilist',
    sourceKind: 'anime',
    sourceLabel: 'AniList',
    malId: anime.idMal ?? null,
    isNew: Boolean(anime.startDate?.year && anime.startDate?.month && anime.startDate?.day &&
      new Date(anime.startDate.year, anime.startDate.month - 1, anime.startDate.day) > new Date(Date.now() - 30 * 864e5)),
  };
}

export function detailFromTmdbMovie(it: Record<string, unknown> & { id: number }): Detail {
  const typedIt = it as TmdbMovieDetail;
  const trailer = Array.isArray(typedIt.videos?.results)
    ? typedIt.videos.results.find((v) => (v.type === 'Trailer' || v.type === 'Teaser') && v.site === 'YouTube')
    : null;
  const vote = typeof typedIt.vote_average === 'number' ? typedIt.vote_average : null;
  
  // Extract directors and writers from credits
  const crew = Array.isArray(typedIt.credits?.crew) ? typedIt.credits.crew : [];
  const directors = crew
    .filter((c) => c.job === 'Director')
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));
  const writers = crew
    .filter((c) => c.job && ['Writer', 'Screenplay', 'Story'].includes(c.job))
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));

  return {
    id: typedIt.id,
    title: typedIt.title ?? '',
    year: typedIt.release_date ? Number(String(typedIt.release_date).slice(0, 4)) : undefined,
    overview: typedIt.overview,
    posterUrl: tmdbImg(typedIt.poster_path, 'w500'),
    backdropUrl: tmdbImg(typedIt.backdrop_path, 'w1280'),
    genres: Array.isArray(typedIt.genres) ? typedIt.genres.map((g) => g.name).filter((n): n is string => Boolean(n)) : [],
    runtime: typeof typedIt.runtime === 'number' ? typedIt.runtime : null,
    cast: Array.isArray(typedIt.credits?.cast)
      ? typedIt.credits.cast.slice(0, 16).map((c) => ({ name: c.name ?? '', character: c.character }))
      : [],
    trailerKey: trailer?.key ?? null,
    imdbId: typedIt.external_ids?.imdb_id || undefined,
    originalLanguage: typedIt.original_language,
    tmdbPopularity: typeof typedIt.popularity === 'number' ? typedIt.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
    tagline: typedIt.tagline || null,
    releaseDate: typedIt.release_date || null,
    status: typedIt.status || null,
    directors,
    writers,
  };
}

export function detailFromTmdbTv(it: Record<string, unknown> & { id: number }): Detail {
  const typedIt = it as TmdbTvDetail;
  const trailer = Array.isArray(typedIt.videos?.results)
    ? typedIt.videos.results.find((v) => (v.type === 'Trailer' || v.type === 'Teaser') && v.site === 'YouTube')
    : null;
  const vote = typeof typedIt.vote_average === 'number' ? typedIt.vote_average : null;
  
  const crew = Array.isArray(typedIt.credits?.crew) ? typedIt.credits.crew : [];
  const directors = crew
    .filter((c) => c.job === 'Director')
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));
  const writers = crew
    .filter((c) => c.job && ['Writer', 'Screenplay', 'Story'].includes(c.job))
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));

  return {
    id: typedIt.id,
    title: typedIt.name ?? '',
    year: typedIt.first_air_date ? Number(String(typedIt.first_air_date).slice(0, 4)) : undefined,
    overview: typedIt.overview,
    posterUrl: tmdbImg(typedIt.poster_path, 'w500'),
    backdropUrl: tmdbImg(typedIt.backdrop_path, 'w1280'),
    genres: Array.isArray(typedIt.genres) ? typedIt.genres.map((g) => g.name).filter((n): n is string => Boolean(n)) : [],
    runtime:
      Array.isArray(typedIt.episode_run_time) && typedIt.episode_run_time.length
        ? Number(typedIt.episode_run_time[0])
        : null,
    cast: Array.isArray(typedIt.credits?.cast)
      ? typedIt.credits.cast.slice(0, 16).map((c) => ({ name: c.name ?? '', character: c.character }))
      : [],
    trailerKey: trailer?.key ?? null,
    imdbId: typedIt.external_ids?.imdb_id || undefined,
    originalLanguage: typedIt.original_language,
    tmdbPopularity: typeof typedIt.popularity === 'number' ? typedIt.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
    tagline: typedIt.tagline || null,
    releaseDate: typedIt.first_air_date || null,
    status: typedIt.status || null,
    directors,
    writers,
    networks: Array.isArray(typedIt.networks) ? typedIt.networks.map((n) => n.name).filter((n): n is string => Boolean(n)) : [],
    totalEpisodes: typeof typedIt.number_of_episodes === 'number' ? typedIt.number_of_episodes : null,
  };
}

function collectAniListTitles(anime: Partial<AniListAnimeItem>): string[] {
  const titles = new Set<string>();
  const add = (val?: string | null) => {
    if (!val) return;
    const trimmed = val.trim();
    if (trimmed) titles.add(trimmed);
  };
  add(anime.title?.english);
  add(anime.title?.userPreferred);
  add(anime.title?.romaji);
  add(anime.title?.native);
  for (const synonym of anime.synonyms || []) add(synonym);
  return Array.from(titles);
}

function cleanAnimeDescription(description?: string | null): string {
  return (description || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/~!|!~/g, '')
    .replace(/\s*\[Written by MAL Rewrite\]\s*$/i, '')
    .replace(/\s*\(Source:\s*[^)]+\)\s*$/i, '')
    .trim();
}

function collectJikanTitles(anime: Partial<JikanAnimeItem>): string[] {
  const titles = new Set<string>();
  const add = (value?: string | null) => {
    const trimmed = value?.trim();
    if (trimmed) titles.add(trimmed);
  };
  add(anime.title);
  add(anime.title_english);
  add(anime.title_japanese);
  for (const title of anime.titles || []) add(title.title);
  for (const synonym of anime.title_synonyms || []) add(synonym);
  return Array.from(titles);
}

function runtimeMinutes(duration?: string | null): number | null {
  if (!duration) return null;
  const hours = Number(duration.match(/(\d+)\s*hr/i)?.[1] || 0);
  const minutes = Number(duration.match(/(\d+)\s*min/i)?.[1] || 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

function imdbIDFromLinks(links?: Array<{ name?: string | null; site?: string | null; url?: string | null }> | null) {
  for (const link of links || []) {
    if (!/imdb/i.test(link.name || link.site || link.url || '')) continue;
    const match = link.url?.match(/\b(tt\d+)\b/i);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

export function detailFromJikan(anime: Partial<JikanAnimeItem>): Detail {
  const score = typeof anime.score === 'number' && anime.score > 0 ? anime.score : null;
  const genreNames = [...(anime.genres || []), ...(anime.explicit_genres || []), ...(anime.themes || [])]
    .map((genre) => genre.name)
    .filter((name): name is string => Boolean(name));
  return {
    id: anime.mal_id || 0,
    title: anime.title_english || anime.title || '',
    year: anime.aired?.from ? new Date(anime.aired.from).getFullYear() : undefined,
    posterUrl: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url ||
      anime.images?.webp?.image_url || anime.images?.jpg?.image_url || null,
    backdropUrl: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
    overview: cleanAnimeDescription(anime.synopsis),
    genres: Array.from(new Set(genreNames)),
    runtime: runtimeMinutes(anime.duration),
    cast: [],
    trailerKey: anime.trailer?.youtube_id || null,
    imdbId: imdbIDFromLinks(anime.external),
    originalLanguage: 'ja',
    tmdbPopularity: null,
    tmdbRatingPct: score != null ? Math.round(score * 10) : null,
    rating: score,
    imdbRating: null,
    imdbVotes: null,
    altTitles: collectJikanTitles(anime),
    status: anime.status || null,
    networks: (anime.studios || []).map((studio) => studio.name).filter((name): name is string => Boolean(name)),
    totalEpisodes: anime.episodes ?? null,
    malId: anime.mal_id ?? null,
  };
}

export function detailFromAniList(anime: Partial<AniListAnimeItem> & { id: number }): Detail {
  const score = typeof anime.averageScore === 'number' ? anime.averageScore : null;
  const altTitles = collectAniListTitles(anime);
  const overview = cleanAnimeDescription(anime.description);
  return {
    id: anime.id,
    title: anime.title?.english || anime.title?.userPreferred || anime.title?.romaji || anime.title?.native || '',
    year: anime.startDate?.year || undefined,
    posterUrl: anime.coverImage?.extraLarge || anime.coverImage?.large || anime.coverImage?.medium || null,
    backdropUrl: anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || null,
    overview,
    genres: (anime.genres || []).filter((genre): genre is string => Boolean(genre)),
    runtime: anime.duration ?? null,
    cast: [],
    trailerKey: anime.trailer?.site?.toLocaleLowerCase() === 'youtube' ? anime.trailer.id || null : null,
    imdbId: imdbIDFromLinks(anime.externalLinks),
    originalLanguage: animeLanguageFromCountry(anime.countryOfOrigin),
    tmdbPopularity: typeof anime.popularity === 'number' ? anime.popularity : null,
    tmdbRatingPct: score,
    rating: score != null ? score / 10 : null,
    imdbRating: null,
    imdbVotes: null,
    altTitles,
    status: anime.status || null,
    totalEpisodes: anime.episodes ?? null,
    malId: anime.idMal ?? null,
  };
}



