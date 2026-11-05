import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFeatures } from '../../src/lib/release-summary.ts';

test('a 4K Dolby Vision Atmos web release reads as such', () => {
  assert.deepEqual(releaseFeatures('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX'), ['4K', 'Dolby Vision', 'Atmos', 'Web']);
});

test('common 1080p / 720p names', () => {
  assert.deepEqual(releaseFeatures('Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS'), ['HD 1080p', 'Blu-ray']);
  assert.deepEqual(releaseFeatures('Dune.Part.Two.2024.720p.WEBRip.x264.AAC-YIFY'), ['HD 720p', 'Web']);
  assert.deepEqual(releaseFeatures('Show.S01E04.1080p.WEB.H264-GROUP DDP5.1'), ['HD 1080p', '5.1', 'Web']);
});

test('quality from the source wins when the name lacks it; nothing is guessed', () => {
  assert.deepEqual(releaseFeatures('Some Release Without Tags', '1080p'), ['HD 1080p']);
  assert.deepEqual(releaseFeatures('Some Release Without Tags'), []);
  assert.deepEqual(releaseFeatures('Movie.2024.HDCAM.x264'), ['Camera copy']);
});
