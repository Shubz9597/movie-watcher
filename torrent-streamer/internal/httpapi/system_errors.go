package httpapi

import (
	"encoding/json"
	"net/http"
)

// ErrorDetail is the machine-readable error envelope shared by V2 system
// surfaces (contracts/protocol-negotiation.md §Error codes). Bodies must
// never echo secrets, magnets, or provider credentials (FR-012).
type ErrorDetail struct {
	Code                   string   `json:"code"`
	Message                string   `json:"message"`
	SupportedProtocolRange []int    `json:"supportedProtocolRange,omitempty"`
	Capabilities           []string `json:"capabilities,omitempty"`
}

type errorEnvelope struct {
	Error ErrorDetail `json:"error"`
}

// WriteProtocolError responds 400 with `unsupported_protocol` and the
// server-supported range so the client can render actionable upgrade
// guidance (FR-011). Compatibility is decided by protocol ranges and
// capabilities — never application version numbers.
func WriteProtocolError(w http.ResponseWriter, message string, supportedRange []int) {
	writeSystemError(w, http.StatusBadRequest, ErrorDetail{
		Code:                   "unsupported_protocol",
		Message:                message,
		SupportedProtocolRange: supportedRange,
	})
}

// WriteCapabilityError responds 400 with `unsupported_capability` and the
// server's advertised capability list (FR-011).
func WriteCapabilityError(w http.ResponseWriter, message string, capabilities []string) {
	writeSystemError(w, http.StatusBadRequest, ErrorDetail{
		Code:         "unsupported_capability",
		Message:      message,
		Capabilities: capabilities,
	})
}

func writeSystemError(w http.ResponseWriter, status int, detail ErrorDetail) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{Error: detail})
}
