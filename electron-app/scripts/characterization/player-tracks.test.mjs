import assert from "node:assert/strict";
import test from "node:test";

import { planTracks, playerTracks } from "../../src/lib/player-tracks.ts";
import { audioDisplayNames, trackDisplayNames } from "../../src/lib/track-labels.ts";

// Dragon Ball Z Kai (Pi13): Japanese and English audio; full English
// subtitles for the Japanese and the dub's own "Dubtitles".
const kai = {
  audio: playerTracks([{ language: "jpn", codec: "aac", default: true }, { language: "eng", title: "English Dub", codec: "aac" }]),
  subtitles: playerTracks([
    { language: "eng", title: "Full Subtitles", codec: "ass" },
    { language: "eng", title: "English Dubtitles", codec: "ass" },
    { language: "eng", title: "Signs & Songs", codec: "ass", forced: true },
  ]),
};

test("the server's tracks are numbered like mpv's and named like the phone's", () => {
  assert.deepEqual(kai.audio.map((track) => track.id), [1, 2]);
  assert.deepEqual(audioDisplayNames(kai.audio.map((track) => track.label), "ja"), ["Japanese [Original]", "English (Dub)"]);
  assert.deepEqual(trackDisplayNames(kai.subtitles.map((track) => track.label)), ["English (Full Subtitles)", "English (Dub)", "English (Signs & Songs)"]);
  assert.deepEqual(trackDisplayNames(playerTracks([{ language: "eng", cc: true }, { language: "eng" }, {}]).map((track) => track.label)),
    ["English (CC)", "English", "Track 3"]);
});

test("Japanese audio gets the translation; English dub audio gets the dub's script", () => {
  assert.deepEqual(planTracks({ ...kai, show: null, subtitleLang: "en" }), { audio: 1, subtitle: { kind: "track", id: 1 } });
  assert.deepEqual(planTracks({ ...kai, show: { audioLanguage: "English" }, subtitleLang: "en" }), { audio: 2, subtitle: { kind: "track", id: 2 } });
});

test("a dub without its own script asks the server for one, showing the translation meanwhile", () => {
  const blackRabbit = { audio: kai.audio, subtitles: kai.subtitles.slice(0, 1) };
  assert.deepEqual(planTracks({ ...blackRabbit, show: { audioLanguage: "English" }, subtitleLang: "en" }),
    { audio: 2, subtitle: { kind: "matched", fallback: 1 } });
});

test("a show's remembered choice wins; a single-audio film keeps the player's own pick without English subtitles", () => {
  assert.deepEqual(planTracks({ ...kai, show: { subtitle: "off" }, subtitleLang: "en" }).subtitle, { kind: "off" });
  const film = { audio: playerTracks([{ language: "eng" }]), subtitles: playerTracks([{ language: "spa" }]) };
  assert.deepEqual(planTracks({ ...film, show: null, subtitleLang: "en" }), { audio: 1, subtitle: { kind: "keep" } });
  assert.deepEqual(planTracks({ audio: [], subtitles: [], show: null, subtitleLang: "en" }), { audio: null, subtitle: { kind: "keep" } });
});

test("plain-dialogue ASS tracks get the subtitle box; signs and unnamed ASS keep their styling", () => {
  assert.deepEqual(kai.subtitles.map((track) => track.styled), [false, false, true]);
  assert.deepEqual(playerTracks([{ codec: "ass", language: "eng" }, { codec: "subrip", language: "eng" }]).map((track) => track.styled), [true, false]);
});
