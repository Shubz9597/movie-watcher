package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"torrent-streamer/internal/buffer"
)

func TestHandleBufferStateStopsWithoutAddingTorrent(t *testing.T) {
	const infoHash = "0123456789ABCDEF0123456789ABCDEF01234567"
	controller := buffer.Get(buffer.Key{Cat: "movie", IH: infoHash, FIdx: 0})
	controller.SetState(buffer.StatePaused)

	magnet := "magnet:?xt=urn:btih:" + infoHash
	request := httptest.NewRequest(http.MethodGet, "/buffer/state?cat=movie&state=stop&magnet="+url.QueryEscape(magnet), nil)
	recorder := httptest.NewRecorder()

	handleBufferState(recorder, request)

	if got := recorder.Code; got != http.StatusOK {
		t.Fatalf("handleBufferState(stop) status = %d, want %d; body=%q", got, http.StatusOK, recorder.Body.String())
	}
	if got := controller.State(); got != buffer.StateStopped {
		t.Errorf("Controller.State() = %q, want %q", got, buffer.StateStopped)
	}
}
