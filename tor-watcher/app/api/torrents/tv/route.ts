import { NextResponse } from "next/server";
import { tmdb } from "@/lib/services/tmbd-service";
import {
  matchesEpisode,
  detectSeasonPack,
  type SeasonPackDetection,
} from "@/lib/anime-matching";

const PROWLARR_URL = process.env.PROWLARR_URL ?? "";
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY ?? "";
const PROWLARR_ORIGIN = PROWLARR_URL ? new URL(PROWLARR_URL).origin : "";

// TV categories for Prowlarr search
const TV_CATS = [5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070, 5080];

const MAGNET_RX = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"' \r\n]*/i;
const isDev = process.env.NODE_ENV !== "production";

/* ---------- Prowlarr Native Search Response Types ---------- */

interface ProwlarrRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  sortTitle?: string;
  size: number;
  publishDate?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  seeders?: number;
  leechers?: number;
  protocol: "torrent" | "usenet";
  categories?: { id: number; name: string }[];
  indexerFlags?: string[];
}

/* ---------- Helper Functions ---------- */

function cleanImdbId(input?: string | null): string | null {
  if (!input) return null;
  const m = String(input).match(/(\d{6,8})$/);
  return m ? m[1] : null;
}

function extractInfoHash(magnet?: string | null): string | undefined {
  if (!magnet) return;
  const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/);
  return m?.[1]?.toUpperCase();
}

function isProwlarrDownloadUrl(u?: string | null): boolean {
  if (!u || !PROWLARR_URL || !PROWLARR_ORIGIN) return false;
  try {
    const x = new URL(u, PROWLARR_URL);
    return x.origin === PROWLARR_ORIGIN && /\/download\b/i.test(x.pathname);
  } catch {
    return false;
  }
}

function isHttpUrl(u?: string | null): u is string {
  if (!u) return false;
  return /^https?:\/\//i.test(u);
}

async function resolveDownloadToMagnet(
  url: string,
  timeoutMs = 8000,
  maxHops = 5
): Promise<string | undefined> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        cache: "no-store",
        signal: ctrl.signal,
      });
      const loc = res.headers.get("location");
      if (loc?.startsWith("magnet:")) return loc;
      if (loc) {
        try {
          const next = new URL(loc, current).href;
          if (next.startsWith("magnet:")) return next;
          if (res.status >= 300 && res.status < 400) {
            current = next;
            continue;
          }
        } catch {
          // invalid redirect target
        }
      }

      const ct = res.headers.get("content-type") || "";
      if (/text\/html|application\/json/i.test(ct)) {
        const body = await res.text();
        const inlineMagnet = body.match(MAGNET_RX);
        if (inlineMagnet) return inlineMagnet[0];
      }

      break;
    }
    return undefined;
  } finally {
    clearTimeout(to);
  }
}

function magnetFromHash(infoHash?: string, title?: string) {
  if (!infoHash) return undefined;
  const dn = title ? `&dn=${encodeURIComponent(title)}` : "";
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
  ]
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join("");
  return `magnet:?xt=urn:btih:${infoHash.toUpperCase()}${dn}${trackers}`;
}

async function fetchTitleFromImdb(
  imdbDigits: string
): Promise<{ title?: string; year?: string } | undefined> {
  const imdbId = `tt${imdbDigits}`;
  type FindResponse = {
    tv_results?: Array<{
      name?: string;
      original_name?: string;
      first_air_date?: string | null;
    }>;
  };
  try {
    const data = await tmdb<FindResponse>(
      `/find/${imdbId}?external_source=imdb_id`
    );
    const match = data.tv_results?.[0];
    if (!match) return undefined;
    const title = match.name || match.original_name || undefined;
    const year = match.first_air_date?.slice(0, 4) || undefined;
    if (!title) return undefined;
    return { title, year };
  } catch (err) {
    if (isDev) console.warn(`[tv-torrents] tmdb lookup failed for ${imdbId}`, err);
    return undefined;
  }
}

function toNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/* ---------- Normalized Result Type ---------- */

type SeasonPackMeta = {
  season?: number | null;
  reason?: string | null;
  keywords?: string[];
};

type Normalized = {
  title: string;
  indexer: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  publishDate?: string;
  episodeMatch?: boolean;
  seasonPack?: SeasonPackMeta;
};

/* ---------- Prowlarr Native Search ---------- */

interface ProwlarrSearchOpts {
  query: string;
  season?: number;
  episode?: number;
  imdbId?: string;
  tvdbId?: number;
}

