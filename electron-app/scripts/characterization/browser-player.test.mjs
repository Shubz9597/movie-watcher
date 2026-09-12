import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserProgressContext,
  buildBrowserStreamUrl,
} from '../../src/platform/browser-player-core.ts';

const request = {
  url: 'magnet:?xt=urn:btih:abc123&dn=Public Domain Film',
  magnet: 'magnet:?xt=urn:btih:abc123&dn=Public Domain Film',
  title: 'Public Domain Film',
  cat: 'movie',
};

test('browser stream URL preserves the opaque magnet and optional file index', () => {
  const url = new URL(buildBrowserStreamUrl('https://server.example:8443/', {
    ...request,
    fileIndex: 2,
  }));

  assert.equal(url.origin, 'https://server.example:8443');
  assert.equal(url.pathname, '/stream');
  assert.equal(url.searchParams.get('magnet'), request.magnet);
  assert.equal(url.searchParams.get('cat'), 'movie');
  assert.equal(url.searchParams.get('fileIndex'), '2');
});

test('browser stream URL fails closed without a server or source', () => {
  assert.throws(() => buildBrowserStreamUrl('', request), /Connect TorWatch/);
  assert.throws(() => buildBrowserStreamUrl('https://server.example', { ...request, magnet: '', url: '' }), /playable torrent/);
});

test('progress context is emitted only for a valid scoped title', () => {
  assert.equal(browserProgressContext(request), null);
  assert.deepEqual(browserProgressContext({
    ...request,
    subjectId: 'phone-1',
    seriesId: 'tmdb:movie:42',
    season: 0,
    episode: 0,
    fileIndex: 1,
  }), {
    subjectId: 'phone-1',
    seriesId: 'tmdb:movie:42',
    season: 0,
    episode: 0,
    sourceUri: request.magnet,
    sourceName: '',
    sourceKind: 'movie',
    sourceFileIndex: 1,
    nextSeason: null,
    nextEpisode: null,
  });
});
