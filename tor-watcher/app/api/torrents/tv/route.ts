import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { tmdb } from "@/lib/services/tmbd-service";

const PROWLARR_URL = process.env.PROWLARR_URL!;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY!;

const TV_CATS = "5000,5010,5020,5030,5040,5050,5060,5070,5080";

const INDEXER_MATCHES = [/torrentgalaxy/i, /rarbg/i, /eztv/i];

const PROWLARR_ORIGIN = new URL(PROWLARR_URL).origin;
const MAGNET_RX = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"' \r\n]*/i;
const isDev = process.env.NODE_ENV !== "production";

function cleanImdbId(input?: string | null): string | null {
  if (!input) return null;
  const m = String(input).match(/(\d{6,8})$/);
  return m ? m[1] : null;
}

function isMagnet(u?: string | null): boolean {
  return !!u && u.startsWith("magnet:");
}

function extractInfoHash(magnet?: string | null): string | undefined {
  if (!magnet) return;
  const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/);
  return m?.[1]?.toUpperCase();
}

function isProwlarrDownloadUrl(u?: string | null): boolean {
  if (!u) return false;
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
  const dn = title ? &dn= : "";
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
  ].map((t) => &tr=).join("");
  return magnet:?xt=urn:btih:;
}

async function fetchTitleFromImdb(imdbDigits: string): Promise<{ title?: string; year?: string } | undefined> {
  const imdbId = 	t;
  type FindResponse = {
    tv_results?: Array<{ name?: string; original_name?: string; first_air_date?: string | null }>;
  };
  try {
    const data = await tmdb<FindResponse>(/find/?external_source=imdb_id);
    const match = data.tv_results?.[0];
    if (!match) return undefined;
    const title = match.name || match.original_name || undefined;
    const year = match.first_air_date?.slice(0, 4) || undefined;
    if (!title) return undefined;
    return { title, year };
  } catch (err) {
    if (isDev) console.warn([tv-torrents] tmdb lookup failed for , err);
    return undefined;
  }
}

function pad(num: number, len = 2) {
  return String(num).padStart(len, "0");
}

function toNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildEpisodeQueries(title: string, season?: number, episode?: number, year?: string | null): string[] {
  const queries = new Set<string>();
  const base = title.trim();
  if (base) queries.add(base);
  if (year) queries.add(${base} );

  if (season != null && episode != null) {
    const s = pad(season);
    const e = pad(episode);
    queries.add(${base} SE);
    queries.add(${base} x);
  }

  if (season != null) {
    queries.add(${base} Season );
  }

  return [...queries];
}

type Normalized = {
  title: string;
  indexer: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  torrentUrl?: string;
  infoHash?: string;
  publishDate?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
});

