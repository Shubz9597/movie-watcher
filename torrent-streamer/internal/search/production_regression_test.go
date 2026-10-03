package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegressionEmptyProwlarrResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`[]`)) }))
	defer srv.Close()
	s, err := NewService(srv.URL, "test-key", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.query(context.Background(), prowlarrQuery{query: "No Such Movie", kind: KindMovie})
	if err != nil || len(found) != 0 {
		t.Errorf("query(empty successful response) got len=%d err=%v, want zero results with no error", len(found), err)
	}
}

func TestEarlyResultCannotReplaceCompletedCache(t *testing.T) {
	s, err := NewService("http://127.0.0.1:1", "test-key", http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	complete := []Result{{Title: "First"}, {Title: "Second"}}
	s.remember("key", complete)
	s.rememberInitial("key", complete[:1])
	got, ok := s.cached("key")
	if !ok || len(got) != 2 {
		t.Fatalf("completed cache overwritten: %+v", got)
	}
}
