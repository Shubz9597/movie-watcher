import Link from "next/link";
import { notFound } from "next/navigation";
import { detailFromTmdbMovie, detailFromTmdbTv, detailFromJikan, type Detail as MediaDetail } from "@/lib/adapters/media";
import { tmdb } from "@/lib/services/tmbd-service";
import { getImdbRating } from "@/lib/imdb/sqlite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink, Youtube } from "lucide-react";
import EpisodePanel from "@/components/title/episode-panel";
import TorrentPanel from "@/components/title/torrent-panel";
import type { EpisodeSummary, SeasonSummary } from "@/lib/title-types";

type Kind = "movie" | "tv" | "anime";

type TitlePayload = {
  kind: Kind;
  detail: MediaDetail & {
    tagline?: string | null;
    releaseDate?: string | null;
    status?: string | null;
    directors?: string[];
    writers?: string[];
    networks?: string[];
    totalEpisodes?: number | null;
  };
  seasons?: SeasonSummary[];
  initialSeason?: number;
  initialEpisodes?: EpisodeSummary[];
  seasonApiBase?: string | null;
  /** True if this is an anime movie (not a TV series) */
  isAnimeMovie?: boolean;
  /** Anime type from Jikan: "Movie", "TV", "OVA", "ONA", "Special", "Music" */
  animeType?: string | null;
};

const TMDB_IMG = (path?: string | null, size: "w342" | "w500" | "w1280" = "w500") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

type CrewMember = { job?: string | null; name?: string | null };
type CreditsBlock = { crew?: CrewMember[] };
type SeasonBlock = {
  season_number: number;
  name?: string | null;
  episode_count?: number | null;
  air_date?: string | null;
  poster_path?: string | null;
};
type NetworkBlock = { name?: string | null };

type TmdbMovieExtras = {
  id: number;
  tagline?: string | null;
  release_date?: string | null;
  status?: string | null;
  credits?: CreditsBlock;
};

type TmdbTvExtras = Omit<TmdbMovieExtras, 'release_date'> & {
  seasons?: SeasonBlock[];
  networks?: NetworkBlock[];
  first_air_date?: string | null;
  number_of_episodes?: number | null;
};

type SeasonEpisode = {
  id: number;
  name: string;
  overview?: string | null;
  still_path?: string | null;
  episode_number: number;
  season_number: number;
  air_date?: string | null;
  runtime?: number | null;
};

type SeasonResponse = {
  episodes?: SeasonEpisode[];
};

type JikanAnimeDetail = {
  type?: string | null; // "Movie", "TV", "OVA", "ONA", "Special", "Music"
  theme?: { openings?: string[] };
  aired?: { from?: string | null };
  status?: string | null;
  episodes?: number | null;
  duration?: string | null; // e.g., "1 hr 46 min" for movies
  images?: { jpg?: { image_url?: string | null } };
};

type JikanEpisode = {
  mal_id: number;
  title?: string | null;
  synopsis?: string | null;
  discussion_url?: string | null;
  images?: { jpg?: { image_url?: string | null } };
  aired?: string | null;
  duration?: number | null;
};

type JikanDetailResponse = { data: JikanAnimeDetail };
type JikanEpisodesPayload = { data?: JikanEpisode[] };

const isKind = (value: string): value is Kind => value === "movie" || value === "tv" || value === "anime";

const languageFormatter = typeof Intl !== "undefined" && "DisplayNames" in Intl
  ? new Intl.DisplayNames(["en"], { type: "language" })
  : null;

const formatRuntime = (minutes?: number | null) => {
  if (!minutes) return null;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hrs) return `${mins}m`;
  if (!mins) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
};

const formatDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const formatNumber = (n?: number | null) => {
  if (typeof n !== "number") return null;
  return n.toLocaleString();
};

async function fetchMovie(id: number): Promise<TitlePayload> {
  const raw = await tmdb<TmdbMovieExtras & Record<string, unknown>>(`/movie/${id}?append_to_response=external_ids,credits,videos`);
  const detail = detailFromTmdbMovie(raw);

  if (detail.imdbId) {
    const imdb = getImdbRating(detail.imdbId);
    if (imdb) {
      detail.imdbRating = imdb.rating;
      detail.imdbVotes = imdb.votes;
    }
  }

  return {
    kind: "movie",
    detail: {
      ...detail,
      tagline: raw.tagline || null,
      releaseDate: raw.release_date || null,
      status: raw.status || null,
      directors: extractCrew(raw?.credits?.crew, ["Director"]),
      writers: extractCrew(raw?.credits?.crew, ["Writer", "Screenplay", "Story"]),
    },
  };
}

