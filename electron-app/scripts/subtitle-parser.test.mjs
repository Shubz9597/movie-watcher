import { parseSubtitles } from '../src/lib/subtitle-parser.ts';
import assert from 'node:assert/strict';

const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello <b>world</b>\n\n2\n00:00:04.000 --> 00:00:06.500\nSecond line';
const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello, world\n\n2\n00:00:04,000 --> 00:00:06,500\nSecond';
const ass = '[Script Info]\nTitle: t\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Styled{\\i0} line, with comma\\Nsecond';

assert.deepEqual(parseSubtitles(vtt), [
  { start: 1, end: 3, text: 'Hello world' },
  { start: 4, end: 6.5, text: 'Second line' },
]);
assert.deepEqual(parseSubtitles(srt), [
  { start: 1, end: 3, text: 'Hello, world' },
  { start: 4, end: 6.5, text: 'Second' },
]);
assert.deepEqual(parseSubtitles(ass), [
  { start: 1, end: 3, text: 'Styled line, with comma\nsecond' },
]);
console.log('subtitle parser: all format cases pass');
