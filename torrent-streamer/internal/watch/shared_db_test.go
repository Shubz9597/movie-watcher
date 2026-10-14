package watch

import (
	"context"
	"testing"
)

// Episodes watched on the phone and streamed on the desktop show as one
// history on both: phone marks 1-35, desktop finishes 36-41 and stops in 42.
func TestSharedSubjectJoinsDevices(t *testing.T) {
	store := newCharacterizationStore(t)
	store.Shared = "shared:" + t.Name()
	ctx := context.Background()
	series := "anilist:6033"

	var phoneEpisodes []EpisodeRef
	for e := 1; e <= 35; e++ {
		phoneEpisodes = append(phoneEpisodes, EpisodeRef{1, e})
	}
	if err := store.SetWatched(ctx, "phone-id", series, phoneEpisodes, true, nil); err != nil {
		t.Fatalf("phone marks: %v", err)
	}
	for e := 36; e <= 41; e++ {
		if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{SubjectID: "desktop-id", SeriesID: series, Season: 1, Episode: e, Position: 1390, Duration: 1400}); err != nil {
			t.Fatalf("desktop episode %d: %v", e, err)
		}
	}
	if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{SubjectID: "desktop-id", SeriesID: series, Season: 1, Episode: 42, Position: 600, Duration: 1400}); err != nil {
		t.Fatalf("desktop episode 42: %v", err)
	}

	items, err := store.ListWatched(ctx, "phone-id", series)
	if err != nil {
		t.Fatalf("phone list: %v", err)
	}
	watched := map[int]bool{}
	for _, item := range items {
		watched[item.Episode] = item.Watched
	}
	for e := 1; e <= 41; e++ {
		if !watched[e] {
			t.Fatalf("phone must see episode %d watched: %+v", e, items)
		}
	}
	if watched[42] {
		t.Fatal("episode 42 is only started")
	}
	continueList, err := store.ListContinue(ctx, "phone-id", 10)
	if err != nil || len(continueList) == 0 || continueList[0].Episode != 42 {
		t.Fatalf("phone continue must resume episode 42: %+v err=%v", continueList, err)
	}
	resume, ok, err := store.GetResume(ctx, "phone-id", series)
	if err != nil || !ok || resume.Episode != 42 || resume.Position != 600 {
		t.Fatalf("phone resume: %+v ok=%v err=%v", resume, ok, err)
	}
}
