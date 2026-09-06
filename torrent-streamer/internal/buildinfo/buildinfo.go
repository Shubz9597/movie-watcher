package buildinfo

import (
	"runtime"
)

const (
	// ProtocolVersion is the highest protocol the server speaks.
	ProtocolVersion = 1
	// MinProtocolVersion is the inclusive lower bound of the supported range.
	MinProtocolVersion = 1
	// MaxProtocolVersion is the inclusive upper bound of the supported range.
	MaxProtocolVersion = 1
)

// Ldflags-injectable defaults; overridden at build time via
// -ldflags "-X torrent-streamer/internal/buildinfo.AppVersion=...".
var (
	AppVersion = "dev"
	Revision   = "unknown"
	BuiltAt    = "unknown"
)

// Info is the machine-readable payload served by GET /v1/version
// (contracts/protocol-negotiation.md). Capabilities MUST list only features
// that are implemented and available on this server.
type Info struct {
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

// Options overrides the ldflags defaults for a constructed Info.
type Options struct {
	// ServerVersion overrides AppVersion (e.g. from TORWATCH_APP_VERSION).
	ServerVersion string
	// Capabilities is the list of features implemented by this build. Empty
	// until a capability actually ships (catalog.bff.v2 from the catalog
	// phase onward; leases.shared / progress.serverOrdered only when those
	// land).
	Capabilities []string
}

// New returns the version/capability payload for this server.
func New(opts Options) Info {
	version := opts.ServerVersion
	if version == "" {
		version = AppVersion
	}
	capabilities := opts.Capabilities
	if capabilities == nil {
		capabilities = []string{}
	}
	return Info{
		ServerVersion:          version,
		Revision:               Revision,
		BuiltAt:                BuiltAt,
		ProtocolVersion:        ProtocolVersion,
		SupportedProtocolRange: []int{MinProtocolVersion, MaxProtocolVersion},
		GoVersion:              runtime.Version(),
		OS:                     runtime.GOOS,
		Arch:                   runtime.GOARCH,
		Capabilities:           capabilities,
	}
}
