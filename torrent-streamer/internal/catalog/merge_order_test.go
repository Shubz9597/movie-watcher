package catalog

import (
	"strconv"
	"testing"
)

func TestMergeEpisodesKeepsNumericOrder(t *testing.T) {
	var group []Episode
	for _, number := range []int{1, 10, 11, 2, 3, 20} {
		group = append(group, Episode{ID: "anizip:154587:" + strconv.Itoa(number), Season: 1, Episode: number})
	}
	merged := MergeEpisodes([][]Episode{group})
	want := []int{1, 2, 3, 10, 11, 20}
	for i, episode := range merged {
		if episode.Episode != want[i] {
			t.Fatalf("order = %v, want %v", merged, want)
		}
	}
}
