import assert from "node:assert/strict";
import test from "node:test";

import { isFullDialogueTrack, preferredSubtitleTrack, trackDisplayNames } from "../../src/lib/track-labels.ts";

test("track names read as languages, with the track title when it adds something", () => {
  assert.deepEqual(trackDisplayNames(["Track 2 - [English]", "Signs & Songs - [English]", "Japanese", "Track 4", "", "eng"]),
    ["English 1", "English (Signs & Songs)", "Japanese", "Track 4", "Track 5", "English 2"]);
  assert.deepEqual(trackDisplayNames(["Full Subtitles - [English]", "English - [English]"]), ["English (Full Subtitles)", "English"]);
  assert.deepEqual(trackDisplayNames(["SDH - [English]", "Dub - [English]", "Downloaded - [Spanish]"]), ["English (CC)", "English (Dub)", "Spanish"]);
});

test("the default built-in subtitle is the full dialogue in the preferred language", () => {
  const tracks = [
    { id: 2, label: "Signs & Songs - [English]" },
    { id: 3, label: "Track 3 - [Japanese]" },
    { id: 4, label: "Full Subtitles - [English]" },
  ];
  assert.equal(preferredSubtitleTrack(tracks, "en")?.id, 4);
  assert.equal(preferredSubtitleTrack(tracks, "ja")?.id, 3);
  assert.equal(preferredSubtitleTrack(tracks, "fr"), null);
  assert.equal(isFullDialogueTrack("Forced - [English]", "en"), false);
  assert.equal(isFullDialogueTrack("Track 3", "en"), false, "an unnamed track is not assumed to be English");
});

// Dragon Ball Z Kai downloads listed the video's own English twice: the
// server had saved it again as "Downloaded - [English]".
test("a download's copy of the video's own subtitle is dropped", async () => {
  const { withoutDownloadedCopies } = await import("../../src/lib/track-labels.ts");
  const tracks = [{ id: 1, label: "English" }, { id: 2, label: "Downloaded - [English]" }, { id: 3, label: "Dub - [English]" }];
  assert.deepEqual(withoutDownloadedCopies(tracks).map((track) => track.id), [1, 3]);
  const onlyCopy = [{ id: 2, label: "Downloaded - [English]" }, { id: 4, label: "Japanese" }];
  assert.deepEqual(withoutDownloadedCopies(onlyCopy).map((track) => track.id), [2, 4], "kept when the video has no English of its own");
});

test("the original language's audio is marked, as on streaming services", async () => {
  const { audioDisplayNames } = await import("../../src/lib/track-labels.ts");
  assert.deepEqual(audioDisplayNames(["Track 1 - [English]", "Track 2 - [Japanese]"], "ja"), ["English", "Japanese [Original]"]);
  assert.deepEqual(audioDisplayNames(["Track 1 - [Japanese]"], "ja"), ["Japanese"], "one track: nothing to tell apart");
  assert.deepEqual(audioDisplayNames(["English", "Japanese"]), ["English", "Japanese"]);
});

test("a release's own dub subtitles read as dub", async () => {
  const { isDubTrack, trackDisplayNames: names } = await import("../../src/lib/track-labels.ts");
  assert.equal(isDubTrack("English Dubtitles [Hikari&Lucas] - [English]"), true);
  assert.equal(isDubTrack("Dub - [English]"), true);
  assert.equal(isDubTrack("Stylized Subtitles [NeoGohan&Tokimeku Panic] - [English]"), false);
  assert.equal(isDubTrack("Track 3 - [English]"), false);
  assert.deepEqual(names(["English Dubtitles [Hikari&Lucas] - [English]", "Signs&Songs&Titles [Ploffy&iKaos] - [English]"]), ["English (Dub)", "English (Signs&Songs&Titles [Ploffy&iKaos])"]);
});