function parseTorznab(xmlText: string, indexerName: string): Normalized[] {
  const doc = parser.parse(xmlText);
  const items = doc?.rss?.channel?.item
    ? Array.isArray(doc.rss.channel.item)
      ? doc.rss.channel.item
      : [doc.rss.channel.item]
    : [];

  return items.map((it: any) => {
    const title: string = it.title ?? "";
    const pubDate: string | undefined = it.pubDate;

    const enclosureUrl: string | undefined = it?.enclosure?.["@_url"];
    const enclosureType: string | undefined = it?.enclosure?.["@_type"];

    const guidVal: string | undefined =
      typeof it.guid === "object" ? it.guid["#text"] : it.guid;
    const linkVal: string | undefined = it.link;

    const attrs = it["torznab:attr"]
      ? Array.isArray(it["torznab:attr"])
        ? it["torznab:attr"]
        : [it["torznab:attr"]]
      : [];

    const attrMap = new Map<string, string>();
    for (const a of attrs) {
      if (a?.["@_name"]) attrMap.set(a["@_name"], a["@_value"]);
    }

    const size = Number(it.size) || Number(attrMap.get("size")) || undefined;

    const seeders = Number(attrMap.get("seeders")) || undefined;
    const peers = Number(attrMap.get("peers")) || undefined;
    const leechers =
      typeof peers === "number" && typeof seeders === "number"
        ? Math.max(peers - seeders, 0)
        : Number(attrMap.get("leechers")) || undefined;

    const magnetFromEnclosure =
      enclosureType?.includes("x-scheme-handler/magnet") && enclosureUrl
        ? enclosureUrl
        : undefined;
    const magnetFromGuid = isMagnet(guidVal) ? guidVal : undefined;
    const magnetFromLink = isMagnet(linkVal) ? linkVal : undefined;
    const magnetUri = magnetFromEnclosure || magnetFromGuid || magnetFromLink;

    const torrentUrl =
      enclosureType?.startsWith("application/x-bittorrent") && enclosureUrl
        ? enclosureUrl
        : linkVal?.endsWith(".torrent")
          ? linkVal
          : undefined;

    const infoHash =
      attrMap.get("infohash")?.toUpperCase() || extractInfoHash(magnetUri);

    return {
      title,
      indexer: indexerName,
      size,
      seeders,
      leechers,
      magnetUri,
      torrentUrl,
      infoHash,
      publishDate: pubDate,
    } as Normalized;
  });
}

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
      ${it.title.toLowerCase().replace(/\s+/g, " ").trim()}|;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function discoverTvIndexers(): Promise<{ id: number; name: string }[]> {
  const res = await fetch(${PROWLARR_URL}/api/v1/indexer?apikey=, {
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(Indexer list failed: );
  const list = (await res.json()) as Array<{ id: number; name: string; implementationName?: string; implementation?: string }>;
  return list
    .filter((idx) => {
      const hay = ${idx.name}  ;
      return INDEXER_MATCHES.some((rx) => rx.test(hay));
    })
    .map((i) => ({ id: i.id, name: i.name }));
}

function buildTvQueryUrl(indexerId: number, query: string, season?: number, episode?: number) {
  const url = new URL(${PROWLARR_URL}//api);
  url.searchParams.set("t", "tvsearch");
  url.searchParams.set("cat", TV_CATS);
  url.searchParams.set("limit", "100");
  url.searchParams.set("apikey", PROWLARR_API_KEY);
  url.searchParams.set("q", query);
  if (season != null) url.searchParams.set("season", String(season));
  if (episode != null) url.searchParams.set("ep", String(episode));
  return url.toString();
}

type Target = { id: number; name: string; query: string; url: string };

async function fetchFeeds(targets: Target[]) {
  return Promise.allSettled(
    targets.map(async (t) => {
      const res = await fetch(t.url, { next: { revalidate: 0 } });
      if (!res.ok) throw new Error(${t.name} );
      const xml = await res.text();
      return { id: t.id, name: t.name, query: t.query, xml };
    })
  );
}

export async function GET(request: Request) {
  try {
    if (!PROWLARR_URL || !PROWLARR_API_KEY) {
      return NextResponse.json({ error: "Prowlarr configuration is missing." }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const imdbIdRaw = searchParams.get("imdbId");
    const titleParam = searchParams.get("title");
    const yearParam = searchParams.get("year");
    const seasonParam = searchParams.get("season");
    const episodeParam = searchParams.get("episode");

    const imdbDigits = cleanImdbId(imdbIdRaw);
    let queryTitle = titleParam?.trim() || undefined;
    let queryYear = yearParam?.trim() || undefined;
    let querySource: "client" | "tmdb" | undefined = queryTitle ? "client" : undefined;

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
    const queryStrings = buildEpisodeQueries(queryTitle, seasonNum, episodeNum, queryYear);
    if (queryStrings.length === 0) queryStrings.push(queryTitle);

    const providers = await discoverTvIndexers();
    if (providers.length === 0) {
      return NextResponse.json({ results: [], note: "No TV indexers (TorrentGalaxy, RARBG, EZTV) are enabled in Prowlarr." });
    }

    const targets: Target[] = providers.flatMap((p) =>
      queryStrings.map((q) => ({
        id: p.id,
        name: p.name,
        query: q,
        url: buildTvQueryUrl(p.id, q, seasonNum, episodeNum),
      }))
    );

    if (isDev) {
      console.debug(
        [tv-torrents] providers= queries= title="" season= episode=
      );
    }

    const responses = await fetchFeeds(targets);

    const all: Normalized[] = [];
    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      const { name, xml } = r.value;
      all.push(...parseTorznab(xml, name));
    }

    const uniq = dedupeByHash(all);
    const ranked = rank(uniq);

    for (const item of ranked.slice(0, 10)) {
      if (item.magnetUri?.startsWith("magnet:")) continue;
      if (isHttpUrl(item.torrentUrl)) {
        try {
          const resolved = await resolveDownloadToMagnet(item.torrentUrl);
          if (resolved) {
            item.magnetUri = resolved;
            if (isDev) {
              console.debug(
                [tv-torrents] magnet resolved from 
              );
            }
            continue;
          }
        } catch (err) {
          if (isDev) console.debug("[tv-torrents] magnet resolve failed", err);
        }
      }
      if (!item.magnetUri && item.infoHash) {
        item.magnetUri = magnetFromHash(item.infoHash, item.title);
      }
    }

    const note =
      ranked.length === 0
        ? No torrents returned from  providers (queries tried: )
        : undefined;

    return NextResponse.json({
      query: {
        imdbId: imdbDigits ? 	t : null,
        title: queryTitle,
        year: queryYear ?? null,
        season: seasonNum ?? null,
        episode: episodeNum ?? null,
        querySource: querySource ?? null,
        queriesTried: queryStrings,
      },
      providers,
      total: ranked.length,
      results: ranked,
      note,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unexpected error" }, { status: 500 });
  }
}