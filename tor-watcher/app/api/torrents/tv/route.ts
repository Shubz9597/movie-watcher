import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

// ---- ENV ----
const PROWLARR_URL = process.env.PROWLARR_URL!;     // e.g. http://localhost:9696
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY!;

// Torznab movie category IDs (Movies/HD/UHD/Bluray/WEB)
const MOVIE_CATS = "2000,2040,2045,2050,2080";

// We will discover IDs dynamically, but filter by these names/implementations.
const INDEXER_MATCHES = [
  /torrentgalaxy/i,          // “torrentgalaxyclone” usually matches here
  /rarbg/i,                  // “therarbg”, “rarbg”
];

// ---------- Helpers ----------
function cleanImdbId(input?: string | null): string | null {
  if (!input) return null;
  const m = String(input).match(/(\d{6,8})$/);
  return m ? m[1] : null; // digits only
}

function isMagnet(u?: string | null): boolean {
  return !!u && u.startsWith("magnet:");
}

function extractInfoHash(magnet?: string | null): string | undefined {
  if (!magnet) return;
  const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/);
  return m?.[1]?.toUpperCase();
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
  const items =
    doc?.rss?.channel?.item
      ? Array.isArray(doc.rss.channel.item)
        ? doc.rss.channel.item
        : [doc.rss.channel.item]
      : [];

  return items.map((it: any) => {
    const title: string = it.title ?? "";
    const pubDate: string | undefined = it.pubDate;

    // enclosure url/type
    const enclosureUrl: string | undefined = it?.enclosure?.["@_url"];
    const enclosureType: string | undefined = it?.enclosure?.["@_type"];

    // Sometimes magnet is in guid or link
    const guidVal: string | undefined =
      typeof it.guid === "object" ? it.guid["#text"] : it.guid;
    const linkVal: string | undefined = it.link;

    // torznab attrs (seeders, peers, size, infohash, etc.)
    const attrs = it["torznab:attr"]
      ? Array.isArray(it["torznab:attr"])
        ? it["torznab:attr"]
        : [it["torznab:attr"]]
      : [];

    const attrMap = new Map<string, string>();
    for (const a of attrs) {
      if (a?.["@_name"]) attrMap.set(a["@_name"], a["@_value"]);
    }

    const size =
      Number(it.size) ||
      Number(attrMap.get("size")) ||
      undefined;

    const seeders = Number(attrMap.get("seeders")) || undefined;
    const peers = Number(attrMap.get("peers")) || undefined;
    const leechers =
      typeof peers === "number" && typeof seeders === "number"
        ? Math.max(peers - seeders, 0)
        : Number(attrMap.get("leechers")) || undefined;

    // choose magnet/torrent
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
    } satisfies Normalized;
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
      `${it.title.toLowerCase().replace(/\s+/g, " ").trim()}|${it.indexer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------- Prowlarr discovery ----------
async function discoverMovieIndexers(): Promise<
  { id: number; name: string }[]
> {
  const res = await fetch(`${PROWLARR_URL}/api/v1/indexer?apikey=${PROWLARR_API_KEY}`, {
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`Indexer list failed: ${res.status}`);
  const list = (await res.json()) as Array<{ id: number; name: string; implementationName?: string; implementation?: string }>;
  return list
    .filter((idx) => {
      const hay = `${idx.name} ${idx.implementationName ?? ""} ${idx.implementation ?? ""}`;
      return INDEXER_MATCHES.some((rx) => rx.test(hay));
    })
    .map((i) => ({ id: i.id, name: i.name }));
}

function buildMovieByImdbUrl(indexerId: number, imdbDigits: string) {
  const base = `${PROWLARR_URL}/${indexerId}/api`;
  return `${base}?t=movie&imdbid=tt${imdbDigits}&cat=${MOVIE_CATS}&limit=100&apikey=${PROWLARR_API_KEY}`;
}

function buildMovieByQueryUrl(indexerId: number, title: string, year?: string | null) {
  const q = encodeURIComponent(year ? `${title} ${year}` : title);
  const base = `${PROWLARR_URL}/${indexerId}/api`;
  return `${base}?t=movie&q=${q}&cat=${MOVIE_CATS}&limit=100&apikey=${PROWLARR_API_KEY}`;
}

// ---------- Route ----------
export async function GET(request: Request) {
  try {
    if (!PROWLARR_URL || !PROWLARR_API_KEY) {
      return NextResponse.json({ error: "Prowlarr configuration is missing." }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const imdbIdRaw = searchParams.get("imdbId");   // "tt1375666" or "1375666"
    const title = searchParams.get("title");        // fallback
    const year = searchParams.get("year");          // fallback

    const imdbDigits = cleanImdbId(imdbIdRaw);

    if (!imdbDigits && !title) {
      return NextResponse.json(
        { error: "Provide imdbId (ttXXXXXX or digits) or title (+ optional year)." },
        { status: 400 }
      );
    }

    // Discover IDs for TorrentGalaxyClone + RARBG only
    const providers = await discoverMovieIndexers();
    if (providers.length === 0) {
      return NextResponse.json({ results: [], note: "No IMDb-capable movie indexers found (TorrentGalaxyClone/RARBG)." });
    }

    // Build one URL per provider; prefer imdbid, fallback to title+year if needed.
    const urls = providers.map((p) =>
      imdbDigits ? { id: p.id, name: p.name, url: buildMovieByImdbUrl(p.id, imdbDigits) }
                 : { id: p.id, name: p.name, url: buildMovieByQueryUrl(p.id, title!, year) }
    );

    // Query in parallel
    const responses = await Promise.allSettled(
      urls.map(async (u) => {
        const r = await fetch(u.url, { next: { revalidate: 0 } });
        if (!r.ok) throw new Error(`${u.name} ${r.status}`);
        const xml = await r.text();
        return { id: u.id, name: u.name, xml };
      })
    );

    // Parse & normalize
    let all: Normalized[] = [];
    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      const { name, xml } = r.value;
      const items = parseTorznab(xml, name);
      all.push(...items);
    }

    // If IMDb search produced 0, try fallback title+year once
    if (all.length === 0 && imdbDigits && title) {
      const fallbackUrls = providers.map((p) => ({
        id: p.id,
        name: p.name,
        url: buildMovieByQueryUrl(p.id, title, year),
      }));
      const fb = await Promise.allSettled(
        fallbackUrls.map(async (u) => {
          const r = await fetch(u.url, { next: { revalidate: 0 } });
          if (!r.ok) throw new Error(`${u.name} ${r.status}`);
          const xml = await r.text();
          return { id: u.id, name: u.name, xml };
        })
      );
      for (const r2 of fb) {
        if (r2.status !== "fulfilled") continue;
        const { name, xml } = r2.value;
        all.push(...parseTorznab(xml, name));
      }
    }

    // Dedupe + rank
    const uniq = dedupeByHash(all);
    const ranked = rank(uniq);

    return NextResponse.json({
      query: { imdbId: imdbDigits ? `tt${imdbDigits}` : null, title, year },
      providers,
      total: ranked.length,
      results: ranked,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unexpected error" }, { status: 500 });
  }
}