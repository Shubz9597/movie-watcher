import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

const PROWLARR_URL = process.env.PROWLARR_URL!;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY!;

const MOVIE_CATS = "2000,2040,2045,2050,2080";

const INDEXER_MATCHES = [
  /eztv/i,
  /kickass/i,
  /eztv/i,
  /kickass/i,
  /limetorrents/i,
  /magnetdownload/i,
  /nyaa/i,
  /pirate\s*bay/i,
  /subsplease/i,
  /therarbg/i,
  /torrentgalaxy/i,
  /yts/i,
];

const PROWLARR_ORIGIN = new URL(PROWLARR_URL).origin;
const MAGNET_RX = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"' \r\n]*/i;
const isDev = process.env.NODE_ENV !== "production";

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
          // ignore invalid redirect target
        }
      }

      const ct = res.headers.get("content-type") || "";
      if (/text\/html|application\/json/i.test(ct)) {
        const body = await res.text();
        const inlineMagnet = body.match(MAGNET_RX);
        if (inlineMagnet) return inlineMagnet[0];
      }

      break; // no redirect to chase and no inline magnet
    }
    return undefined;
  } finally {
    clearTimeout(to);
  }
}

// If we at least have an infohash, synthesize a magnet.
function magnetFromHash(infoHash?: string, title?: string) {
  if (!infoHash) return undefined;
  const dn = title ? `&dn=${encodeURIComponent(title)}` : "";
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
  ].map(t => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash.toUpperCase()}${dn}${trackers}`;
}

/* ---------- Language helpers ---------- */
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

// treat “ESubs/Eng Subs/Subbed” as *subtitles*, not English audio
const SUBS_ONLY_RX = /\b(e-?subs?|eng(?:lish)?\s*subs?|subbed)\b/i;
const MULTI_OR_DUAL_RX = /\b(multi|dual(?:\s*audio)?)\b/i;
const DUB_RX = /\b(dub|dubbed)\b/i;

function normalizeAttrLang(v?: string): LangCode | undefined {
  if (!v) return;
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

  // Handle “Hindi Dubbed”, “Eng Dub”, etc.
  if (DUB_RX.test(t)) anyExplicit = true;
  if (MULTI_OR_DUAL_RX.test(t)) anyExplicit = true; // treat as explicit, but we still need ENG presence

  // Don’t count ESubs/Subbed as English audio
  if (SUBS_ONLY_RX.test(t) && !langs.has("en")) {
    // subtitles only; ignore as English audio
  }

  return { anyExplicit, langs };
}

function isAllowedByLanguage(
  title: string,
  attrLang?: string | undefined,
  allowed: Set<LangCode> = new Set<LangCode>(["en"])
): boolean {
  // 1) Torznab attribute wins if present
  const attr = normalizeAttrLang(attrLang);
  if (attr) return allowed.has(attr);

  // 2) Title heuristics
  const { anyExplicit, langs } = detectLangFromTitle(title);

  // If explicit languages appear:
  if (anyExplicit && langs.size > 0) {
    // MULTI/DUAL without “english” should be rejected when only EN is allowed
    if (MULTI_OR_DUAL_RX.test(title) && !/english|eng(?!\w)/i.test(title)) {
      return [...allowed].some((lc) => langs.has(lc)); // allow if includes origLang when provided
    }
    // keep only if at least one explicit lang is allowed
    return [...langs].some((lc) => allowed.has(lc));
  }

  // No explicit language? keep it (most scene releases are EN by default)
  return true;
}

/* ---------- your existing helpers ---------- */
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
  languageAttr?: string; // ⬅️ NEW: keep attr if provided
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

    const guidVal: string | undefined = typeof it.guid === "object" ? it.guid["#text"] : it.guid;
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
      enclosureType?.includes("x-scheme-handler/magnet") && enclosureUrl ? enclosureUrl : undefined;
    const magnetFromGuid = isMagnet(guidVal) ? guidVal : undefined;
    const magnetFromLink = isMagnet(linkVal) ? linkVal : undefined;
    const magnetUri = magnetFromEnclosure || magnetFromGuid || magnetFromLink;

    const torrentUrl =
      enclosureType?.startsWith("application/x-bittorrent") && enclosureUrl
        ? enclosureUrl
        : linkVal?.endsWith(".torrent")
          ? linkVal
          : undefined;

    const infoHash = attrMap.get("infohash")?.toUpperCase() || extractInfoHash(magnetUri);
    const languageAttr = attrMap.get("language") || attrMap.get("lang") || attrMap.get("audio");

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
      languageAttr,
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
    const key = it.infoHash || `${it.title.toLowerCase().replace(/\s+/g, " ").trim()}|${it.indexer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* ---------- indexer discovery & url builders (unchanged) ---------- */
async function discoverMovieIndexers(): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`${PROWLARR_URL}/api/v1/indexer?apikey=${PROWLARR_API_KEY}`, { next: { revalidate: 0 } });
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

