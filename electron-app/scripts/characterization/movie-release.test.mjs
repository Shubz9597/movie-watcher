import test from 'node:test';
import assert from 'node:assert/strict';
import { movieRelease } from '../../src/lib/movie-release.ts';

const now = Date.parse('2026-11-04T12:00:00');

test('a film before its release date is coming soon', () => {
  assert.deepEqual(movieRelease({ releaseDate: '2026-12-18', digitalRelease: '2027-03-10' }, now),
    { state: 'upcoming', releaseDate: '2026-12-18', digitalRelease: '2027-03-10' });
  assert.deepEqual(movieRelease({ releaseDate: '2026-12-18' }, now),
    { state: 'upcoming', releaseDate: '2026-12-18', digitalRelease: null });
});

test('a film in cinemas but not yet out to stream is in theatres', () => {
  assert.deepEqual(movieRelease({ releaseDate: '2026-10-01', digitalRelease: '2026-12-01' }, now),
    { state: 'theatres', digitalRelease: '2026-12-01' });
});

test('released, or unknown dates, is released', () => {
  assert.deepEqual(movieRelease({ releaseDate: '2026-10-01', digitalRelease: '2026-11-01' }, now), { state: 'released' });
  assert.deepEqual(movieRelease({ releaseDate: '2026-11-04' }, now), { state: 'released' });
  assert.deepEqual(movieRelease({}, now), { state: 'released' });
  assert.deepEqual(movieRelease({ releaseDate: 'soon' }, now), { state: 'released' });
  // Streaming-only film with a future digital date and no cinema date.
  assert.deepEqual(movieRelease({ digitalRelease: '2027-01-01' }, now), { state: 'released' });
});
