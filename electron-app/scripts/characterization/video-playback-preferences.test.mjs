import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPlaybackDelay, matchingSavedTrack, readVideoPlaybackPreferences, saveVideoPlaybackPreferences, subtitleCueAtTime, videoPlaybackPreferenceKey } from '../../src/mobile/video-playback-preferences.ts';

const source = {
  origin: 'https://server.example', magnet: 'magnet:?xt=urn:btih:ABC123&dn=Episode&tr=tracker',
  cat: 'anime', season: 1, episode: 1, fileIndex: 2,
};

test('video identity survives tracker changes and isolates episodes, files, sources, servers and downloads', () => {
  const key = videoPlaybackPreferenceKey(source);
  assert.equal(videoPlaybackPreferenceKey({...source, origin:'https://server.example/', magnet:'magnet:?tr=other&xt=urn:btih:abc123&dn=New%20title'}), key);
  assert.equal(videoPlaybackPreferenceKey({...source, fileIndex:undefined}), videoPlaybackPreferenceKey({...source, fileIndex:0}));
  for (const change of [{episode:2}, {season:2}, {fileIndex:3}, {magnet:'magnet:?xt=urn:btih:OTHER'}, {origin:'https://other.example'}]) {
    assert.notEqual(videoPlaybackPreferenceKey({...source, ...change}), key);
  }
  assert.notEqual(videoPlaybackPreferenceKey({...source, downloadId:'one'}), videoPlaybackPreferenceKey({...source, downloadId:'two'}));
  assert.equal(videoPlaybackPreferenceKey({...source, magnet:''}), null);
});

test('subtitle selection, Off, audio and timing survive a storage round trip without leaking to another video', () => {
  const entries = new Map();
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  try {
    const key = videoPlaybackPreferenceKey(source);
    const settings = {
      subtitle: {kind:'external', url:'/subtitles/external?source=opensub&id=100', format:'vtt', label:'release.srt', language:'en'},
      subtitleDelay: -4, audioTrack:{id:2, label:'Japanese', language:'ja'}, audioDelay:0.3,
    };
    saveVideoPlaybackPreferences(key, settings);
    assert.deepEqual(readVideoPlaybackPreferences(key), settings);
    assert.equal(readVideoPlaybackPreferences(videoPlaybackPreferenceKey({...source, episode:2})), null);
    const off = {...settings, subtitle:{kind:'off'}};
    saveVideoPlaybackPreferences(key, off);
    assert.deepEqual(readVideoPlaybackPreferences(key), off);
    const embedded = {...settings, subtitle:{kind:'embedded', track:{id:4, label:'English', language:'en'}}};
    saveVideoPlaybackPreferences(key, embedded);
    assert.deepEqual(readVideoPlaybackPreferences(key), embedded);
    entries.set(key, '{broken');
    assert.equal(readVideoPlaybackPreferences(key), null);
    entries.set(key, JSON.stringify({version:1, subtitle:{kind:'embedded', track:{id:-1}}, subtitleDelay:100, audioDelay:'bad'}));
    assert.deepEqual(readVideoPlaybackPreferences(key), {subtitle:null, subtitleDelay:30, audioTrack:null, audioDelay:0});
    entries.set(key, JSON.stringify({version:99}));
    assert.equal(readVideoPlaybackPreferences(key), null);
    globalThis.localStorage = {getItem(){throw new Error('blocked');}, setItem(){throw new Error('quota');}};
    assert.equal(readVideoPlaybackPreferences(key), null);
    assert.doesNotThrow(() => saveVideoPlaybackPreferences(key, settings));
  } finally { delete globalThis.localStorage; }
});

test('embedded track restoration follows the track description when IDs change and avoids ambiguous replacements', () => {
  const saved = {id:4, label:'English', language:'en'};
  assert.equal(matchingSavedTrack([{id:4, label:'French', language:'fr'}, {id:8, label:'English', language:'en'}], saved)?.id, 8);
  assert.equal(matchingSavedTrack([], saved), null);
  assert.equal(matchingSavedTrack([{id:8, label:'English', language:'en'}, {id:9, label:'English', language:'en'}], saved), null);
  assert.equal(matchingSavedTrack([{id:4}], {id:4})?.id, 4);
  assert.equal(matchingSavedTrack([{id:8}], {id:4}), null);
});

test('a four-second correction moves overlay subtitles forward and positive delay moves them later', () => {
  const cue = {start:14, end:16, text:'Dialogue'};
  assert.equal(subtitleCueAtTime([cue], 10, 0), null);
  assert.deepEqual(subtitleCueAtTime([cue], 10, -4), cue);
  assert.equal(subtitleCueAtTime([cue], 13, -4), null);
  assert.equal(subtitleCueAtTime([cue], 14, 4), null);
  assert.deepEqual(subtitleCueAtTime([cue], 18, 4), cue);
  assert.equal(clampPlaybackDelay(-40), -30);
  assert.equal(clampPlaybackDelay(0.29999), 0.3);
  assert.equal(clampPlaybackDelay(NaN), 0);
});
