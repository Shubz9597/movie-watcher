import { NextResponse } from "next/server";
import { detectSeasonPack, matchesEpisode } from "@/lib/anime-matching";

const PROWLARR_URL = process.env.PROWLARR_URL ?? "";
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY ?? "";
const PROWLARR_ORIGIN = PROWLARR_URL ? new URL(PROWLARR_URL).origin : "";

// Anime categories for Prowlarr search
const ANIME_CATS = [5070, 5080, 5000, 5010];

const MAGNET_RX = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"' \r\n]*/i;
const isDev = process.env.NODE_ENV !== "production";

/* ---------- Language Types and Detection ---------- */

type LangCode =
  | "en" | "hi" | "ta" | "te" | "ml" | "kn"
  | "ko" | "ja" | "zh" | "fr" | "de" | "es"
  | "pt" | "ru" | "it" | "tr" | "ar" | "pl" | "th" | "id" | "vi" | "uk" | "fa";

const LANG_PATTERNS: Array<{ code: LangCode; rx: RegExp }> = [
  { code: "en", rx: /\b(english|eng(?!\w)|en[-_. ]?(us|gb|uk))\b/i },
  { code: "hi", rx: /\b(hindi|hin(?:di)?|hind)\b/i },
  { code: "ta", rx: /\b(tamil)\b/i },
  { code: "te", rx: /\b(telugu)\b/i },
  { code: "ml", rx: /\b(malayalam)\b/i },
  { code: "kn", rx: /\b(kannada)\b/i },
  { code: "ko", rx: /\b(korean|kor(?!\w))\b/i },
  { code: "ja", rx: /\b(japanese|jpn|jap(?!\w))\b/i },
  { code: "zh", rx: /\b(chinese|mandarin|cantonese|chi(?!\w))\b/i },
  { code: "fr", rx: /\b(french|fra|vf|vostfr)\b/i },
  { code: "de", rx: /\b(german|deu|ger(?!\w))\b/i },
  { code: "es", rx: /\b(spanish|spa|latino|castellano)\b/i },
  { code: "pt", rx: /\b(portuguese|português|pt[-_. ]?br|brazilian|dublado)\b/i },
  { code: "ru", rx: /\b(russian|rus(?!\w))\b/i },
  { code: "it", rx: /\b(italian|ita(?!\w))\b/i },
  { code: "tr", rx: /\b(turkish|turk(?!\w))\b/i },
  { code: "ar", rx: /\b(arabic|ara(?!\w))\b/i },
  { code: "pl", rx: /\b(polish|pol(?!\w))\b/i },
  { code: "th", rx: /\b(thai|tha(?!\w))\b/i },
  { code: "id", rx: /\b(indonesian|indo)\b/i },
  { code: "vi", rx: /\b(vietnamese|viet)\b/i },
  { code: "uk", rx: /\b(ukrainian|ukr(?!\w))\b/i },
  { code: "fa", rx: /\b(persian|farsi)\b/i },
];

const SUBS_ONLY_RX = /\b(e-?subs?|eng(?:lish)?\s*subs?|subbed)\b/i;
const MULTI_OR_DUAL_RX = /\b(multi|dual(?:\s*audio)?)\b/i;
const DUB_RX = /\b(dub|dubbed)\b/i;

function normalizeAttrLang(v?: string): LangCode | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s.startsWith("en")) return "en";
  if (s.startsWith("hi")) return "hi";
  if (s.startsWith("ta")) return "ta";
  if (s.startsWith("te")) return "te";
  if (s.startsWith("ml")) return "ml";
  if (s.startsWith("kn")) return "kn";
  if (s.startsWith("ko")) return "ko";
  if (s.startsWith("ja") || s.startsWith("jp")) return "ja";
  if (s.startsWith("zh") || s.includes("mandarin") || s.includes("cantonese")) return "zh";
  if (s.startsWith("fr")) return "fr";
  if (s.startsWith("de")) return "de";
  if (s.startsWith("es") || s.includes("latino")) return "es";
  if (s.startsWith("pt") || s.includes("brazil")) return "pt";
  if (s.startsWith("ru")) return "ru";
  if (s.startsWith("it")) return "it";
  if (s.startsWith("tr")) return "tr";
  if (s.startsWith("ar")) return "ar";
  if (s.startsWith("pl")) return "pl";
  if (s.startsWith("th")) return "th";
  if (s.startsWith("id")) return "id";
  if (s.startsWith("vi")) return "vi";
  if (s.startsWith("uk")) return "uk";
  if (s.startsWith("fa") || s.includes("farsi")) return "fa";
  return undefined;
}

