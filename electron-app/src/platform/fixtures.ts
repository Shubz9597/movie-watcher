// Fixture adapter (M1.2) — TEST-ONLY. It exists so the shared React slice
// can render deterministic states without a backend or Electron. It is
// activated ONLY by the browser development entry when the URL explicitly
// carries `fixtures=1`; no production entry imports it, and no code falls
// back to it silently. The fetch shim scopes itself to backend-URL paths so
// non-backend traffic (CDN artwork etc.) is untouched.
import type { ConnectionConfig, DeviceStorage, ServerCompatibility } from './contracts.ts'
import { setBackendOrigin } from '../lib/connection-service.ts'

export type FixtureScenario = 'ok' | 'unreachable' | 'incompatible' | 'provider-failure';

export type FixtureTitle = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  artwork?: Record<string, string>;
  providerIds?: Record<string, string>;
  imdbId?: string;
  mergedFrom?: string[];
  runtime?: number;
  genres?: string[];
  seasons?: Array<{ number: number; name?: string; episodeCount?: number; airDate?: string }>;
};

const TITLES: FixtureTitle[] = [
  {
    id: 'anilist:154587',
    type: 'anime',
    title: 'Frieren: Beyond Journey\'s End',
    originalTitle: '葬送のフリーレン',
    year: 2023,
    overview: 'An elven mage reflects on mortality while retracing a hero\'s journey.',
    artwork: { poster: 'https://image.tmdb.org/t/p/w342/dqZENchTd7lp5zht7BdlqM7RBhD.jpg' },
    providerIds: { anilist: '154587', jikan: '52991' },
    imdbId: 'tt28015436',
    mergedFrom: ['anilist', 'jikan'],
    runtime: 25,
    genres: ['Animation', 'Adventure', 'Drama'],
    seasons: [{ number: 1, name: 'Season 1', episodeCount: 28, airDate: '2023-09-29' }],
  },
  {
    id: 'tmdb:693134',
    type: 'movie',
    title: 'Dune: Part Two',
    year: 2024,
    overview: 'Paul Atreides unites with the Fremen while on a warpath of revenge.',
    artwork: { poster: 'https://image.tmdb.org/t/p/w342/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg' },
    providerIds: { tmdb: '693134' },
    mergedFrom: ['tmdb'],
    runtime: 167,
    genres: ['Science Fiction', 'Adventure'],
  },
  {
    id: 'tmdb:1396',
    type: 'series',
    title: 'Breaking Bad',
    year: 2008,
    overview: 'A chemistry teacher turns to making methamphetamine.',
    artwork: { poster: 'https://image.tmdb.org/t/p/w342/ggFHVNu6YYI5L9pCfOacjizRGt.jpg' },
    providerIds: { tmdb: '1396' },
    mergedFrom: ['tmdb'],
    runtime: 47,
    genres: ['Drama', 'Crime'],
    seasons: [{ number: 1, name: 'Season 1', episodeCount: 7 }],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Per-title torrent-search call counts backing the deterministic WF06
// fixture sets: call 1 = original set, call 2 = set without its first
// entry, later calls alternate two single-row sets (source-disappearance
// flows stay reproducible).
const torrentSearchCounts = new Map<string, number>();

const TORRENT_SETS = {
  original: [
    {
      title: 'Some.Movie.2024.1080p.BluRay.x264-GROUPNAMEWITHLONGTAGS[rarbg]/Release.Folder/Some.Movie.2024.1080p.BluRay.x264-GROUPNAMEWITHLONGTAGS.mkv',
      sizeBytes: 2147483648,
      seeders: 128,
      leechers: 14,
      magnetUri: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
      infoHash: '1111111111111111111111111111111111111111',
      indexer: 'Example tracker',
      publishDate: '2024-04-02T00:00:00Z',
    },
    {
      title: 'Another.Release.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-ANOTHERGROUP',
      sizeBytes: 15461882265,
      seeders: 42,
      magnetUri: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222',
      infoHash: '2222222222222222222222222222222222222222',
      indexer: 'Example tracker',
      publishDate: '2024-04-10T00:00:00Z',
    },
    {
      title: 'Third.Source.720p.HDTV.x264-SHORT',
      magnetUri: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333',
      infoHash: '3333333333333333333333333333333333333333',
    },
  ],
  withoutFirst: [
    {
      title: 'Another.Release.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-ANOTHERGROUP',
      sizeBytes: 15461882265,
      seeders: 42,
      magnetUri: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222',
      infoHash: '2222222222222222222222222222222222222222',
      indexer: 'Example tracker',
      publishDate: '2024-04-10T00:00:00Z',
    },
    {
      title: 'Third.Source.720p.HDTV.x264-SHORT',
      magnetUri: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333',
      infoHash: '3333333333333333333333333333333333333333',
    },
  ],
  replacementA: [
    {
      title: 'Replacement.Release.1080p.BluRay.x264-NEWGROUP',
      sizeBytes: 3221225472,
      seeders: 77,
      magnetUri: 'magnet:?xt=urn:btih:4444444444444444444444444444444444444444',
      infoHash: '4444444444444444444444444444444444444444',
      indexer: 'Example tracker',
      publishDate: '2024-05-01T00:00:00Z',
    },
  ],
  replacementB: [
    {
      title: 'Reissued.Pack.720p.HDTV.x264-OTHERGROUP',
      seeders: 12,
      magnetUri: 'magnet:?xt=urn:btih:5555555555555555555555555555555555555555',
      infoHash: '5555555555555555555555555555555555555555',
      indexer: 'Example tracker',
      publishDate: '2024-05-20T00:00:00Z',
    },
  ],
};

export function fixtureFetch(scenario: FixtureScenario): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/v1/') && !url.includes('/v2/')) {
      return jsonResponse({ error: { code: 'fixture_out_of_scope', message: `fixture shim does not serve ${url}` } }, 404);
    }
    switch (scenario) {
      case 'unreachable':
        throw new TypeError('fixture: network unreachable');
      case 'incompatible':
        if (url.includes('/v1/version')) {
          return jsonResponse({ serverVersion: '0.0.1-old', protocolVersion: 0, supportedProtocolRange: [0, 0], capabilities: [] });
        }
        return jsonResponse({ error: { code: 'unsupported_protocol', message: 'fixture' } }, 400);
      case 'provider-failure':
        if (url.includes('/v1/version')) {
          return jsonResponse({ serverVersion: 'fixture', protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ['catalog.bff.v2'] });
        }
        return jsonResponse({ error: { code: 'providers_unavailable', message: 'all catalog providers failed', degradedProviders: ['tmdb', 'anilist'] } }, 503);
      default:
        break;
    }
    if (url.includes('/v1/version')) {
      return jsonResponse({ serverVersion: 'fixture', protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ['catalog.bff.v2', 'leases.shared', 'progress.serverOrdered'] });
    }
    // Deterministic continue-watching rows consumed by the real
    // continue-service (enrichment resolves through the fixture details).
    if (url.includes('/v1/continue/dismiss')) {
      return jsonResponse({ ok: true });
    }
    if (url.includes('__fixture_reset_torrents')) {
      // Harness-only control endpoint: restarts the per-title torrent
      // sequences so capture groups are deterministic.
      torrentSearchCounts.clear();
      return jsonResponse({ ok: true });
    }
    // WF06 source-sheet fixtures, deterministic per requested title: call 1
    // serves the full set, call 2 the set without its first entry, and later
    // calls alternate two single-row sets — making the select → refresh →
    // source-disappearance flow reproducible (M2.3).
    if (url.includes('/v1/torrents/search')) {
      const titleKey = 'fixture-title';
      const call = (torrentSearchCounts.get(titleKey) ?? 0) + 1;
      torrentSearchCounts.set(titleKey, call);
      const results = call === 1
        ? TORRENT_SETS.original
        : call === 2
          ? TORRENT_SETS.withoutFirst
          : (call % 2 === 1 ? TORRENT_SETS.replacementA : TORRENT_SETS.replacementB);
      return jsonResponse({ results });
    }
    if (url.includes('/v1/resume/source')) {
      return jsonResponse({ found: false, reason: 'saved_source_missing' });
    }
    if (url.includes('/v1/continue')) {
      return jsonResponse([
        { seriesId: 'tmdb:movie:693134', season: 0, episode: 0, position_s: 3900, duration_s: 10020, percent: 39, updated_at: '2026-09-06T12:00:00Z', sourceAvailable: true, sourceName: 'Fixture source' },
        { seriesId: 'tmdb:tv:1396', season: 1, episode: 4, position_s: 600, duration_s: 2820, percent: 21, updated_at: '2026-09-06T11:00:00Z', sourceAvailable: true, sourceName: 'Fixture source' },
        { seriesId: 'anilist:154587', season: 1, episode: 9, position_s: 300, duration_s: 1500, percent: 20, updated_at: '2026-09-06T10:00:00Z', sourceAvailable: true, sourceName: 'Fixture source' },
      ]);
    }
    if (url.includes('/v2/catalog/search')) {
      // Honor the contracted type filter; fixture queries are deterministic
      // (the q parameter does not narrow fixture rows).
      const type = new URL(url, 'http://fixture.local').searchParams.get('type') ?? 'all';
      const rows = type === 'all' ? TITLES : TITLES.filter((t) => t.type === type);
      return jsonResponse({ query: url, total: rows.length, results: rows, degraded: false, degradedProviders: [] });
    }
    if (url.includes('/v2/catalog/sections')) {
      return jsonResponse({ id: 'fixture', kind: 'provider', titleIds: TITLES.map((t) => t.id), results: TITLES, degraded: false, degradedProviders: [] });
    }
    const detail = url.match(/\/v2\/catalog\/titles\/([^/]+?)(?:\/episodes)?(?:\?|$)/);
    if (url.includes('/episodes')) {
      const id = decodeURIComponent(detail?.[1] ?? '');
      const title = TITLES.find((t) => t.id === id);
      const count = title?.seasons?.[0]?.episodeCount ?? 0;
      return jsonResponse({
        titleId: id,
        season: 1,
        episodes: Array.from({ length: count }, (_, index) => ({
          id: `${id}:1:${index + 1}`,
          season: 1,
          episode: index + 1,
          title: `Episode ${index + 1}`,
          airDate: '2023-09-29',
        })),
        degraded: false,
        degradedProviders: [],
      });
    }
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      const title = TITLES.find((t) => t.id === id);
      if (!title) {
        return jsonResponse({ error: { code: 'title_not_found', message: 'fixture' } }, 404);
      }
      return jsonResponse({ ...title, ratings: { imdb: { rating: 8.9, votes: 1000 } } });
    }
    return jsonResponse({ error: { code: 'fixture_unmatched', message: url } }, 404);
  };
}

