package buildinfo

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewCapturesContractPayload(t *testing.T) {
	info := New(Options{ServerVersion: "2.0.0-alpha.1"})
	if info.ServerVersion != "2.0.0-alpha.1" {
		t.Fatalf("serverVersion = %q", info.ServerVersion)
	}
	if info.ProtocolVersion != ProtocolVersion || ProtocolVersion != 1 {
		t.Fatalf("protocolVersion = %d", info.ProtocolVersion)
	}
	if len(info.SupportedProtocolRange) != 2 ||
		info.SupportedProtocolRange[0] != MinProtocolVersion ||
		info.SupportedProtocolRange[1] != MaxProtocolVersion ||
		MinProtocolVersion != 1 || MaxProtocolVersion != 1 {
		t.Fatalf("supportedProtocolRange = %v", info.SupportedProtocolRange)
	}
	if info.GoVersion == "" || info.OS == "" || info.Arch == "" {
		t.Fatalf("runtime fields incomplete: %+v", info)
	}
	if info.Revision == "" || info.BuiltAt == "" {
		t.Fatalf("revision/builtAt must never be empty: %+v", info)
	}
	if info.Capabilities == nil || len(info.Capabilities) != 0 {
		t.Fatalf("no capability is implemented yet; capabilities must serialize as an empty list, got %v", info.Capabilities)
	}
}

func TestNewFallsBackToLdflagsVersion(t *testing.T) {
	info := New(Options{})
	if info.ServerVersion != AppVersion || AppVersion == "" {
		t.Fatalf("serverVersion fallback = %q, ldflags default %q", info.ServerVersion, AppVersion)
	}
}

func TestInfoJSONShape(t *testing.T) {
	info := New(Options{ServerVersion: "2.0.0", Capabilities: []string{"catalog.bff.v2"}})
	encoded, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{
		"serverVersion", "revision", "builtAt", "protocolVersion", "supportedProtocolRange",
		"goVersion", "os", "arch", "capabilities",
	} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("payload missing %q: %s", key, encoded)
		}
	}
	if !strings.Contains(string(encoded), `"protocolVersion":1`) {
		t.Fatalf("protocolVersion not serialized as number: %s", encoded)
	}
}
