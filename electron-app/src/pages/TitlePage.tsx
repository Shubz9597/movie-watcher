import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Youtube } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import EpisodePanel from '../components/EpisodePanelWrapper';
import TorrentPanel from '../components/TorrentPanel';
import { getMovie as getTmdbMovie, getTv as getTmdbTv, getTvSeason } from '../lib/services/tmdb-service';
import { getAnime } from '../lib/services/jikan-service';
import { detailFromTmdbMovie, detailFromTmdbTv, detailFromJikan } from '../lib/adapters/media';

type Detail = {
  title: string;
  overview?: string;
  tagline?: string;
  year?: number;
  runtime?: number;
  tmdbRatingPct?: number;
  imdbRating?: number;
  imdbVotes?: number;
  imdbId?: string;
  originalLanguage?: string;
  genres?: string[];
  cast?: Array<{ name: string; character?: string }>;
  posterUrl?: string;
  backdropUrl?: string;
  trailerKey?: string;
  directors?: string[];
  writers?: string[];
  networks?: string[];
  totalEpisodes?: number;
  altTitles?: string[];
  isAnimeMovie?: boolean;
};

export default function TitlePage({
  navigate,
  kind,
  id,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
  kind: string;
  id: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [initialSeason, setInitialSeason] = useState(1);
  const [initialEpisodes, setInitialEpisodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAnimeMovie, setIsAnimeMovie] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        console.log('[TitlePage] Loading', kind, id);

        if (kind === 'movie') {
          const raw = await getTmdbMovie(Number(id));
          const d = detailFromTmdbMovie(raw);
          setDetail(d);
          setIsAnimeMovie(false);
        } else if (kind === 'tv') {
          const raw = await getTmdbTv(Number(id));
          const d = detailFromTmdbTv(raw);
          setDetail(d);

          // Load seasons
          const seasonsData = Array.isArray(raw.seasons)
            ? raw.seasons
                .filter((s: any) => s.season_number >= 0 && (s.episode_count ?? 0) > 0)
                .sort((a: any, b: any) => a.season_number - b.season_number)
                .map((s: any) => ({
                  seasonNumber: s.season_number,
                  name: s.name || `Season ${s.season_number}`,
                  episodeCount: s.episode_count ?? undefined,
                  airDate: s.air_date,
                  posterUrl: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : undefined,
                }))
            : [];
          setSeasons(seasonsData);
          const firstSeason = seasonsData[0]?.seasonNumber ?? 1;
          setInitialSeason(firstSeason);

          // Load first season episodes
          const seasonData = await getTvSeason(Number(id), firstSeason);
          const episodes = Array.isArray(seasonData.episodes)
            ? seasonData.episodes.map((ep: any) => ({
                episodeNumber: ep.episode_number,
                seasonNumber: ep.season_number,
                name: ep.name,
                overview: ep.overview,
                airDate: ep.air_date,
                stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w780${ep.still_path}` : undefined,
                runtime: ep.runtime,
              }))
            : [];
          setInitialEpisodes(episodes);
        } else {
          // Anime
          const raw = await getAnime(Number(id));
          const d = detailFromJikan(raw);
          setDetail(d);

          // Check if it's a movie
          const animeType = raw.type;
          setIsAnimeMovie(animeType === 'Movie');

          if (animeType !== 'Movie') {
            // Load episodes if available
            // Jikan episodes API would be called here
            setSeasons([{ seasonNumber: 1, name: 'Season 1' }]);
            setInitialSeason(1);
            setInitialEpisodes([]);
          }
        }
      } catch (err) {
        console.error('[TitlePage] Failed to load title:', err);
      } finally {
        setLoading(false);
      }
    }
    if (id) load();
  }, [kind, id]);

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (!detail) {
    return <div className="error">Title not found</div>;
  }

  const languageFormatter =
    typeof Intl !== 'undefined' && 'DisplayNames' in Intl
      ? new Intl.DisplayNames(['en'], { type: 'language' })
      : null;
  const languageName = detail.originalLanguage && languageFormatter ? languageFormatter.of(detail.originalLanguage) : null;

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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatNumber = (n?: number | null) => {
    if (typeof n !== 'number') return null;
    return n.toLocaleString();
  };

  const runtimeLabel = formatRuntime(detail.runtime);
  const metaBadges = [
    runtimeLabel,
    detail.year ? `${detail.year}` : null,
    detail.tmdbRatingPct ? `${detail.tmdbRatingPct}% TMDb` : null,
    detail.imdbRating ? `${detail.imdbRating.toFixed(1)} IMDb` : null,
  ].filter(Boolean);

  const heroBackground = detail.backdropUrl || detail.posterUrl || null;
  const isMovie = kind === 'movie' || isAnimeMovie;

  return (
    <div className="relative isolate min-h-screen px-4 pb-10 pt-4 md:px-8 lg:px-12">
      {heroBackground ? (
        <div className="pointer-events-none fixed inset-0 -z-10">
          <img src={heroBackground} alt="" className="h-full w-full object-cover brightness-[0.35]" />
        </div>
      ) : (
        <div className="fixed inset-0 -z-10 bg-gradient-to-br from-[#03060b] via-[#050a16] to-[#0c1324]" />
      )}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-r from-[#03060b] via-[#03060b]/75 to-transparent" />

      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white">
          <button
            onClick={() => navigate('home')}
            className="inline-flex items-center gap-2 rounded-full bg-black/45 px-4 py-2 text-slate-100 shadow-lg shadow-black/40 backdrop-blur hover:bg-black/60"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to browse
          </button>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-200">
            <span className="rounded-full bg-black/40 px-3 py-1 uppercase tracking-wide backdrop-blur">
              {kind === 'tv' ? 'Series' : kind === 'anime' ? (isAnimeMovie ? 'Anime Movie' : 'Anime Series') : 'Movie'}
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
              {detail.tagline ? <p className="text-base italic text-slate-300">"{detail.tagline}"</p> : null}
              <div className="flex flex-wrap gap-2">
                {metaBadges.map((item) => (
                  <Badge key={item} className="bg-white/10 text-white">
                    {item}
                  </Badge>
                ))}
                {detail.tmdbRatingPct ? (
                  <Badge className="bg-white/10 text-white">🔥 {Math.round(detail.tmdbRatingPct)}</Badge>
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
              {detail.directors?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Directors</dt>
                  <dd className="text-sm text-white">{detail.directors.join(', ')}</dd>
                </div>
              ) : null}
              {detail.writers?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Writers</dt>
                  <dd className="text-sm text-white">{detail.writers.join(', ')}</dd>
                </div>
              ) : null}
              {detail.networks?.length ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Networks</dt>
                  <dd className="text-sm text-white">{detail.networks.join(', ')}</dd>
                </div>
              ) : null}
              {detail.totalEpisodes ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Episodes</dt>
                  <dd className="text-sm text-white">{detail.totalEpisodes}</dd>
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
                      key={`${member.name}-${member.character ?? ''}`}
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
            {isMovie ? (
              <TorrentPanel
                title={detail.title}
                year={detail.year}
                imdbId={detail.imdbId}
                originalLanguage={detail.originalLanguage}
                kind={isAnimeMovie ? 'anime' : 'movie'}
                malId={isAnimeMovie ? Number(id) : undefined}
                tmdbId={kind === 'movie' ? Number(id) : undefined}
                titleAliases={detail.altTitles}
              />
            ) : (
              <EpisodePanel
                kind={kind === 'anime' ? 'anime' : 'tv'}
                title={detail.title}
                titleAliases={detail.altTitles}
                imdbId={detail.imdbId}
                year={detail.year}
                originalLanguage={detail.originalLanguage}
                posterUrl={detail.posterUrl}
                backdropUrl={detail.backdropUrl}
                seasons={seasons.length > 0 ? seasons : [{ seasonNumber: 1, name: 'Season 1' }]}
                initialSeason={initialSeason}
                initialEpisodes={initialEpisodes}
                seasonApiBase={null}
                tmdbId={kind === 'tv' ? Number(id) : undefined}
                malId={kind === 'anime' ? Number(id) : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}



