package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newSessionTestHandlers() *SessionHandlers {
	return NewSessionHandlers(SessionDeps{})
}

func TestSessionHeartbeatContract(t *testing.T) {
	t.Parallel()
	handler := newSessionTestHandlers().Heartbeat

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/session/heartbeat", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Body.String() != "method not allowed\n" ||
		recorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET heartbeat = %d %q allow=%q", recorder.Code, recorder.Body.String(), recorder.Header().Get("Allow"))
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/heartbeat", strings.NewReader("not json")))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "bad json\n" {
		t.Fatalf("bad json = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/heartbeat", strings.NewReader(`{"season":1,"episode":2}`)))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId & seriesId required\n" {
		t.Fatalf("missing ids = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/heartbeat",
		strings.NewReader(`{"subjectId":"s","seriesId":"sr","nextEpisode":3}`)))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "nextSeason & nextEpisode must be provided together\n" {
		t.Fatalf("half next = %d %q", recorder.Code, recorder.Body.String())
	}

	for _, body := range []string{
		`{"subjectId":"s","seriesId":"sr","season":1,"episode":2,"nextSeason":-1,"nextEpisode":3}`,
		`{"subjectId":"s","seriesId":"sr","season":1,"episode":2,"nextSeason":1,"nextEpisode":0}`,
		`{"subjectId":"s","seriesId":"sr","season":1,"episode":2,"nextSeason":1,"nextEpisode":2}`,
	} {
		recorder = httptest.NewRecorder()
		handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/heartbeat", strings.NewReader(body)))
		if recorder.Code != http.StatusBadRequest ||
			recorder.Body.String() != "invalid next episode\n" {
			t.Fatalf("invalid next (%s) = %d %q", body, recorder.Code, recorder.Body.String())
		}
	}
}

func TestSessionResumeContract(t *testing.T) {
	t.Parallel()
	handler := newSessionTestHandlers().Resume

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/resume", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST resume = %d allow=%q", recorder.Code, recorder.Header().Get("Allow"))
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId & seriesId required\n" {
		t.Fatalf("missing ids = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume?subjectId=s&seriesId=sr&season=1", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "valid season & episode required together\n" {
		t.Fatalf("half season = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume?subjectId=s&seriesId=sr&season=-1&episode=1", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "valid season & episode required together\n" {
		t.Fatalf("negative season = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSessionResumeSourceContract(t *testing.T) {
	t.Parallel()
	handler := newSessionTestHandlers().ResumeSource

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/resume/source", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST resume/source = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume/source?subjectId=s&seriesId=sr", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId, seriesId, season & episode required\n" {
		t.Fatalf("missing params = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSessionResumeSourceProbeContract(t *testing.T) {
	t.Parallel()
	handler := newSessionTestHandlers().ResumeSourceProbe

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/v1/resume/source/probe", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST probe = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume/source/probe", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId, seriesId, season & episode required\n" {
		t.Fatalf("missing params = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSessionContinueContract(t *testing.T) {
	t.Parallel()
	list := newSessionTestHandlers().ContinueList

	recorder := httptest.NewRecorder()
	list(recorder, httptest.NewRequest(http.MethodPost, "/v1/continue", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST continue = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	list(recorder, httptest.NewRequest(http.MethodGet, "/v1/continue", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId required\n" {
		t.Fatalf("missing subject = %d %q", recorder.Code, recorder.Body.String())
	}

	dismiss := newSessionTestHandlers().ContinueDismiss
	recorder = httptest.NewRecorder()
	dismiss(recorder, httptest.NewRequest(http.MethodGet, "/v1/continue/dismiss", nil))
	if recorder.Code != http.StatusMethodNotAllowed ||
		recorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET dismiss = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	dismiss(recorder, httptest.NewRequest(http.MethodPost, "/v1/continue/dismiss", strings.NewReader("nope")))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "bad json\n" {
		t.Fatalf("bad json dismiss = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	dismiss(recorder, httptest.NewRequest(http.MethodPost, "/v1/continue/dismiss", strings.NewReader(`{"season":1,"episode":2}`)))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId & seriesId required\n" {
		t.Fatalf("missing ids dismiss = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSessionStartAndEndedBadJSONContract(t *testing.T) {
	t.Parallel()
	handlers := newSessionTestHandlers()

	recorder := httptest.NewRecorder()
	handlers.Start(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/start", strings.NewReader("{")))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "bad json\n" {
		t.Fatalf("start bad json = %d %q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handlers.Ended(recorder, httptest.NewRequest(http.MethodPost, "/v1/session/ended", strings.NewReader("{")))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "bad json\n" {
		t.Fatalf("ended bad json = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestSessionResumeM3UContract(t *testing.T) {
	t.Parallel()
	handler := newSessionTestHandlers().ResumeM3U

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/v1/resume.m3u", nil))
	if recorder.Code != http.StatusBadRequest ||
		recorder.Body.String() != "subjectId & seriesId required\n" {
		t.Fatalf("missing ids = %d %q", recorder.Code, recorder.Body.String())
	}
}
