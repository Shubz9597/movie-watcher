package httpapi

import "testing"

func TestRewindResumePosition(t *testing.T) {
	tests := []struct {
		position int
		want     int
	}{
		{position: 0, want: 0},
		{position: 10, want: 0},
		{position: 15, want: 0},
		{position: 16, want: 1},
		{position: 90, want: 75},
	}
	for _, test := range tests {
		if got := rewindResumePosition(test.position); got != test.want {
			t.Fatalf("rewindResumePosition(%d) = %d, want %d", test.position, got, test.want)
		}
	}
}