function detectLangFromTitle(title: string): { anyExplicit: boolean; langs: Set<LangCode> } {
  const t = title.toLowerCase();
  const langs = new Set<LangCode>();
  let anyExplicit = false;

  for (const { code, rx } of LANG_PATTERNS) {
    if (rx.test(t)) {
      langs.add(code);
      anyExplicit = true;
    }
  }

  if (DUB_RX.test(t)) anyExplicit = true;
  if (MULTI_OR_DUAL_RX.test(t)) anyExplicit = true;

  if (SUBS_ONLY_RX.test(t) && !langs.has("en")) {
    // subtitles mention only; do not force English audio
  }

  return { anyExplicit, langs };
}

function isAllowedByLanguage(
  title: string,
  attrLang?: string | undefined,
  allowed: Set<LangCode> = new Set<LangCode>(["ja"])
): boolean {
  const attr = normalizeAttrLang(attrLang);
  if (attr) return allowed.has(attr);

  const { anyExplicit, langs } = detectLangFromTitle(title);

  if (anyExplicit && langs.size > 0) {
    if (MULTI_OR_DUAL_RX.test(title) && !/english|eng(?!\w)/i.test(title)) {
      return [...allowed].some((lc) => langs.has(lc));
    }
    return [...langs].some((lc) => allowed.has(lc));
  }

  return true;
}

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
  languages?: { id: number; name: string }[];
}

/* ---------- Helper Functions ---------- */