async function fetchTv(id: number): Promise<TitlePayload> {
  const raw = await tmdb<TmdbTvExtras & Record<string, unknown>>(`/tv/${id}?append_to_response=external_ids,credits,videos`);
  const detail = detailFromTmdbTv(raw);

  if (detail.imdbId) {
    const imdb = getImdbRating(detail.imdbId);
    if (imdb) {
      detail.imdbRating = imdb.rating;
      detail.imdbVotes = imdb.votes;
    }
  }

  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons
        .filter((s) => s.season_number >= 0 && (s.episode_count ?? 0) > 0)
        .sort((a, b) => a.season_number - b.season_number)
        .map(
          (s): SeasonSummary => ({
            seasonNumber: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episodeCount: s.episode_count ?? undefined,
            airDate: s.air_date,
            posterUrl: TMDB_IMG(s.poster_path, "w342"),
          })
        )
    : [];

  const initialSeason = seasons[0]?.seasonNumber ?? 1;
  const initialEpisodes = await fetchTvSeasonEpisodes(id, initialSeason);

  return {
    kind: "tv",
    detail: {
      ...detail,
      tagline: raw.tagline || null,
      releaseDate: raw.first_air_date || null,
      status: raw.status || null,
      directors: extractCrew(raw?.credits?.crew, ["Director"]),
      writers: extractCrew(raw?.credits?.crew, ["Writer", "Screenplay", "Story"]),
      networks: Array.isArray(raw?.networks) ? raw.networks.map((n) => n.name).filter((name): name is string => Boolean(name)) : [],
      totalEpisodes: typeof raw?.number_of_episodes === "number" ? raw.number_of_episodes : null,
    },
    seasons,
    initialSeason,
    initialEpisodes,
    seasonApiBase: `/api/tmdb/tv/${id}/season`,
  };
}

async function fetchTvSeasonEpisodes(id: number, seasonNumber: number): Promise<EpisodeSummary[]> {
  if (!seasonNumber || seasonNumber < 0) return [];
  try {
    const data = await tmdb<SeasonResponse>(`/tv/${id}/season/${seasonNumber}`);
    return Array.isArray(data?.episodes)
      ? data.episodes.map(
          (ep): EpisodeSummary => ({
            id: ep.id,
            name: ep.name || `Episode ${ep.episode_number ?? ""}`,
            overview: ep.overview || "",
            stillUrl: TMDB_IMG(ep.still_path, "w500"),
            episodeNumber: ep.episode_number,
            seasonNumber: ep.season_number ?? seasonNumber,
            airDate: ep.air_date,
            runtime: typeof ep.runtime === "number" ? ep.runtime : null,
          })
        )
      : [];
  } catch {
    return [];
  }
}

// Parse Jikan duration string like "1 hr 46 min" or "24 min per ep" to minutes
function parseJikanDuration(duration?: string | null): number | null {
  if (!duration) return null;
  const hourMatch = duration.match(/(\d+)\s*hr/i);
  const minMatch = duration.match(/(\d+)\s*min/i);
  let total = 0;
  if (hourMatch) total += parseInt(hourMatch[1], 10) * 60;
  if (minMatch) total += parseInt(minMatch[1], 10);
  return total > 0 ? total : null;
}

async function fetchAnime(id: number): Promise<TitlePayload> {
  const detailRes = await fetch(`https://api.jikan.moe/v4/anime/${id}/full`, { next: { revalidate: 300 } });
  if (!detailRes.ok) throw new Error("Anime detail failed");
  const detailJson: JikanDetailResponse = await detailRes.json();
  const detail = detailFromJikan(detailJson.data);
  
  // Determine if this anime is a movie
  const animeType = detailJson.data?.type ?? null;
  const isAnimeMovie = animeType === "Movie";
  
  // Parse runtime for movies from Jikan duration field
  const runtime = parseJikanDuration(detailJson.data?.duration);
  
  // Only fetch episodes for non-movie anime
  const episodes = isAnimeMovie ? [] : await fetchAnimeEpisodes(id);

  // For movies, we don't show seasons/episodes
  if (isAnimeMovie) {
    return {
      kind: "anime",
      detail: {
        ...detail,
        runtime, // Add movie runtime
        tagline: detailJson.data?.theme?.openings?.[0] ?? null,
        releaseDate: detailJson.data?.aired?.from ?? null,
        status: detailJson.data?.status ?? null,
        totalEpisodes: null,
        directors: [],
        writers: [],
      },
      isAnimeMovie: true,
      animeType,
    };
  }

  // For TV/OVA/ONA/Special - show episode list
  return {
    kind: "anime",
    detail: {
      ...detail,
      tagline: detailJson.data?.theme?.openings?.[0] ?? null,
      releaseDate: detailJson.data?.aired?.from ?? null,
      status: detailJson.data?.status ?? null,
      totalEpisodes: detailJson.data?.episodes ?? episodes.length,
      directors: [],
      writers: [],
    },
    seasons: [
      {
        seasonNumber: 1,
        name: animeType === "OVA" ? "OVA" : animeType === "ONA" ? "ONA" : "Season 1",
        episodeCount: detailJson.data?.episodes ?? episodes.length,
        airDate: detailJson.data?.aired?.from ?? null,
        posterUrl: detail.posterUrl ?? null,
      },
    ],
    initialSeason: 1,
    initialEpisodes: episodes,
    seasonApiBase: null,
    isAnimeMovie: false,
    animeType,
  };
}

