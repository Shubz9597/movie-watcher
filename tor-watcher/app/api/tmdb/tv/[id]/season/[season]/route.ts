import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/lib/services/tmbd-service";
import type { EpisodeSummary } from "@/lib/title-types";

export const runtime = "nodejs";

const TMDB_IMG = (path?: string | null, size: "w300" | "w500" = "w300") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

type TmdbEpisode = {
  id: number;
  name: string;
  overview?: string | null;
  still_path?: string | null;
  episode_number: number;
  season_number: number;
  air_date?: string | null;
  runtime?: number | null;
};

type SeasonPayload = {
  episodes?: TmdbEpisode[];
};

export async function GET(_req: NextRequest, ctx: { params: { id: string; season: string } }) {
  const showId = Number(ctx.params.id);
  const seasonNumber = Number(ctx.params.season);

  if (!Number.isFinite(showId) || !Number.isFinite(seasonNumber)) {
    return NextResponse.json({ error: "Invalid id or season" }, { status: 400 });
  }

  try {
    const data = await tmdb<SeasonPayload>(`/tv/${showId}/season/${seasonNumber}`);
    const episodes: EpisodeSummary[] = Array.isArray(data?.episodes)
      ? data.episodes.map((ep) => ({
          id: ep.id,
          name: ep.name || `Episode ${ep.episode_number ?? ""}`,
          overview: ep.overview || "",
          stillUrl: TMDB_IMG(ep.still_path, "w500"),
          episodeNumber: ep.episode_number,
          seasonNumber: ep.season_number ?? seasonNumber,
          airDate: ep.air_date,
          runtime: typeof ep.runtime === "number" ? ep.runtime : null,
        }))
      : [];

    return NextResponse.json({ seasonNumber, episodes });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load season";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

