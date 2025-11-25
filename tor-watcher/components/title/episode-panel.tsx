"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TorrentRow } from "@/components/torrentListModal/torrentListDialog";
import type { EpisodeSummary, SeasonSummary } from "@/lib/title-types";

type Props = {
  kind: "tv" | "anime";
  title: string;
  imdbId?: string;
  year?: number;
  originalLanguage?: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  seasons: SeasonSummary[];
  initialSeason: number;
  initialEpisodes: EpisodeSummary[];
  seasonApiBase?: string | null;
};

type SeasonFetchResponse = {
  episodes?: EpisodeSummary[];
  error?: string;
};

type TorrentApiItem = {
  title: string;
  size?: number;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  magnet?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  indexer?: string;
  publishDate?: string;
};

type TorrentApiResponse = {
  results?: TorrentApiItem[];
  error?: string;
};

const formatAirDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function EpisodePanel({
  kind,
  title,
  imdbId,
  year,
  originalLanguage,
  seasons,
  initialSeason,
  initialEpisodes,
  seasonApiBase,
}: Props) {
  const router = useRouter();
  const [selectedSeason, setSelectedSeason] = useState(initialSeason);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>(initialEpisodes);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);

  const [torrentRows, setTorrentRows] = useState<TorrentRow[] | null>(null);
  const [torrentLoading, setTorrentLoading] = useState(false);
  const [torrentError, setTorrentError] = useState<string | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeSummary | null>(null);

  const seasonCache = useRef<Map<number, EpisodeSummary[]>>(new Map());
  const normalizedSeasons = seasons.length ? seasons : [{ seasonNumber: initialSeason, name: `Season ${initialSeason}` }];

  useEffect(() => {
    seasonCache.current.set(initialSeason, initialEpisodes);
    setEpisodes(initialEpisodes);
    setSelectedSeason(initialSeason);
  }, [initialSeason, initialEpisodes]);

  const onSeasonChange = async (value: string) => {
    const seasonNum = Number(value);
    setSelectedSeason(seasonNum);
    setSeasonError(null);

    const cached = seasonCache.current.get(seasonNum);
    if (cached) {
      setEpisodes(cached);
      return;
    }
    if (!seasonApiBase) {
      setEpisodes([]);
      return;
    }
    setSeasonLoading(true);
    try {
      const res = await fetch(`${seasonApiBase}/${seasonNum}`, { cache: "no-store" });
      const json: SeasonFetchResponse = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to load season");
      const eps: EpisodeSummary[] = Array.isArray(json?.episodes) ? json.episodes : [];
      seasonCache.current.set(seasonNum, eps);
      setEpisodes(eps);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load season";
      setSeasonError(message);
      setEpisodes([]);
    } finally {
      setSeasonLoading(false);
    }
  };

  const fetchTorrentsForEpisode = async (episode: EpisodeSummary) => {
    setActiveEpisode(episode);
    setTorrentLoading(true);
    setTorrentError(null);
    setTorrentRows(null);
    try {
      const params = new URLSearchParams();
      if (imdbId) params.set("imdbId", imdbId);
      else params.set("title", title);
      params.set("season", String(episode.seasonNumber || selectedSeason));
      params.set("episode", String(episode.episodeNumber));
      if (year) params.set("year", String(year));
      if (originalLanguage) params.set("origLang", originalLanguage);

      const endpoint = kind === "anime" ? "/api/torrents/anime" : "/api/torrents/tv";
      const res = await fetch(`${endpoint}?${params.toString()}`, { cache: "no-store" });
      const json: TorrentApiResponse = await res.json();
      if (!res.ok) throw new Error(json?.error || "Torrent lookup failed");
      const rows: TorrentRow[] = Array.isArray(json?.results)
        ? json.results.map((it) => ({
            title: it.title,
            size: typeof it.size === "number" ? it.size : it.sizeBytes,
            seeders: it.seeders,
            leechers: it.leechers,
            magnetUri: it.magnetUri || it.magnet,
            torrentUrl: it.torrentUrl || it.downloadUrl,
            infoHash: it.infoHash,
            indexer: it.indexer || "-",
            publishDate: it.publishDate,
          }))
        : [];
      setTorrentRows(rows);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to fetch torrents";
      setTorrentError(message);
      setTorrentRows([]);
    } finally {
      setTorrentLoading(false);
    }
  };

  const resetSelection = () => {
    setActiveEpisode(null);
    setTorrentRows(null);
    setTorrentError(null);
    setTorrentLoading(false);
  };

  const playTorrent = (t: TorrentRow) => {
    const magnet = t.magnetUri || t.torrentUrl || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : "");
    if (!magnet) return;
    const qs = new URLSearchParams();
    qs.set("src", magnet);
    qs.set("title", title);
    if (year) qs.set("year", String(year));
    if (imdbId) qs.set("imdbId", imdbId);
    router.push(`/watch?${qs.toString()}`);
  };

  const showSeasonSelector = normalizedSeasons.length > 0;
  const disableSeasonSwitch = normalizedSeasons.length <= 1 || !seasonApiBase;

  const episodeLabel = useMemo(
    () => (episode: EpisodeSummary) =>
      `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`,
    []
  );

  return (
    <aside className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-white shadow-2xl shadow-black/40">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{activeEpisode ? "Streams" : "Episodes"}</p>
          <h2 className="text-lg font-semibold text-white">
            {activeEpisode ? (activeEpisode.name || "Untitled episode") : "Choose an episode"}
          </h2>
          {activeEpisode ? (
            <p className="text-xs text-slate-400">
              {episodeLabel(activeEpisode)} • {formatAirDate(activeEpisode.airDate) || "TBA"}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {activeEpisode ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-white/20 text-white hover:bg-white/10"
              onClick={resetSelection}
            >
              Back to episodes
            </Button>
          ) : showSeasonSelector ? (
            <Select value={String(selectedSeason)} onValueChange={onSeasonChange} disabled={disableSeasonSwitch}>
              <SelectTrigger className="w-40 rounded-full border-white/20 bg-white/10 px-4 text-sm text-white">
                <SelectValue placeholder="Season" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border border-white/10 bg-[#0b111f] text-slate-100">
                {normalizedSeasons.map((s) => (
                  <SelectItem key={s.seasonNumber} value={String(s.seasonNumber)}>
                    {s.name || `Season ${s.seasonNumber}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      {seasonError && !activeEpisode ? (
        <div className="rounded-xl border border-red-900/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{seasonError}</div>
      ) : null}

      {!activeEpisode ? (
        <div className="space-y-2 overflow-y-auto pr-1" style={{ scrollbarWidth: "thin", scrollbarColor: "#475569 transparent", maxHeight: "70vh" }}>
          {seasonLoading
            ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-white/5" />)
            : episodes.length === 0
            ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-slate-200">
                No episodes found for this season.
              </div>
            )
            : episodes.map((episode) => (
              <button
                key={episode.id ?? `${episode.seasonNumber}-${episode.episodeNumber}`}
                className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-cyan-400/50"
                onClick={() => void fetchTorrentsForEpisode(episode)}
              >
                <div className="h-16 w-28 overflow-hidden rounded-xl bg-slate-900">
                  {episode.stillUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={episode.stillUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">Coming soon</div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{episodeLabel(episode)}</div>
                  <div className="truncate text-sm font-semibold text-white">{episode.name || "Untitled episode"}</div>
                  <div className="text-xs text-slate-400">{formatAirDate(episode.airDate) || "TBA"}</div>
                </div>
                <div className="flex items-center text-xs text-cyan-200">
                  {torrentLoading && activeEpisode?.id === episode.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </div>
              </button>
            ))}
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto pr-1" style={{ scrollbarWidth: "thin", scrollbarColor: "#475569 transparent", maxHeight: "70vh" }}>
          {torrentLoading ? (
            <div className="flex items-center gap-2 rounded-2xl bg-white/10 px-4 py-6 text-sm text-slate-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              Fetching torrents…
            </div>
          ) : torrentError ? (
            <div className="rounded-2xl border border-red-900/40 bg-red-500/10 px-4 py-4 text-sm text-red-200">{torrentError}</div>
          ) : !torrentRows || torrentRows.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/10 px-4 py-4 text-sm text-slate-200">
              No torrents found yet. Try refreshing the episode or pick another one.
            </div>
          ) : (
            torrentRows.map((t, idx) => (
              <button
                key={`${t.infoHash || t.title}-${idx}`}
                className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/10 p-3 text-left transition hover:border-cyan-400/50"
                onClick={() => playTorrent(t)}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-xs font-semibold text-cyan-200">
                  {qualityFromTitle(t.title) ?? "—"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">{t.title}</div>
                  <div className="text-xs text-slate-400">
                    {formatBytes(t.size)} • {t.seeders ?? 0} seeders • {t.indexer}
                  </div>
                </div>
                <Play className="h-4 w-4 text-cyan-200" />
              </button>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

