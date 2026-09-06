package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteProtocolErrorContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteProtocolError(recorder, "protocol 9 is outside the supported range", []int{1, 1})

	if recorder.Code != 400 {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("content type = %q", got)
	}
	var envelope struct {
		Error ErrorDetail `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode body %q: %v", recorder.Body.String(), err)
	}
	if envelope.Error.Code != "unsupported_protocol" {
		t.Fatalf("code = %q", envelope.Error.Code)
	}
	if len(envelope.Error.SupportedProtocolRange) != 2 ||
		envelope.Error.SupportedProtocolRange[0] != 1 ||
		envelope.Error.SupportedProtocolRange[1] != 1 {
		t.Fatalf("supportedProtocolRange = %v", envelope.Error.SupportedProtocolRange)
	}
	if !strings.Contains(recorder.Body.String(), `"supportedProtocolRange":[1,1]`) {
		t.Fatalf("range not serialized inline: %s", recorder.Body.String())
	}
}

func TestWriteCapabilityErrorContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteCapabilityError(recorder, "workflow requires a capability this server does not advertise", []string{"catalog.bff.v2"})

	if recorder.Code != 400 {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	var envelope struct {
		Error ErrorDetail `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode body %q: %v", recorder.Body.String(), err)
	}
	if envelope.Error.Code != "unsupported_capability" {
		t.Fatalf("code = %q", envelope.Error.Code)
	}
	if len(envelope.Error.Capabilities) != 1 || envelope.Error.Capabilities[0] != "catalog.bff.v2" {
		t.Fatalf("capabilities = %v", envelope.Error.Capabilities)
	}
	if envelope.Error.SupportedProtocolRange != nil {
		t.Fatalf("protocol range must be omitted for capability errors: %v", envelope.Error.SupportedProtocolRange)
	}
}

func TestSystemErrorBodiesOmitSecrets(t *testing.T) {
	secret := "postgres://torwatch:supersecret@db:5432/torwatch"
	recorder := httptest.NewRecorder()
	WriteProtocolError(recorder, "protocol mismatch", []int{1, 1})
	if strings.Contains(recorder.Body.String(), secret) {
		t.Fatal("protocol error echoed a secret")
	}
	recorder = httptest.NewRecorder()
	WriteCapabilityError(recorder, "missing capability", nil)
	if strings.Contains(recorder.Body.String(), secret) {
		t.Fatal("capability error echoed a secret")
	}
}