async function searchProwlarrNative(opts: ProwlarrSearchOpts): Promise<ProwlarrRelease[]> {
  const url = new URL(`${PROWLARR_URL}/api/v1/search`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("type", "tvsearch");
  
  // Pass season/episode for indexers that support episode-level searches
  if (opts.season != null) {
    url.searchParams.set("season", String(opts.season));
  }
  if (opts.episode != null) {
    url.searchParams.set("episode", String(opts.episode));
  }
  
  // Pass IDs for better show matching (reduces ambiguity)
  if (opts.imdbId) {
    url.searchParams.set("imdbId", opts.imdbId);
  }
  if (opts.tvdbId != null && !Number.isNaN(opts.tvdbId)) {
    url.searchParams.set("tvdbId", String(opts.tvdbId));
  }
  
  for (const cat of TV_CATS) {
    url.searchParams.append("categories", String(cat));
  }
  url.searchParams.set("limit", "100");

  if (isDev) {
    console.debug(`[tv-torrents] Prowlarr URL: ${url.toString().replace(PROWLARR_API_KEY, "***")}`);
  }

  const res = await fetch(url.toString(), {
    headers: {
      "X-Api-Key": PROWLARR_API_KEY,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Prowlarr search failed: ${res.status} ${text}`);
  }

  const releases = (await res.json()) as ProwlarrRelease[];
  // Filter to torrents only
  return releases.filter((r) => r.protocol === "torrent");
}

function transformProwlarrRelease(release: ProwlarrRelease): Normalized {
  const magnetUri = release.magnetUrl ?? undefined;
  const infoHash = release.infoHash?.toUpperCase() ?? extractInfoHash(magnetUri);
  const downloadUrl = isProwlarrDownloadUrl(release.downloadUrl)
    ? release.downloadUrl
    : undefined;

  return {
    title: release.title,
    indexer: release.indexer,
    size: release.size,
    seeders: release.seeders ?? 0,
    leechers: release.leechers ?? 0,
    magnetUri,
    torrentUrl: release.downloadUrl?.endsWith(".torrent")
      ? release.downloadUrl
      : undefined,
    downloadUrl,
    infoHash,
    publishDate: release.publishDate,
  };
}

/* ---------- Ranking and Filtering ---------- */

function qualityScore(title: string): number {
  const t = title.toLowerCase();
  if (t.includes("2160p") || t.includes("4k")) return 3;
  if (t.includes("1080p")) return 2;
  if (t.includes("720p")) return 1;
  return 0;
}

function rank(items: Normalized[]): Normalized[] {
  return [...items].sort((a, b) => {
    const sa = 5 * Math.log2(1 + (a.seeders || 0)) + 2 * qualityScore(a.title);
    const sb = 5 * Math.log2(1 + (b.seeders || 0)) + 2 * qualityScore(b.title);
    return sb - sa;
  });
}

function dedupeByHash(items: Normalized[]): Normalized[] {
  const seen = new Set<string>();
  const out: Normalized[] = [];
  for (const it of items) {
    const key =
      it.infoHash ||
      `${it.title.toLowerCase().replace(/\s+/g, " ").trim()}|${it.indexer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function normalizeForSeriesMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/.:-]+/g, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSeriesMatchers(variants: string[]): string[] {
  const matchers: string[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const norm = normalizeForSeriesMatch(variant);
    if (norm.length < 2) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    matchers.push(norm);
  }
  return matchers;
}

function matchesSeries(title: string, matchers: string[]): boolean {
  if (!matchers.length) return true;
  const normTitle = normalizeForSeriesMatch(title);
  if (!normTitle) return false;
  return matchers.some((needle) => normTitle.includes(needle));
}

/* ---------- Main Handler ---------- */

export async function GET(request: Request) {
  try {
    if (!PROWLARR_URL || !PROWLARR_API_KEY) {
      return NextResponse.json(
        { error: "Prowlarr configuration is missing." },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const imdbIdRaw = searchParams.get("imdbId");
    const titleParam = searchParams.get("title");
    const yearParam = searchParams.get("year");
    const seasonParam = searchParams.get("season");
    const episodeParam = searchParams.get("episode");
    const aliasParams = searchParams
      .getAll("alias")
      .map((s) => s.trim())
      .filter(Boolean);

    const imdbDigits = cleanImdbId(imdbIdRaw);
    let queryTitle = titleParam?.trim() || undefined;
    let queryYear = yearParam?.trim() || undefined;
    let querySource: "client" | "tmdb" = queryTitle ? "client" : "client";

    if (!queryTitle && imdbDigits) {
      const meta = await fetchTitleFromImdb(imdbDigits);
      if (meta?.title) {
        queryTitle = meta.title;
        querySource = "tmdb";
      }
      if (!queryYear && meta?.year) queryYear = meta.year;
    }

    if (!queryTitle) {
      return NextResponse.json(
        { error: "Provide a title (or an IMDb id I can resolve to a title)." },
        { status: 400 }
      );
    }

    const seasonNum = toNumber(seasonParam);
    const episodeNum = toNumber(episodeParam);
    const tvdbIdParam = searchParams.get("tvdbId");
    const tvdbId = tvdbIdParam ? parseInt(tvdbIdParam, 10) : undefined;

    const titleVariants = [queryTitle, ...aliasParams];
    const seriesMatchers = buildSeriesMatchers(titleVariants);

    // Build search query - just the title, optionally with year
    const searchQuery = queryYear ? `${queryTitle} ${queryYear}` : queryTitle;

    // Format IMDB ID properly (with tt prefix)
    const imdbIdForSearch = imdbDigits ? `tt${imdbDigits}` : undefined;

    if (isDev) {
      console.debug(
        `[tv-torrents] Prowlarr native search: "${searchQuery}" season=${seasonNum ?? "-"} episode=${episodeNum ?? "-"} imdb=${imdbIdForSearch ?? "-"} tvdb=${tvdbId ?? "-"}`
      );
    }

    // Single request to Prowlarr native search API - searches ALL indexers at once
    // Pass season/episode/IDs for indexers that support targeted searches
    const prowlarrResults = await searchProwlarrNative({
      query: searchQuery,
      season: seasonNum,
      episode: episodeNum,
      imdbId: imdbIdForSearch,
      tvdbId: tvdbId && !Number.isNaN(tvdbId) ? tvdbId : undefined,
    });

    if (isDev) {
      console.debug(`[tv-torrents] Prowlarr returned ${prowlarrResults.length} results`);
    }

    // Transform Prowlarr results to normalized format
    const all: Normalized[] = prowlarrResults.map(transformProwlarrRelease);

    const uniq = dedupeByHash(all);
    const ranked = rank(uniq);

    // Flag episode matches and season packs
    const wantEpisodeFilter = episodeNum != null;
    const flagged = ranked.map((item) => {
      const matches = wantEpisodeFilter
        ? matchesEpisode(item.title, seasonNum ?? undefined, episodeNum, undefined)
        : true;
      const packDetection: SeasonPackDetection | undefined =
        wantEpisodeFilter && !matches
          ? detectSeasonPack(item.title, seasonNum ?? undefined)
          : undefined;
      return {
        ...item,
        episodeMatch: wantEpisodeFilter ? matches : undefined,
        seasonPack:
          packDetection && packDetection.isSeasonPack
            ? {
                season: seasonNum ?? null,
                reason: packDetection.reason,
                keywords: packDetection.keywords,
              }
            : undefined,
      } as Normalized;
    });

    // Unified list: include episode matches AND season packs, sorted by seeds/quality
    // Exclude results that are neither episode matches nor season packs
    const relevant = wantEpisodeFilter
      ? flagged.filter((it) => it.episodeMatch || it.seasonPack)
      : flagged;

    // Apply series name filter
    const applySeriesFilter = (list: Normalized[]) =>
      seriesMatchers.length > 0
        ? list.filter((it) => matchesSeries(it.title, seriesMatchers))
        : list;

    const afterSeries = applySeriesFilter(relevant);

    // Unified list - already sorted by seeds/quality from rank(), keep that order
    const finalResults = seriesMatchers.length > 0 ? afterSeries : relevant;

    // Resolve magnets for top results
    for (const item of finalResults.slice(0, 10)) {
      if (item.magnetUri?.startsWith("magnet:")) continue;

      if (isHttpUrl(item.downloadUrl)) {
        try {
          const resolved = await resolveDownloadToMagnet(item.downloadUrl);
          if (resolved) {
            item.magnetUri = resolved;
            continue;
          }
        } catch (err) {
          if (isDev)
            console.debug("[tv-torrents] magnet resolve (download) failed", err);
        }
      }

      if (isHttpUrl(item.torrentUrl)) {
        try {
          const resolved = await resolveDownloadToMagnet(item.torrentUrl);
          if (resolved) {
            item.magnetUri = resolved;
            continue;
          }
        } catch (err) {
          if (isDev)
            console.debug("[tv-torrents] magnet resolve (torrent) failed", err);
        }
      }

      if (!item.magnetUri && item.infoHash) {
        item.magnetUri = magnetFromHash(item.infoHash, item.title);
      }
    }

    // Get unique indexers from results
    const indexersUsed = [...new Set(finalResults.map((r) => r.indexer))];

    const note =
      finalResults.length === 0
        ? `No torrents found for "${searchQuery}"`
        : undefined;

    return NextResponse.json({
      query: {
        imdbId: imdbDigits ? `tt${imdbDigits}` : null,
        tvdbId: tvdbId ?? null,
        title: queryTitle,
        year: queryYear ?? null,
        season: seasonNum ?? null,
        episode: episodeNum ?? null,
        querySource,
        searchQuery,
        aliases: aliasParams,
      },
      providers: indexersUsed.map((name) => ({ name })),
      total: finalResults.length,
      results: finalResults,
      note,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (isDev) console.error("[tv-torrents] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
