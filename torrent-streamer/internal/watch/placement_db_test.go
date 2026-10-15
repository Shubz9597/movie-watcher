package watch

import (
	"context"
	"strings"
	"testing"
)

// kaiPlacer: Dragon Ball Z Kai's AniList entries are seasons 1 and 2 of
// tmdb:tv:61709 (Stremio's numbering).
type kaiPlacer struct{}

func (kaiPlacer) PlaceEpisode(_ context.Context, id string, episode int) (string, int, int, bool) {
	show, season, offset, ok := kaiPlacer{}.EntrySeason(context.Background(), id)
	return show, season, episode + offset, ok
}

func (kaiPlacer) EntrySeason(_ context.Context, id string) (string, int, int, bool) {
	switch strings.TrimPrefix(id, "anilist:") {
	case "6033":
		return "tmdb:tv:61709", 1, 0, true
	case "20635":
		return "tmdb:tv:61709", 2, 0, true
	}
	return "", 0, 0, false
}

// The phone's earlier downloads still report progress under the AniList
// entry; it lands on the show, and reads under either id agree.
func TestEntryProgressLandsOnTheShow(t *testing.T) {
	store := newCharacterizationStore(t)
	store.Shared = "shared:" + t.Name()
	store.Placer = kaiPlacer{}
	ctx := context.Background()

	if _, err := store.SaveProgressUpdate(ctx, ProgressUpdate{SubjectID: "phone", SeriesID: "anilist:20635", Season: 1, Episode: 3, Position: 1390, Duration: 1400, Next: &EpisodeRef{1, 4}}); err != nil {
		t.Fatal(err)
	}
	show, err := store.ListWatched(ctx, "desktop", "tmdb:tv:61709")
	if err != nil || len(show) == 0 || show[0].Season != 2 || show[0].Episode != 3 || !show[0].Watched {
		t.Fatalf("show view: %+v err=%v", show, err)
	}
	entry, err := store.ListWatched(ctx, "phone", "anilist:20635")
	if err != nil || len(entry) == 0 || entry[0].Season != 1 || entry[0].Episode != 3 {
		t.Fatalf("entry view: %+v err=%v", entry, err)
	}
	if other, _ := store.ListWatched(ctx, "phone", "anilist:6033"); len(other) != 0 {
		t.Fatalf("season 1's entry must not see season 2: %+v", other)
	}
	continueList, err := store.ListContinue(ctx, "phone", 5)
	if err != nil || len(continueList) == 0 || continueList[0].SeriesID != "tmdb:tv:61709" || continueList[0].Season != 2 || continueList[0].Episode != 4 {
		t.Fatalf("next episode queued on the show: %+v err=%v", continueList, err)
	}
	if err := store.SetWatched(ctx, "phone", "anilist:6033", []EpisodeRef{{1, 36}}, true, nil); err != nil {
		t.Fatal(err)
	}
	if show, _ := store.ListWatched(ctx, "desktop", "tmdb:tv:61709"); len(show) != 2 || show[0].Season != 1 || show[0].Episode != 36 {
		t.Fatalf("marks from the entry land on the show: %+v", show)
	}
}