export class FixtureConnection implements ConnectionConfig {
  scenario: FixtureScenario;
  constructor(scenario: FixtureScenario = 'ok') {
    this.scenario = scenario;
  }
  async loadOrigin(): Promise<string> {
    return 'fixture://local';
  }
  async saveOrigin(): Promise<string> {
    return 'fixture://local';
  }
  async check(): Promise<ServerCompatibility> {
    // Mirror the real adapter's states without a network: the scenario is
    // the state, chosen explicitly by the development entry.
    if (this.scenario === 'unreachable') {
      return { status: 'unreachable', origin: 'fixture://local', message: 'Fixture scenario: the server could not be reached.' };
    }
    if (this.scenario === 'incompatible') {
      return { status: 'incompatible', origin: 'fixture://local', message: 'Fixture scenario: server protocol range [0,0] does not overlap the client range [1,1].' };
    }
    return { status: 'ready', origin: 'fixture://local', serverVersion: 'fixture', supportedProtocolRange: [1, 1] };
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

export class FixtureStorage implements DeviceStorage {
  lastError: string | null = null;
  private values = new Map<string, string>();
  getClientId(): string {
    if (!this.values.has('clientId')) this.values.set('clientId', '00000000-0000-4000-8000-000000000001');
    return this.values.get('clientId')!;
  }
  getPreference(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setPreference(key: string, value: string): void {
    this.values.set(key, value);
  }
}

// installFixtureAdapter wires the explicit fixture state: it replaces the
// shared origin (so buildBackendUrl stays consistent) and installs the
// scenario fetch shim on globalThis for the page lifetime. A `resetTorrents`
// URL flag clears the per-title torrent sequence counters at install time so
// capture/interaction pages start from the first payload deterministically.
export function installFixtureAdapter(scenario: FixtureScenario): void {
  setBackendOrigin('http://fixture.local');
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('resetTorrents')) {
    torrentSearchCounts.clear();
  }
  const original = globalThis.fetch.bind(globalThis);
  const shim = fixtureFetch(scenario);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://fixture.local')) {
      const rewritten = url.replace('http://fixture.local', '');
      return shim(rewritten, init);
    }
    return original(input, init);
  }) as typeof fetch;
}