async function fetchAnimeEpisodes(id: number): Promise<EpisodeSummary[]> {
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/episodes?limit=50`, { next: { revalidate: 120 } });
    if (!res.ok) throw new Error("Anime episodes failed");
    const json: JikanEpisodesPayload = await res.json();
    return Array.isArray(json?.data)
      ? json.data.map(
          (ep, idx): EpisodeSummary => {
            const absoluteNumber = idx + 1;
            return {
              id: ep.mal_id,
              name: ep.title || `Episode ${absoluteNumber}`,
              overview: ep.synopsis || ep.discussion_url || "",
              stillUrl: ep.images?.jpg?.image_url || null,
              episodeNumber: absoluteNumber,
              absoluteNumber,
              seasonNumber: 1,
              airDate: ep.aired,
              runtime: ep.duration || null,
            };
          }
        )
      : [];
  } catch {
    return [];
  }
}

function extractCrew(crew: CrewMember[] | undefined | null, jobs: string[]): string[] {
  if (!Array.isArray(crew)) return [];
  const set = new Set<string>();
  for (const member of crew) {
    const job = member?.job;
    if (job && jobs.includes(job) && member?.name) {
      set.add(member.name);
    }
  }
  return Array.from(set);
}

async function loadTitle(kind: Kind, id: number): Promise<TitlePayload> {
  switch (kind) {
    case "movie":
      return fetchMovie(id);
    case "tv":
      return fetchTv(id);
    case "anime":
      return fetchAnime(id);
    default:
      throw new Error("Unsupported kind");
  }
}

export default async function TitlePage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const resolved = await params;
  const kindParam = resolved.kind?.toLowerCase() ?? "";
  if (!isKind(kindParam)) notFound();

  const id = Number(resolved.id);
  if (!Number.isFinite(id) || id <= 0) notFound();

  let payload: TitlePayload | null = null;
  try {
    payload = await loadTitle(kindParam, id);
  } catch (e) {
    console.error("Failed to load title page", e);
  }
  if (!payload) notFound();

  const { detail } = payload;
  const languageName = detail.originalLanguage && languageFormatter ? languageFormatter.of(detail.originalLanguage) : null;
  const runtimeLabel = formatRuntime(detail.runtime);
  const releaseLabel = formatDate(payload.detail.releaseDate);

  const metaBadges = [
    runtimeLabel,
    detail.year ? `${detail.year}` : null,
    detail.tmdbRatingPct ? `${detail.tmdbRatingPct}% TMDb` : null,
    detail.imdbRating ? `${detail.imdbRating.toFixed(1)} IMDb` : null,
  ].filter(Boolean);

  const heroBackground = detail.backdropUrl || detail.posterUrl || null;

  return (
    <div className="relative isolate min-h-screen px-4 pb-10 pt-4 md:px-8 lg:px-12">
      {heroBackground ? (
        <div className="pointer-events-none fixed inset-0 -z-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroBackground} alt="" className="h-full w-full object-cover brightness-[0.35]" />
        </div>
      ) : (
        <div className="fixed inset-0 -z-10 bg-gradient-to-br from-[#03060b] via-[#050a16] to-[#0c1324]" />
      )}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-r from-[#03060b] via-[#03060b]/75 to-transparent" />

      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full bg-black/45 px-4 py-2 text-slate-100 shadow-lg shadow-black/40 backdrop-blur hover:bg-black/60"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to browse
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-200">
            <span className="rounded-full bg-black/40 px-3 py-1 uppercase tracking-wide backdrop-blur">
              {payload.kind === "tv" 
                ? "Series" 
                : payload.kind === "anime" 
                  ? payload.isAnimeMovie 
                    ? "Anime Movie" 
                    : `Anime ${payload.animeType === "OVA" ? "OVA" : payload.animeType === "ONA" ? "ONA" : "Series"}`
                  : "Movie"}
            </span>
            {detail.year ? (
              <span className="rounded-full bg-black/40 px-3 py-1 backdrop-blur">{detail.year}</span>
            ) : null}
            {languageName ? (
              <span className="rounded-full bg-black/40 px-3 py-1 backdrop-blur">{languageName}</span>
            ) : null}
            {detail.imdbId ? (
              <a
                href={`https://www.imdb.com/title/${detail.imdbId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-black/40 px-3 py-1 text-xs text-slate-100 backdrop-blur hover:text-white"
              >
                IMDb <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
        </div>

        <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="relative space-y-6">
            <div className="absolute inset-y-0 left-[-4rem] right-[35%] -z-10 rounded-[120px] bg-gradient-to-r from-black/85 via-black/40 to-transparent blur-[140px]" />

            <div className="space-y-3">
              <h1 className="text-3xl font-semibold text-white md:text-4xl">{detail.title}</h1>
              {detail.tagline ? (
                <p className="text-base italic text-slate-300">“{detail.tagline}”</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {metaBadges.map((item) => (
                  <Badge key={item} className="bg-white/10 text-white">
                    {item}
                  </Badge>
                ))}
                {detail.tmdbPopularity ? (
                  <Badge className="bg-white/10 text-white">🔥 {Math.round(detail.tmdbPopularity)}</Badge>
                ) : null}
              </div>
            </div>

            {detail.overview ? (
              <p className="max-w-3xl text-base leading-relaxed text-slate-200">{detail.overview}</p>
            ) : null}

            <div className="flex flex-wrap gap-3 text-sm text-slate-100">
              {detail.genres?.map((genre) => (
                <span key={genre} className="rounded-full bg-white/10 px-3 py-1">
                  {genre}
                </span>
              ))}
            </div>

            {detail.trailerKey ? (
              <div className="flex flex-wrap gap-3">
                <Button asChild className="rounded-2xl bg-cyan-500 text-black hover:bg-cyan-400">
                  <a
                    href={`https://www.youtube.com/watch?v=${detail.trailerKey}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Youtube className="mr-2 h-5 w-5" />
                    Watch trailer
                  </a>
                </Button>
              </div>
            ) : null}

            <dl className="grid gap-4 md:grid-cols-2">
              {payload.detail.directors?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Directors</dt>
                  <dd className="text-sm text-white">{payload.detail.directors.join(", ")}</dd>
                </div>
              ) : null}
              {payload.detail.writers?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Writers</dt>
                  <dd className="text-sm text-white">{payload.detail.writers.join(", ")}</dd>
                </div>
              ) : null}
              {payload.detail.networks?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Networks</dt>
                  <dd className="text-sm text-white">{payload.detail.networks.join(", ")}</dd>
                </div>
              ) : null}
              {payload.detail.status ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Status</dt>
                  <dd className="text-sm text-white">
                    {payload.detail.status}
                    {releaseLabel ? ` • Premiered ${releaseLabel}` : ""}
                  </dd>
                </div>
              ) : null}
              {payload.detail.totalEpisodes ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Episodes</dt>
                  <dd className="text-sm text-white">{payload.detail.totalEpisodes}</dd>
                </div>
              ) : null}
              {detail.imdbVotes ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">IMDb Votes</dt>
                  <dd className="text-sm text-white">{formatNumber(detail.imdbVotes)}</dd>
                </div>
              ) : null}
            </dl>

            {detail.cast?.length ? (
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Top cast</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {detail.cast.slice(0, 12).map((member) => (
                    <div
                      key={`${member.name}-${member.character ?? ""}`}
                      className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
                    >
                      <div className="font-medium">{member.name}</div>
                      {member.character ? <div className="text-xs text-slate-400">as {member.character}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-4">
            {/* Show TorrentPanel for movies OR anime movies */}
            {payload.kind === "movie" || payload.isAnimeMovie ? (
              <TorrentPanel
                title={detail.title}
                year={detail.year}
                imdbId={detail.imdbId}
                originalLanguage={detail.originalLanguage}
                kind={payload.isAnimeMovie ? "anime" : "movie"}
                malId={payload.isAnimeMovie ? id : undefined}
                tmdbId={payload.kind === "movie" ? id : undefined}
                titleAliases={detail.altTitles}
              />
            ) : (
              <EpisodePanel
                kind={payload.kind === "anime" ? "anime" : "tv"}
                title={detail.title}
                titleAliases={detail.altTitles}
                imdbId={detail.imdbId}
                year={detail.year}
                originalLanguage={detail.originalLanguage}
                posterUrl={detail.posterUrl}
                backdropUrl={detail.backdropUrl}
                seasons={payload.seasons ?? [{ seasonNumber: 1, name: "Season 1" }]}
                initialSeason={payload.initialSeason ?? 1}
                initialEpisodes={payload.initialEpisodes ?? []}
                seasonApiBase={payload.seasonApiBase}
                tmdbId={payload.kind === "tv" ? id : undefined}
                malId={payload.kind === "anime" ? id : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

