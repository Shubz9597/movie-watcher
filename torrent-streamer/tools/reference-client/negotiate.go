package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Protocol negotiation (spec Clarification 4, FR-011): the client decides
// from the server's advertised supportedProtocolRange and capability flags —
// never from application version numbers. Ranges overlap ⇒ use the highest
// mutually supported protocol; no overlap ⇒ block only the incompatible
// workflow with an actionable message. Health/readiness/version discovery
// are never gated.

const clientSupportedProtocolMin = 1
const clientSupportedProtocolMax = 1

// Version mirrors the GET /v1/version payload
// (contracts/protocol-negotiation.md). AppVersion is informational only.
type Version struct {
	ServerVersion          string   `json:"serverVersion"`
	Revision               string   `json:"revision"`
	BuiltAt                string   `json:"builtAt"`
	ProtocolVersion        int      `json:"protocolVersion"`
	SupportedProtocolRange []int    `json:"supportedProtocolRange"`
	GoVersion              string   `json:"goVersion"`
	OS                     string   `json:"os"`
	Arch                   string   `json:"arch"`
	Capabilities           []string `json:"capabilities"`
}

// Decision is the client-side compatibility outcome.
type Decision struct {
	Compatible bool
	Protocol   int
	Reason     string
}

// Negotiate compares the server's advertised range with the client's own
// supported range. Application versions are never consulted.
func Negotiate(serverRange []int, clientMin, clientMax int) Decision {
	if len(serverRange) != 2 {
		return Decision{Compatible: false, Reason: "server advertised no usable supportedProtocolRange"}
	}
	low := serverRange[0]
	high := serverRange[1]
	if clientMin > low {
		low = clientMin
	}
	if clientMax < high {
		high = clientMax
	}
	if low > high {
		return Decision{
			Compatible: false,
			Reason: fmt.Sprintf(
				"protocol ranges do not overlap: server supports [%d,%d], client supports [%d,%d] — upgrade TorWatch (client or server) to a version sharing a protocol level",
				serverRange[0], serverRange[1], clientMin, clientMax,
			),
		}
	}
	protocol := high
	return Decision{Compatible: true, Protocol: protocol}
}

// FetchVersion reads GET /v1/version (never gated, always accessible).
func (c *Client) FetchVersion(ctx context.Context) (Version, error) {
	var version Version
	err := c.getJSON(ctx, "/v1/version", &version)
	return version, err
}

// EnsureCompatible verifies protocol-range overlap before starting a
// workflow. A missing/unreachable version endpoint keeps old backends usable
// (fail-open with reason) — only an explicit non-overlap blocks.
func (c *Client) EnsureCompatible(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	version, err := c.FetchVersion(ctx)
	if err != nil {
		return nil
	}
	decision := Negotiate(version.SupportedProtocolRange, clientSupportedProtocolMin, clientSupportedProtocolMax)
	if !decision.Compatible {
		return &ProtocolMismatchError{Reason: decision.Reason}
	}
	return nil
}

// HasCapability reports whether the server advertises a capability flag.
func (v Version) HasCapability(capability string) bool {
	for _, flag := range v.Capabilities {
		if flag == capability {
			return true
		}
	}
	return false
}

// ProtocolMismatchError blocks only the incompatible workflow.
type ProtocolMismatchError struct{ Reason string }

func (e *ProtocolMismatchError) Error() string { return "protocol mismatch: " + e.Reason }

func (c *Client) getJSON(ctx context.Context, path string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GET %s: status %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}
