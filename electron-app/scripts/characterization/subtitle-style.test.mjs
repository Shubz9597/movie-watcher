import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
};

const {
  audioLanguages, defaultSubtitleStyle, subtitleTrackFor, styleOfTrack,
  readShowPlaybackPrefs, saveShowPlaybackPrefs, cacheMatchedSubtitle, cachedMatchedSubtitle, forgetMatchedSubtitle,
} = await import("../../src/lib/subtitle-style.ts");
const { matchingSavedTrack } = await import("../../src/mobile/video-playback-preferences.ts");
const { trackDisplayNames } = await import("../../src/lib/track-labels.ts");

// A Dragon Ball Z Kai download as VLC reports it on iOS: the release's own
// English track (a translation of the Japanese) and the downloaded dub
// script, labelled by the plugin from its WebVTT NOTE.
const audio = [{ id: 1, label: "Track 1 - [English]" }, { id: 2, label: "Track 2 - [Japanese]" }];
const subs = [{ id: 3, label: "Track 1 - [English]" }, { id: 4, label: "Dub - [English]" }];

test("English dub audio of a dual-audio release gets the dub's script", () => {
  const style = defaultSubtitleStyle(null, "English", audioLanguages(audio), "en");
  assert.equal(style, "dub");
  assert.equal(subtitleTrackFor(subs, "en", style)?.id, 4);
});

test("Japanese audio gets the translation, never the dub script", () => {
  const style = defaultSubtitleStyle(null, "Japanese", audioLanguages(audio), "en");
  assert.equal(style, "regular");
  assert.equal(subtitleTrackFor(subs, "en", style)?.id, 3);
});

test("single-audio videos keep regular subtitles", () => {
  assert.equal(defaultSubtitleStyle(null, "English", ["English"], "en"), "regular");
});

test("the show's remembered style wins", () => {
  assert.equal(defaultSubtitleStyle({ subtitle: "off" }, "English", ["English", "Japanese"], "en"), "off");
  assert.equal(defaultSubtitleStyle({ subtitle: "regular" }, "English", ["English", "Japanese"], "en"), "regular");
  assert.equal(subtitleTrackFor(subs, "en", "off"), null);
});

test("dub tracks read as such and display cleanly", () => {
  assert.equal(styleOfTrack("Dub - [English]"), "dub");
  assert.equal(styleOfTrack("Track 1 - [English]"), "regular");
  assert.deepEqual(trackDisplayNames(subs.map((t) => t.label)), ["English", "English · Dub"]);
});

test("choices are remembered per show", () => {
  saveShowPlaybackPrefs("anilist:6033", { audioLanguage: "English" });
  saveShowPlaybackPrefs("anilist:6033", { subtitle: "dub" });
  assert.deepEqual(readShowPlaybackPrefs("anilist:6033"), { audioLanguage: "English", subtitle: "dub" });
  assert.equal(readShowPlaybackPrefs("tmdb:tv:1396"), null);
  assert.equal(readShowPlaybackPrefs(null), null);
});

test("a download's matched dub is kept for offline playback", () => {
  cacheMatchedSubtitle("job-20", "WEBVTT\n\n00:00:02.370 --> 00:00:04.307\nLast time\n");
  assert.match(cachedMatchedSubtitle("job-20") ?? "", /Last time/);
  forgetMatchedSubtitle("job-20");
  assert.equal(cachedMatchedSubtitle("job-20"), null);
});

test("a choice saved as VLC's generic Track N survives the new labels", () => {
  // Saved before downloaded subtitle files were labelled: "Track 2" + -4 s.
  const saved = { id: 4, label: "Track 2" };
  assert.equal(matchingSavedTrack(subs, saved)?.id, 4);
  // Specific labels still have to match.
  assert.equal(matchingSavedTrack(subs, { id: 4, label: "English (forced)" }), null);
});