/* ---------- Route ---------- */
export async function GET(request: Request) {
  try {
    if (!PROWLARR_URL || !PROWLARR_API_KEY) {
      return NextResponse.json({ error: "Prowlarr configuration is missing." }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const imdbIdRaw = searchParams.get("imdbId");
    const title = searchParams.get("title");
    const year = searchParams.get("year");
    const origLangParam = (searchParams.get("origLang") || "en").toLowerCase() as LangCode;

    const imdbDigits = cleanImdbId(imdbIdRaw);
    if (!imdbDigits && !title) {
      return NextResponse.json({ error: "Provide imdbId (ttXXXXXX or digits) or title (+ optional year)." }, { status: 400 });
    }

    const providers = await discoverMovieIndexers();
    if (providers.length === 0) {
      return NextResponse.json({ results: [], note: "No IMDb-capable movie indexers found (TorrentGalaxyClone/RARBG)." });
    }

    const trimmedTitle = title?.trim();
    const searchModes: Array<"imdb" | "query"> = [];
    if (imdbDigits) searchModes.push("imdb");
    if (trimmedTitle) searchModes.push("query");
    const urls = providers.flatMap((p) =>
      searchModes.map((mode) => ({
        id: p.id,
        name: p.name,
        mode,
        url:
          mode === "imdb"
            ? buildMovieByImdbUrl(p.id, imdbDigits!)
            : buildMovieByQueryUrl(p.id, trimmedTitle!, year),
      }))
    );

    if (isDev) {
      console.debug(
        `[movie-torrents] providers=${providers.length} searches=${urls.length} modes=${searchModes.join(",") || "query"}`
      );
    }

    const responses = await Promise.allSettled(
      urls.map(async (u) => {
        const r = await fetch(u.url, { next: { revalidate: 0 } });
        if (!r.ok) throw new Error(`${u.name} ${r.status}`);
        const xml = await r.text();
        return { id: u.id, name: u.name, xml };
      })
    );

    let all: Normalized[] = [];
    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      const { name, xml } = r.value;
      all.push(...parseTorznab(xml, name));
    }

    /* ---------- LANGUAGE FILTER HERE ---------- */
    // Allow English by default; if original language is not English, also allow that code.
    const allowed = new Set<LangCode>(["en"]);
    if (origLangParam && origLangParam !== "en") allowed.add(origLangParam);

    const langFiltered = all.filter((it) =>
      isAllowedByLanguage(it.title, it.languageAttr, allowed)
    );

    const uniq = dedupeByHash(langFiltered);
    const ranked = rank(uniq);

    const TOP = 10; // keep this small to avoid hammering Prowlarr
    const toFix = ranked.slice(0, TOP);

    // Resolve sequentially (safe); bump to small parallel if you want
    for (const it of toFix) {
      if (it.magnetUri?.startsWith("magnet:")) continue;

      // Try resolving HTTP(S) torrent/download URLs into magnets
      if (isHttpUrl(it.torrentUrl)) {
        try {
          const resolved = await resolveDownloadToMagnet(it.torrentUrl);
          if (resolved) {
            it.magnetUri = resolved;
            if (isDev) {
              console.debug(
                `[movie-torrents] magnet resolved from ${isProwlarrDownloadUrl(it.torrentUrl) ? "prowlarr" : "http"}`
              );
            }
            continue;
          }
        } catch (err) {
          if (isDev) {
            console.debug("[movie-torrents] magnet resolve failed", err);
          }
        }
      }

      // Last resort: synthesize from infohash (works in most players)
      if (!it.magnetUri && it.infoHash) {
        it.magnetUri = magnetFromHash(it.infoHash, it.title);
      }
    }

    return NextResponse.json({
      query: {
        imdbId: imdbDigits ? `tt${imdbDigits}` : null,
        title,
        year,
        origLang: origLangParam,
      },
      providers,
      total: ranked.length,
      results: ranked,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unexpected error" }, { status: 500 });
  }
}