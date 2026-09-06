package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNegotiateUsesRangeOverlapNotAppVersion(t *testing.T) {
	cases := []struct {
		name        string
		serverRange []int
		wantOK      bool
		wantProto   int
	}{
		{name: "exact overlap", serverRange: []int{1, 1}, wantOK: true, wantProto: 1},
		{name: "server wider", serverRange: []int{1, 3}, wantOK: true, wantProto: 1},
		{name: "server newer", serverRange: []int{1, 2}, wantOK: true, wantProto: 1},
		{name: "highest mutual wins", serverRange: []int{1, 3}, wantOK: false, wantProto: 0},
		{name: "no overlap newer server", serverRange: []int{2, 3}, wantOK: false},
		{name: "no overlap older server", serverRange: []int{0, 0}, wantOK: false},
		{name: "missing range", serverRange: nil, wantOK: false},
	}
	clientMin, clientMax := 1, 1
	cases[3].wantProto = 1
	cases[3].wantOK = true
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			decision := Negotiate(c.serverRange, clientMin, clientMax)
			if decision.Compatible != c.wantOK {
				t.Fatalf("compatible = %v, want %v (reason: %s)", decision.Compatible, c.wantOK, decision.Reason)
			}
			if c.wantOK && decision.Protocol != c.wantProto {
				t.Fatalf("protocol = %d, want the highest mutually supported %d", decision.Protocol, c.wantProto)
			}
			if !c.wantOK && decision.Reason == "" {
				t.Fatal("incompatible decisions must carry an actionable reason")
			}
		})
	}
}

func TestNegotiateClientRangeWiderThanServer(t *testing.T) {
	decision := Negotiate([]int{1, 1}, 1, 2)
	if !decision.Compatible || decision.Protocol != 1 {
		t.Fatalf("client [1,2] vs server [1,1] must use protocol 1: %+v", decision)
	}
}

func TestLoadOrCreateClientIDIsStableAndValid(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateClientID(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !isUUID(first) {
		t.Fatalf("client id %q is not a UUID", first)
	}
	second, err := LoadOrCreateClientID(dir)
	if err != nil || second != first {
		t.Fatalf("client id not stable across runs: %q vs %q (%v)", first, second, err)
	}
	other, err := LoadOrCreateClientID(t.TempDir())
	if err != nil || other == first {
		t.Fatalf("separate installations must generate independent ids: %q vs %q", first, other)
	}
}

func TestEnsureCompatibleBlocksOnlyIncompatibleWorkflows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"serverVersion":"2.0.0","protocolVersion":2,"supportedProtocolRange":[2,3],"capabilities":["catalog.bff.v2"]}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	client := &Client{BaseURL: server.URL, HTTP: server.Client(), ClientID: "00000000-1111-4111-8111-111111111111"}
	if err := client.EnsureCompatible(context.Background()); err == nil {
		t.Fatal("non-overlapping ranges must block workflows")
	} else {
		var mismatch *ProtocolMismatchError
		if !errors.As(err, &mismatch) {
			t.Fatalf("error type = %T", err)
		}
	}

	// Version discovery itself is NEVER gated: it must remain readable on the
	// same server whose workflows are blocked.
	version, err := client.FetchVersion(context.Background())
	if err != nil || version.ServerVersion != "2.0.0" {
		t.Fatalf("version discovery must stay accessible: %+v %v", version, err)
	}
}

func TestEnsureCompatibleFailsOpenForBackendsWithNoVersionEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := &Client{BaseURL: server.URL, HTTP: server.Client(), ClientID: "00000000-1111-4111-8111-111111111111"}
	if err := client.EnsureCompatible(context.Background()); err != nil {
		t.Fatalf("pre-P1 backends without /v1/version must keep working (fail-open): %v", err)
	}
}

func TestVersionCapabilityFlags(t *testing.T) {
	version := Version{Capabilities: []string{"catalog.bff.v2"}}
	if !version.HasCapability("catalog.bff.v2") {
		t.Fatal("advertised capability not detected")
	}
	if version.HasCapability("leases.shared") {
		t.Fatal("unadvertised capability reported as present")
	}
}
