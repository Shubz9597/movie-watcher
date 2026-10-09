import assert from "node:assert/strict";
import test from "node:test";

import { isFullDialogueTrack, preferredSubtitleTrack, trackDisplayNames } from "../../src/lib/track-labels.ts";

test("track names read as languages, with the track title when it adds something", () => {
  assert.deepEqual(trackDisplayNames(["Track 2 - [English]", "Signs & Songs - [English]", "Japanese", "Track 4", "", "eng"]),
    ["English 1", "English · Signs & Songs", "Japanese", "Track 4", "Track 5", "English 2"]);
  assert.deepEqual(trackDisplayNames(["Full Subtitles - [English]", "English - [English]"]), ["English · Full Subtitles", "English"]);
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