function extractInfoHash(magnet?: string | null): string | undefined {
  if (!magnet) return undefined;
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

async function resolveDownloadToMagnet(url: string, timeoutMs = 8000, maxHops = 5): Promise<string | undefined> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await fetch(current, { redirect: "manual", cache: "no-store", signal: ctrl.signal });
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
          // ignore invalid redirect targets
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

function toNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/* ---------- Normalized Result Type ---------- */

type SeasonPackMeta = {
  season?: number | null;
  reason?: string;
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
  languageAttr?: string;
  episodeMatch?: boolean;
  seasonPack?: SeasonPackMeta;
};

/* ---------- Prowlarr Native Search ---------- */

interface ProwlarrSearchOpts {
  query: string;
  type: "search" | "tvsearch";
  tvdbId?: number;
}

async function searchProwlarrNative(opts: ProwlarrSearchOpts): Promise<ProwlarrRelease[]> {
  const url = new URL(`${PROWLARR_URL}/api/v1/search`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("type", opts.type);
  
  // Pass TVDB ID if available for indexers that support it
  if (opts.tvdbId != null && !Number.isNaN(opts.tvdbId)) {
    url.searchParams.set("tvdbId", String(opts.tvdbId));
  }
  
  for (const cat of ANIME_CATS) {
    url.searchParams.append("categories", String(cat));
  }
  url.searchParams.set("limit", "150");

  const res = await fetch(url.toString(), {
    headers: {
      "X-Api-Key": PROWLARR_API_KEY,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    // Don't throw on errors - just return empty results for this query
    if (isDev) {
      const text = await res.text().catch(() => "");
      console.debug(`[anime-torrents] Prowlarr query failed: ${opts.query} (${opts.type}) - ${res.status} ${text}`);
    }
    return [];
  }

  const releases = (await res.json()) as ProwlarrRelease[];
  // Filter to torrents only
  return releases.filter((r) => r.protocol === "torrent");
}

/**
 * Build search query variations from title and aliases
 * Returns unique queries optimized for different indexers
 */
function buildSearchQueries(title: string, aliases: string[]): string[] {
  const queries = new Set<string>();
  
  // Add the main title
  queries.add(title);
  
  // Add aliases
  for (const alias of aliases) {
    if (alias && alias.trim().length >= 2) {
      queries.add(alias.trim());
    }
  }
  
  // Extract base name (first word or before colon/dash)
  const baseName = title.split(/[:\-–]/)[0].trim();
  if (baseName.length >= 3 && baseName !== title) {
    queries.add(baseName);
  }
  
  // Clean title (remove special chars, keep alphanumeric and spaces)
  const cleanedTitle = title
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanedTitle !== title && cleanedTitle.length >= 3) {
    queries.add(cleanedTitle);
  }
  
  return [...queries];
}

/**
 * Run multiple search queries in parallel and combine results
 */
async function searchMultiQuery(
  queries: string[],
  tvdbId?: number
): Promise<ProwlarrRelease[]> {
  // For each query, run both search types
  const searchTypes: Array<"search" | "tvsearch"> = ["search", "tvsearch"];
  
  const allPromises = queries.flatMap((query) =>
    searchTypes.map((type) =>
      searchProwlarrNative({ query, type, tvdbId })
    )
  );

  if (isDev) {
    console.debug(`[anime-torrents] Running ${allPromises.length} parallel queries (${queries.length} queries × ${searchTypes.length} types)`);
    console.debug(`[anime-torrents] Queries: ${queries.join(", ")}`);
  }

  const results = await Promise.allSettled(allPromises);
  
  // Collect all successful results
  const allReleases: ProwlarrRelease[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      allReleases.push(...result.value);
    }
  }

  if (isDev) {
    console.debug(`[anime-torrents] Total raw results from all queries: ${allReleases.length}`);
  }

  return allReleases;
}

function transformProwlarrRelease(release: ProwlarrRelease): Normalized {
  const magnetUri = release.magnetUrl ?? undefined;
  const infoHash = release.infoHash?.toUpperCase() ?? extractInfoHash(magnetUri);
  const downloadUrl = isProwlarrDownloadUrl(release.downloadUrl)
    ? release.downloadUrl
    : undefined;

  // Extract language from Prowlarr response
  const languageAttr = release.languages?.map((l) => l.name).join(", ") || undefined;

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
    languageAttr,
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
    const key = it.infoHash || `${it.title.toLowerCase().replace(/\s+/g, " ").trim()}|${it.indexer}`;
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
      return NextResponse.json({ error: "Prowlarr configuration is missing." }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const titleParam = searchParams.get("title")?.trim();
    const seasonParam = searchParams.get("season");
    const episodeParam = searchParams.get("episode");
    const absoluteParam = searchParams.get("absolute");
    const origLangParam = (searchParams.get("origLang") || "ja").toLowerCase() as LangCode;
    const aliasParams = searchParams.getAll("alias").map((s) => s.trim()).filter(Boolean);

    if (!titleParam) {
      return NextResponse.json({ error: "Provide a title for the anime search." }, { status: 400 });
    }

    const seasonNum = toNumber(seasonParam) ?? 1;
    const episodeNum = toNumber(episodeParam);
    const absoluteNum = toNumber(absoluteParam) ?? episodeNum;
    const tvdbIdParam = searchParams.get("tvdbId");
    const tvdbId = tvdbIdParam ? parseInt(tvdbIdParam, 10) : undefined;

    const titleVariants = [titleParam, ...aliasParams];
    const seriesMatchers = buildSeriesMatchers(titleVariants);

    // Build multiple search queries from title and aliases
    const searchQueries = buildSearchQueries(titleParam, aliasParams);

    if (isDev) {
      console.debug(
        `[anime-torrents] Multi-query search: queries=${searchQueries.length} season=${seasonNum ?? "-"} episode=${episodeNum ?? "-"} tvdb=${tvdbId ?? "-"}`
      );
    }

    // Run multiple queries in parallel with both search types
    // This mimics how Stremio addons get comprehensive results
    const prowlarrResults = await searchMultiQuery(
      searchQueries,
      tvdbId && !Number.isNaN(tvdbId) ? tvdbId : undefined
    );

    if (isDev) {
      console.debug(`[anime-torrents] Combined results before dedup: ${prowlarrResults.length}`);
    }

    // Transform Prowlarr results to normalized format
    const all: Normalized[] = prowlarrResults.map(transformProwlarrRelease);

    // Apply language filter
    const allowedLangs = new Set<LangCode>([origLangParam || "ja"]);
    const langFiltered = all.filter((it) => isAllowedByLanguage(it.title, it.languageAttr, allowedLangs));

    const uniq = dedupeByHash(langFiltered);
    const ranked = rank(uniq);

    // Flag episode matches and season packs
    const wantEpisodeFilter = episodeNum != null || absoluteNum != null;
    const flagged = ranked.map((item) => {
      const matches = wantEpisodeFilter
        ? matchesEpisode(item.title, seasonNum ?? undefined, episodeNum ?? undefined, absoluteNum ?? undefined)
        : true;
      const packDetection =
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
      seriesMatchers.length > 0 ? list.filter((it) => matchesSeries(it.title, seriesMatchers)) : list;

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
          if (isDev) console.debug("[anime-torrents] magnet resolve (download) failed", err);
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
          if (isDev) console.debug("[anime-torrents] magnet resolve (torrent url) failed", err);
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
        ? `No torrents found for "${searchQueries.join(", ")}"`
        : undefined;

    return NextResponse.json({
      query: {
        title: titleParam,
        tvdbId: tvdbId ?? null,
        season: seasonNum ?? null,
        episode: episodeNum ?? null,
        absolute: absoluteNum ?? null,
        origLang: origLangParam,
        aliases: aliasParams,
        searchQueries,
      },
      providers: indexersUsed.map((name) => ({ name })),
      total: finalResults.length,
      results: finalResults,
      note,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (isDev) console.error("[anime-torrents] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
