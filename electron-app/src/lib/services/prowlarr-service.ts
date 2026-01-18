// Complete Prowlarr service with XML parsing - standalone, no Next.js needed
import { XMLParser } from 'fast-xml-parser';
import { getConfig } from '../config';
import { matchesEpisode, detectSeasonPack, type SeasonPackDetection } from '../anime-matching';

const MOVIE_CATS = '2000,2040,2045,2050,2080';
const TV_CATS = [5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070, 5080];
const ANIME_CATS = [5070, 5080, 5000, 5010];

const INDEXER_MATCHES = [
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

const MAGNET_RX = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"' \r\n]*/i;

// Rate limiting and caching
const REQUEST_CACHE = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MIN_REQUEST_INTERVAL = 500; // Minimum 500ms between requests
let lastRequestTime = 0;
const requestQueue: Array<() => Promise<any>> = [];
let isProcessingQueue = false;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  // Check cache first
  const cacheKey = url;
  const cached = REQUEST_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[prowlarr] Using cached result for:', url.substring(0, 100));
    // Return a Response-like object that can be used with res.json() and res.text()
    const cachedData = cached.data;
    const cachedResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => cachedData,
      text: async () => typeof cachedData === 'string' ? cachedData : JSON.stringify(cachedData),
      clone: function() { return this; },
    } as Response;
    return cachedResponse;
  }

  // Rate limiting: ensure minimum interval between requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const delay = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    console.log(`[prowlarr] Rate limiting: waiting ${delay}ms before next request`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();

  // Make the request with exponential backoff on 429
  let retries = 0;
  const maxRetries = 3;
  let lastResponse: Response | null = null;
  
  while (retries <= maxRetries) {
    const res = await fetch(url, options);
    lastResponse = res;
    
    if (res.status === 429 && retries < maxRetries) {
      const retryAfter = res.headers.get('retry-after');
      const delayMs = retryAfter 
        ? parseInt(retryAfter, 10) * 1000 
        : Math.min(1000 * Math.pow(2, retries), 10000); // Exponential backoff, max 10s
      
      console.warn(`[prowlarr] Rate limited (429), waiting ${delayMs}ms before retry ${retries + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      retries++;
      continue;
    }
    
    // Cache successful responses
    if (res.ok) {
      try {
        const cloned = res.clone();
        const data = await cloned.json();
        REQUEST_CACHE.set(cacheKey, { data, timestamp: Date.now() });
        // Clean old cache entries periodically
        if (REQUEST_CACHE.size > 100) {
          const cutoff = Date.now() - CACHE_TTL;
          for (const [key, value] of REQUEST_CACHE.entries()) {
            if (value.timestamp < cutoff) {
              REQUEST_CACHE.delete(key);
            }
          }
        }
      } catch {
        // Ignore cache errors
      }
    }
    
    return res;
  }
  
  // If we exhausted retries, return the last response
  return lastResponse!;
}

type LangCode =
  | 'en'
  | 'hi'
  | 'ta'
  | 'te'
  | 'ml'
  | 'kn'
  | 'ko'
  | 'ja'
  | 'zh'
  | 'fr'
  | 'de'
  | 'es'
  | 'pt'
  | 'ru'
  | 'it'
  | 'tr'
  | 'ar'
  | 'pl'
  | 'th'
  | 'id'
  | 'vi'
  | 'uk'
  | 'fa';

const LANG_PATTERNS: Array<{ code: LangCode; rx: RegExp }> = [
  { code: 'en', rx: /\b(english|eng(?!\w)|en[-_. ]?(us|gb|uk))\b/i },
  { code: 'hi', rx: /\b(hindi|hin(?:di)?|hind)\b/i },
  { code: 'ta', rx: /\b(tamil)\b/i },
  { code: 'te', rx: /\b(telugu)\b/i },
  { code: 'ml', rx: /\b(malayalam)\b/i },
  { code: 'kn', rx: /\b(kannada)\b/i },
  { code: 'ko', rx: /\b(korean|kor(?!\w))\b/i },
  { code: 'ja', rx: /\b(japanese|jpn|jap(?!\w))\b/i },
  { code: 'zh', rx: /\b(chinese|mandarin|cantonese|chi(?!\w))\b/i },
  { code: 'fr', rx: /\b(french|fra|vf|vostfr)\b/i },
  { code: 'de', rx: /\b(german|deu|ger(?!\w))\b/i },
  { code: 'es', rx: /\b(spanish|spa|latino|castellano)\b/i },
  { code: 'pt', rx: /\b(portuguese|português|pt[-_. ]?br|brazilian|dublado)\b/i },
  { code: 'ru', rx: /\b(russian|rus(?!\w))\b/i },
  { code: 'it', rx: /\b(italian|ita(?!\w))\b/i },
  { code: 'tr', rx: /\b(turkish|turk(?!\w))\b/i },
  { code: 'ar', rx: /\b(arabic|ara(?!\w))\b/i },
  { code: 'pl', rx: /\b(polish|pol(?!\w))\b/i },
  { code: 'th', rx: /\b(thai|tha(?!\w))\b/i },
  { code: 'id', rx: /\b(indonesian|indo)\b/i },
  { code: 'vi', rx: /\b(vietnamese|viet)\b/i },
  { code: 'uk', rx: /\b(ukrainian|ukr(?!\w))\b/i },
  { code: 'fa', rx: /\b(persian|farsi)\b/i },
];

const SUBS_ONLY_RX = /\b(e-?subs?|eng(?:lish)?\s*subs?|subbed)\b/i;
const MULTI_OR_DUAL_RX = /\b(multi|dual(?:\s*audio)?)\b/i;
const DUB_RX = /\b(dub|dubbed)\b/i;

function normalizeAttrLang(v?: string): LangCode | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('hi')) return 'hi';
  if (s.startsWith('ta')) return 'ta';
  if (s.startsWith('te')) return 'te';
  if (s.startsWith('ml')) return 'ml';
  if (s.startsWith('kn')) return 'kn';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('ja') || s.startsWith('jp')) return 'ja';
  if (s.startsWith('zh') || s.includes('mandarin') || s.includes('cantonese')) return 'zh';
  if (s.startsWith('fr')) return 'fr';
  if (s.startsWith('de')) return 'de';
  if (s.startsWith('es') || s.includes('latino')) return 'es';
  if (s.startsWith('pt') || s.includes('brazil')) return 'pt';
  if (s.startsWith('ru')) return 'ru';
  if (s.startsWith('it')) return 'it';
  if (s.startsWith('tr')) return 'tr';
  if (s.startsWith('ar')) return 'ar';
  if (s.startsWith('pl')) return 'pl';
  if (s.startsWith('th')) return 'th';
  if (s.startsWith('id')) return 'id';
  if (s.startsWith('vi')) return 'vi';
  if (s.startsWith('uk')) return 'uk';
  if (s.startsWith('fa') || s.includes('farsi')) return 'fa';
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

  if (SUBS_ONLY_RX.test(t) && !langs.has('en')) {
    // subtitles only; ignore as English audio
  }

  return { anyExplicit, langs };
}

function isAllowedByLanguage(title: string, attrLang?: string, allowed: Set<LangCode> = new Set<LangCode>(['en'])): boolean {
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

function cleanImdbId(input?: string | null): string | null {
  if (!input) return null;
  const m = String(input).match(/(\d{6,8})$/);
  return m ? m[1] : null;
}

function isMagnet(u?: string | null): boolean {
  return !!u && u.startsWith('magnet:');
}

function extractInfoHash(magnet?: string | null): string | undefined {
  if (!magnet) return undefined;
  const m = magnet.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/);
  return m?.[1]?.toUpperCase();
}

function isProwlarrDownloadUrl(u: string | undefined | null, prowlarrUrl: string): boolean {
  if (!u || !prowlarrUrl) return false;
  try {
    const x = new URL(u, prowlarrUrl);
    const origin = new URL(prowlarrUrl).origin;
    return x.origin === origin && /\/download\b/i.test(x.pathname);
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
      const res = await fetch(current, { redirect: 'manual', cache: 'no-store', signal: ctrl.signal });
      const loc = res.headers.get('location');
      if (loc?.startsWith('magnet:')) return loc;
      if (loc) {
        try {
          const next = new URL(loc, current).href;
          if (next.startsWith('magnet:')) return next;
          if (res.status >= 300 && res.status < 400) {
            current = next;
            continue;
          }
        } catch {
          // ignore invalid redirect target
        }
      }

      const ct = res.headers.get('content-type') || '';
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
  const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
  const trackers = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce']
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join('');
  return `magnet:?xt=urn:btih:${infoHash.toUpperCase()}${dn}${trackers}`;
}

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
  seasonPack?: {
    season?: number | null;
    reason?: string | null;
    keywords?: string[];
  } | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
});

type TorznabAttr = { '@_name'?: string; '@_value'?: string };
type TorznabItem = {
  title?: string;
  pubDate?: string;
  size?: number | string;
  link?: string;
  guid?: string | { '#text'?: string };
  enclosure?: { '@_url'?: string; '@_type'?: string };
  'torznab:attr'?: TorznabAttr | TorznabAttr[];
};

function parseTorznab(xmlText: string, indexerName: string): Normalized[] {
  const doc = parser.parse(xmlText);
  const items: TorznabItem[] = doc?.rss?.channel?.item
    ? Array.isArray(doc.rss.channel.item)
      ? doc.rss.channel.item
      : [doc.rss.channel.item]
    : [];

  return items.map((it) => {
    const title: string = it.title ?? '';
    const pubDate: string | undefined = it.pubDate;

    const enclosureUrl: string | undefined = it?.enclosure?.['@_url'];
    const enclosureType: string | undefined = it?.enclosure?.['@_type'];

    const guidVal: string | undefined = typeof it.guid === 'object' ? it.guid['#text'] : it.guid;
    const linkVal: string | undefined = it.link;

    const attrs = it['torznab:attr']
      ? Array.isArray(it['torznab:attr'])
        ? it['torznab:attr']
        : [it['torznab:attr']]
      : [];
    const attrMap = new Map<string, string>();
    for (const a of attrs) {
      if (a?.['@_name']) attrMap.set(a['@_name'], a['@_value'] ?? '');
    }

    const size = Number(it.size) || Number(attrMap.get('size')) || undefined;
    const seeders = Number(attrMap.get('seeders')) || undefined;
    const peers = Number(attrMap.get('peers')) || undefined;
    const leechers =
      typeof peers === 'number' && typeof seeders === 'number'
        ? Math.max(peers - seeders, 0)
        : Number(attrMap.get('leechers')) || undefined;

    const magnetFromEnclosure =
      enclosureType?.includes('x-scheme-handler/magnet') && enclosureUrl ? enclosureUrl : undefined;
    const magnetFromGuid = isMagnet(guidVal) ? guidVal : undefined;
    const magnetFromLink = isMagnet(linkVal) ? linkVal : undefined;
    const magnetUri = magnetFromEnclosure || magnetFromGuid || magnetFromLink;

    const torrentUrl =
      enclosureType?.startsWith('application/x-bittorrent') && enclosureUrl
        ? enclosureUrl
        : linkVal?.endsWith('.torrent')
          ? linkVal
          : undefined;

    const infoHash = attrMap.get('infohash')?.toUpperCase() || extractInfoHash(magnetUri);
    const languageAttr = attrMap.get('language') || attrMap.get('lang') || attrMap.get('audio');

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
  if (t.includes('2160p') || t.includes('4k')) return 3;
  if (t.includes('1080p')) return 2;
  if (t.includes('720p')) return 1;
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
    const key = it.infoHash || `${it.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${it.indexer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function getProwlarrConfig() {
  const url = (await getConfig('PROWLARR_URL')) || '';
  const apiKey = (await getConfig('PROWLARR_API_KEY')) || '';
  if (!url || !apiKey) {
    throw new Error('Prowlarr not configured. Please set PROWLARR_URL and PROWLARR_API_KEY in settings.');
  }
  return { url, apiKey };
}

async function discoverMovieIndexers(prowlarrUrl: string, apiKey: string): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`${prowlarrUrl}/api/v1/indexer?apikey=${apiKey}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Indexer list failed: ${res.status}`);
  const list = (await res.json()) as Array<{
    id: number;
    name: string;
    implementationName?: string;
    implementation?: string;
  }>;
  return list
    .filter((idx) => {
      const hay = `${idx.name} ${idx.implementationName ?? ''} ${idx.implementation ?? ''}`;
      return INDEXER_MATCHES.some((rx) => rx.test(hay));
    })
    .map((i) => ({ id: i.id, name: i.name }));
}

function buildMovieByImdbUrl(prowlarrUrl: string, apiKey: string, indexerId: number, imdbDigits: string) {
  const base = `${prowlarrUrl}/${indexerId}/api`;
  return `${base}?t=movie&imdbid=tt${imdbDigits}&cat=${MOVIE_CATS}&limit=100&apikey=${apiKey}`;
}

function buildMovieByQueryUrl(prowlarrUrl: string, apiKey: string, indexerId: number, title: string, year?: string | null) {
  const q = encodeURIComponent(year ? `${title} ${year}` : title);
  const base = `${prowlarrUrl}/${indexerId}/api`;
  return `${base}?t=movie&q=${q}&cat=${MOVIE_CATS}&limit=100&apikey=${apiKey}`;
}

export async function searchMovieTorrents(params: {
  imdbId?: string;
  title?: string;
  year?: number;
  originalLanguage?: string;
}) {
  const { url: prowlarrUrl, apiKey } = await getProwlarrConfig();

  const imdbDigits = cleanImdbId(params.imdbId);
  if (!imdbDigits && !params.title) {
    throw new Error('Provide imdbId (ttXXXXXX or digits) or title (+ optional year).');
  }

  // Use Prowlarr's unified search API - single call
  const searchUrl = new URL(`${prowlarrUrl}/api/v1/search`);
  searchUrl.searchParams.set('type', 'movie');
  
  // Use both IMDB and title if available (Prowlarr supports both simultaneously)
  if (imdbDigits) {
    searchUrl.searchParams.set('imdbId', `tt${imdbDigits}`);
  }
  if (params.title) {
    const query = params.year ? `${params.title} ${params.year}` : params.title;
    searchUrl.searchParams.set('query', query);
  }
  
  const movieCats = MOVIE_CATS.split(',').map(c => c.trim());
  for (const cat of movieCats) {
    searchUrl.searchParams.append('categories', cat);
  }
  searchUrl.searchParams.set('limit', '100');
  
  // Add API key as query parameter (fallback if header doesn't work)
  searchUrl.searchParams.set('apikey', apiKey);

  console.log('[prowlarr] Searching movies:', { imdbId: imdbDigits ? `tt${imdbDigits}` : null, title: params.title, year: params.year });

  // Use rate-limited fetch
  const res = await rateLimitedFetch(searchUrl.toString(), {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    cache: 'no-store',
  });

  // Handle specific error codes
  if (res.status === 410) {
    console.warn('[prowlarr] Prowlarr returned 410 (Gone)');
    return { query: { imdbId: imdbDigits ? `tt${imdbDigits}` : null, title: params.title, year: params.year }, total: 0, results: [] };
  }
  
  if (res.status === 429) {
    console.warn('[prowlarr] Still rate limited after all retries');
    return { query: { imdbId: imdbDigits ? `tt${imdbDigits}` : null, title: params.title, year: params.year }, total: 0, results: [] };
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    console.error(`[prowlarr] Search failed: ${res.status} ${res.statusText}`, errorText);
    throw new Error(`Prowlarr search failed: ${res.status} - ${errorText.substring(0, 200)}`);
  }

  let releases: Array<{
    title: string;
    indexer: string;
    size: number;
    seeders?: number;
    leechers?: number;
    magnetUrl?: string;
    downloadUrl?: string;
    infoHash?: string;
    publishDate?: string;
  }>;

  try {
    // Read response text first (before json() consumes it)
    const responseText = await res.text();
    console.log('[prowlarr] Raw response (first 1000 chars):', responseText.substring(0, 1000));
    
    // Parse JSON from the text
    const jsonData = JSON.parse(responseText);
    
    // Log the raw response for debugging
    console.log('[prowlarr] Parsed response type:', typeof jsonData, 'isArray:', Array.isArray(jsonData));
    if (!Array.isArray(jsonData) && jsonData) {
      console.log('[prowlarr] Response keys:', Object.keys(jsonData));
      if (jsonData.results !== undefined) {
        console.log('[prowlarr] results is array?', Array.isArray(jsonData.results), 'length:', Array.isArray(jsonData.results) ? jsonData.results.length : 'N/A');
      }
      if (jsonData.data !== undefined) {
        console.log('[prowlarr] data is array?', Array.isArray(jsonData.data), 'length:', Array.isArray(jsonData.data) ? jsonData.data.length : 'N/A');
      }
    }
    
    // Handle both array response and object with results array
    if (Array.isArray(jsonData)) {
      releases = jsonData;
      console.log('[prowlarr] Response is direct array, length:', releases.length);
    } else if (jsonData && Array.isArray(jsonData.results)) {
      releases = jsonData.results;
      console.log('[prowlarr] Found releases in results array, length:', releases.length);
    } else if (jsonData && Array.isArray(jsonData.data)) {
      releases = jsonData.data;
      console.log('[prowlarr] Found releases in data array, length:', releases.length);
    } else if (jsonData && typeof jsonData === 'object') {
      // Try to find any array property
      const keys = Object.keys(jsonData);
      for (const key of keys) {
        if (Array.isArray(jsonData[key])) {
          console.log(`[prowlarr] Found releases array in key: ${key}, length: ${jsonData[key].length}`);
          releases = jsonData[key];
          break;
        }
      }
      if (releases === undefined) {
        console.warn('[prowlarr] Unexpected response format, no array found. Full response:', JSON.stringify(jsonData, null, 2).substring(0, 1000));
        releases = [];
      }
    } else {
      console.warn('[prowlarr] Unexpected response format:', jsonData);
      releases = [];
    }
  } catch (parseErr) {
    console.error('[prowlarr] Failed to parse JSON response:', parseErr);
    // Try to get response text for debugging
    const text = await res.clone().text().catch(() => '');
    console.error('[prowlarr] Response text:', text.substring(0, 1000));
    throw new Error(`Prowlarr response parse error: ${parseErr}`);
  }

  console.log(`[prowlarr] Final releases count: ${releases.length}`);
  if (releases.length === 0) {
    console.warn('[prowlarr] No releases found - this might be normal for new/unreleased content');
    console.warn('[prowlarr] Search URL was:', searchUrl.toString().replace(/apikey=[^&]+/, 'apikey=***'));
  } else {
    // Log sample of first release to debug structure
    console.log('[prowlarr] Sample release:', JSON.stringify(releases[0], null, 2).substring(0, 500));
  }

  const all: Normalized[] = releases
    .filter((r) => {
      const hasMagnet = r.magnetUrl && r.magnetUrl.length > 0;
      const hasDownload = r.downloadUrl && r.downloadUrl.length > 0;
      if (!hasMagnet && !hasDownload && releases.length > 0) {
        console.debug('[prowlarr] Filtering release without magnet/download:', r.title?.substring(0, 50));
      }
      return hasMagnet || hasDownload;
    })
    .map((r) => {
      const magnetUri = r.magnetUrl || undefined;
      const infoHash = r.infoHash?.toUpperCase() || extractInfoHash(magnetUri);
      return {
        title: r.title,
        indexer: r.indexer,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        magnetUri,
        torrentUrl: r.downloadUrl?.endsWith('.torrent') ? r.downloadUrl : undefined,
        downloadUrl: isProwlarrDownloadUrl(r.downloadUrl, prowlarrUrl) ? r.downloadUrl : undefined,
        infoHash,
        publishDate: r.publishDate,
      };
    });

  const origLangParam = (params.originalLanguage || 'en').toLowerCase() as LangCode;
  const allowed = new Set<LangCode>(['en']);
  if (origLangParam && origLangParam !== 'en') allowed.add(origLangParam);

  const langFiltered = all.filter((it) => isAllowedByLanguage(it.title, it.languageAttr, allowed));

  const uniq = dedupeByHash(langFiltered);
  const ranked = rank(uniq);

  const TOP = 10;
  const toFix = ranked.slice(0, TOP);

  for (const it of toFix) {
    if (it.magnetUri?.startsWith('magnet:')) continue;

    if (isHttpUrl(it.torrentUrl)) {
      try {
        const resolved = await resolveDownloadToMagnet(it.torrentUrl);
        if (resolved) {
          it.magnetUri = resolved;
          continue;
        }
      } catch (err) {
        console.debug('[prowlarr] magnet resolve failed', err);
      }
    }

    if (!it.magnetUri && it.infoHash) {
      it.magnetUri = magnetFromHash(it.infoHash, it.title);
    }
  }

  return {
    query: {
      imdbId: imdbDigits ? `tt${imdbDigits}` : null,
      title: params.title,
      year: params.year,
      origLang: origLangParam,
    },
    total: ranked.length,
    results: ranked,
  };
}

// TV and Anime torrent search - similar implementations
export async function searchTvTorrents(params: {
  imdbId?: string;
  title?: string;
  season?: number;
  episode?: number;
  year?: number;
  tvdbId?: number;
  aliases?: string[];
}) {
  const { url: prowlarrUrl, apiKey } = await getProwlarrConfig();

  // Use Prowlarr native search API for TV (simpler than Torznab)
  const searchUrl = new URL(`${prowlarrUrl}/api/v1/search`);
  searchUrl.searchParams.set('query', params.title || '');
  searchUrl.searchParams.set('type', 'tvsearch');
  if (params.season != null) searchUrl.searchParams.set('season', String(params.season));
  if (params.episode != null) searchUrl.searchParams.set('episode', String(params.episode));
  if (params.imdbId) {
    const digits = cleanImdbId(params.imdbId);
    if (digits) searchUrl.searchParams.set('imdbId', `tt${digits}`);
  }
  if (params.tvdbId) searchUrl.searchParams.set('tvdbId', String(params.tvdbId));
  for (const cat of TV_CATS) {
    searchUrl.searchParams.append('categories', String(cat));
  }
  searchUrl.searchParams.set('limit', '100');
  searchUrl.searchParams.set('apikey', apiKey);

  console.log('[prowlarr] Searching TV:', { title: params.title, season: params.season, episode: params.episode });

  // Use rate-limited fetch
  const res = await rateLimitedFetch(searchUrl.toString(), {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    cache: 'no-store',
  });

  // Handle specific error codes
  if (res.status === 410) {
    console.warn('[prowlarr] Prowlarr returned 410 (Gone)');
    return { query: params, total: 0, results: [] };
  }
  
  if (res.status === 429) {
    console.warn('[prowlarr] Still rate limited after all retries');
    return { query: params, total: 0, results: [] };
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    console.error(`[prowlarr] TV search failed: ${res.status} ${res.statusText}`, errorText);
    throw new Error(`Prowlarr search failed: ${res.status} - ${errorText.substring(0, 200)}`);
  }

  let releases: Array<{
    title: string;
    indexer: string;
    size: number;
    seeders?: number;
    leechers?: number;
    magnetUrl?: string;
    downloadUrl?: string;
    infoHash?: string;
    publishDate?: string;
  }>;

  try {
    const jsonData = await res.json();
    if (Array.isArray(jsonData)) {
      releases = jsonData;
    } else if (jsonData && Array.isArray(jsonData.results)) {
      releases = jsonData.results;
    } else if (jsonData && Array.isArray(jsonData.data)) {
      releases = jsonData.data;
    } else {
      console.warn('[prowlarr] Unexpected TV response format:', jsonData);
      releases = [];
    }
  } catch (parseErr) {
    console.error('[prowlarr] Failed to parse TV JSON response:', parseErr);
    throw new Error(`Prowlarr response parse error: ${parseErr}`);
  }

  console.log(`[prowlarr] Received ${releases.length} TV releases`);

  const all: Normalized[] = releases
    .filter((r) => r.magnetUrl || r.downloadUrl)
    .map((r) => {
      const magnetUri = r.magnetUrl || undefined;
      const infoHash = r.infoHash?.toUpperCase() || extractInfoHash(magnetUri);
      return {
        title: r.title,
        indexer: r.indexer,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        magnetUri,
        torrentUrl: r.downloadUrl?.endsWith('.torrent') ? r.downloadUrl : undefined,
        downloadUrl: isProwlarrDownloadUrl(r.downloadUrl, prowlarrUrl) ? r.downloadUrl : undefined,
        infoHash,
        publishDate: r.publishDate,
        episodeMatch:
          params.episode != null
            ? matchesEpisode(r.title, params.season, params.episode, undefined)
            : undefined,
        seasonPack:
          params.episode != null
            ? (() => {
                const detection = detectSeasonPack(r.title, params.season);
                return detection.isSeasonPack
                  ? {
                      season: params.season ?? null,
                      reason: detection.reason,
                      keywords: detection.keywords,
                    }
                  : null;
              })()
            : null,
      };
    });

  const uniq = dedupeByHash(all);
  const ranked = rank(uniq);

  // Resolve magnets for top results
  for (const item of ranked.slice(0, 10)) {
    if (item.magnetUri?.startsWith('magnet:')) continue;
    if (isHttpUrl(item.downloadUrl)) {
      try {
        const resolved = await resolveDownloadToMagnet(item.downloadUrl);
        if (resolved) {
          item.magnetUri = resolved;
          continue;
        }
      } catch (err) {
        console.debug('[prowlarr] magnet resolve failed', err);
      }
    }
    if (!item.magnetUri && item.infoHash) {
      item.magnetUri = magnetFromHash(item.infoHash, item.title);
    }
  }

  return {
    query: {
      imdbId: params.imdbId,
      title: params.title,
      season: params.season,
      episode: params.episode,
      year: params.year,
    },
    total: ranked.length,
    results: ranked,
  };
}

export async function searchAnimeTorrents(params: {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absolute?: number;
  aliases?: string[];
  tvdbId?: number;
}) {
  const { url: prowlarrUrl, apiKey } = await getProwlarrConfig();

  // Optimize: Use only the main title and tvsearch type (most relevant for anime)
  // Only use aliases if main search returns few results
  const searchUrl = new URL(`${prowlarrUrl}/api/v1/search`);
  searchUrl.searchParams.set('query', params.title);
  searchUrl.searchParams.set('type', 'tvsearch'); // tvsearch is better for anime episodes
  if (params.tvdbId) searchUrl.searchParams.set('tvdbId', String(params.tvdbId));
  if (params.season != null) searchUrl.searchParams.set('season', String(params.season));
  if (params.episode != null) searchUrl.searchParams.set('episode', String(params.episode));
  for (const cat of ANIME_CATS) {
    searchUrl.searchParams.append('categories', String(cat));
  }
  searchUrl.searchParams.set('limit', '150');
  searchUrl.searchParams.set('apikey', apiKey);

  console.log('[prowlarr] Searching anime:', { title: params.title, season: params.season, episode: params.episode });

  // Use rate-limited fetch
  const res = await rateLimitedFetch(searchUrl.toString(), {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    cache: 'no-store',
  });

  // Handle specific error codes
  if (res.status === 410) {
    console.warn('[prowlarr] Prowlarr returned 410 (Gone)');
    return { query: params, total: 0, results: [] };
  }
  
  if (res.status === 429) {
    console.warn('[prowlarr] Still rate limited after all retries');
    return { query: params, total: 0, results: [] };
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    console.error(`[prowlarr] Anime search failed: ${res.status} ${res.statusText}`, errorText);
    throw new Error(`Prowlarr search failed: ${res.status} - ${errorText.substring(0, 200)}`);
  }

  let allReleases: Array<{
    title: string;
    indexer: string;
    size: number;
    seeders?: number;
    leechers?: number;
    magnetUrl?: string;
    downloadUrl?: string;
    infoHash?: string;
    publishDate?: string;
    languages?: Array<{ name?: string }>;
  }>;

  try {
    const jsonData = await res.json();
    if (Array.isArray(jsonData)) {
      allReleases = jsonData;
    } else if (jsonData && Array.isArray(jsonData.results)) {
      allReleases = jsonData.results;
    } else if (jsonData && Array.isArray(jsonData.data)) {
      allReleases = jsonData.data;
    } else {
      console.warn('[prowlarr] Unexpected anime response format:', jsonData);
      allReleases = [];
    }
  } catch (parseErr) {
    console.error('[prowlarr] Failed to parse anime JSON response:', parseErr);
    throw new Error(`Prowlarr response parse error: ${parseErr}`);
  }

  console.log(`[prowlarr] Received ${allReleases.length} anime releases`);

  // Removed alias fallback to ensure only 1 API call per search
  // If aliases are needed, they should be included in the main query or handled differently

  const filteredReleases = allReleases.filter((r) => r.magnetUrl || r.downloadUrl);

  const all: Normalized[] = filteredReleases.map((r) => {
    const magnetUri = r.magnetUrl || undefined;
    const infoHash = r.infoHash?.toUpperCase() || extractInfoHash(magnetUri);
    const languageAttr = r.languages?.map((l: any) => l.name).join(', ') || undefined;

    const origLang = 'ja'; // Default for anime
    const allowedLangs = new Set<LangCode>([origLang]);
    if (!isAllowedByLanguage(r.title, languageAttr, allowedLangs)) {
      return null;
    }

    return {
      title: r.title,
      indexer: r.indexer,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      magnetUri,
      torrentUrl: r.downloadUrl?.endsWith('.torrent') ? r.downloadUrl : undefined,
      downloadUrl: isProwlarrDownloadUrl(r.downloadUrl, prowlarrUrl) ? r.downloadUrl : undefined,
      infoHash,
      publishDate: r.publishDate,
      languageAttr,
      episodeMatch:
        params.episode != null || params.absolute != null
          ? matchesEpisode(r.title, params.season, params.episode, params.absolute)
          : undefined,
      seasonPack:
        (params.episode != null || params.absolute != null) &&
        !matchesEpisode(r.title, params.season, params.episode, params.absolute)
          ? (() => {
              const detection = detectSeasonPack(r.title, params.season);
              return detection.isSeasonPack
                ? {
                    season: params.season ?? null,
                    reason: detection.reason,
                    keywords: detection.keywords,
                  }
                : null;
            })()
          : null,
    };
  });

  const filtered = all.filter((it): it is Normalized => it !== null);
  const uniq = dedupeByHash(filtered);
  const ranked = rank(uniq);

  // Resolve magnets
  for (const item of ranked.slice(0, 10)) {
    if (item.magnetUri?.startsWith('magnet:')) continue;
    if (isHttpUrl(item.downloadUrl)) {
      try {
        const resolved = await resolveDownloadToMagnet(item.downloadUrl);
        if (resolved) {
          item.magnetUri = resolved;
          continue;
        }
      } catch (err) {
        console.debug('[prowlarr] magnet resolve failed', err);
      }
    }
    if (!item.magnetUri && item.infoHash) {
      item.magnetUri = magnetFromHash(item.infoHash, item.title);
    }
  }

  return {
    query: {
      title: params.title,
      season: params.season,
      episode: params.episode,
      absolute: params.absolute,
      aliases: params.aliases,
    },
    total: ranked.length,
    results: ranked,
  };
}



