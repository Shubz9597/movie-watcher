package main

import (
	"os"
	"strings"
	"testing"
)

func TestHealthzOKBodyIsFrozen(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	const literal = "w.Write([]byte(`{\"status\":\"ok\"}`))"
	if !strings.Contains(string(source), literal) {
		t.Fatalf("/healthz 200 body literal missing or changed; V1 clients depend on the byte-exact {\"status\":\"ok\"} body")
	}
}
