# Contract: Protocol Negotiation, Capabilities, and Error Codes

**Feature**: `001-build-torwatch-version` | **Owner**: `internal/buildinfo` + `internal/httpapi/system_handlers.go` | **Status**: designed (implemented in P1, consumed from P6)

Client-decided compatibility (spec Clarification 4 / FR-011): the server publishes
truthful version + range + capability information; each client decides. Compatibility
comes from protocol ranges and capabilities — never application version numbers.

## `GET /readyz`

Readiness with non-secret component status. `200` when required components are ready;
`503` with safe component state otherwise.

```json
{ "status": "ok", "components": { "postgres": "ok", "prowlarr": "ok" | "degraded" } }
```

Secrets (DSN passwords, API keys) MUST never appear in component details (FR-012).

## `GET /v1/version`

```json
{
  "serverVersion": "2.0.0-alpha.1",
  "revision": "0123456789ab",
  "builtAt": "2026-08-31T00:00:00Z",
  "protocolVersion": 1,
  "supportedProtocolRange": [1, 1],
  "goVersion": "go1.24.2",
  "os": "linux",
  "arch": "arm64",
  "capabilities": ["catalog.bff.v2", "leases.shared", "progress.serverOrdered"]
}
```

- `protocolVersion` — highest protocol the server speaks.
- `supportedProtocolRange` — inclusive `[min, max]` of protocol versions the server can
  serve for existing contract surfaces.
- `capabilities` — feature flags a client can gate workflows on. Declared for V2:
  - `catalog.bff.v2` — `/v2/catalog/*` is available (advertised from P3 onward).
  - `leases.shared` — shared per-title leases with `clientId` correlation (P7).
  - `progress.serverOrdered` — server-ordered progress with `seq` guard (P7).

## Negotiation rules

1. Client fetches `/v1/version` (and may cache it); compares its own
   `supportedProtocolRange` with the server's before starting a workflow.
2. Ranges overlap ⇒ client uses the highest mutually supported protocol version.
3. No overlap ⇒ client blocks ONLY the incompatible workflow and shows an actionable
   upgrade message. Health, readiness, and version discovery remain accessible (never
   gated).
4. Workflow-level capability check: a capability listed by the server but not supported
   by the client's protocol ⇒ client skips/degrades that workflow; the reverse is
   handled by server errors below.
5. The server MUST NOT reject a request merely because the client's application version
   differs. Enforcement is limited to rule 6.
6. If a request explicitly asks for a protocol version or capability the server cannot
   serve, it responds with the machine-readable errors below.

## Error codes (machine-readable)

| Code | HTTP | When | Payload |
|---|---|---|---|
| `unsupported_protocol` | 400 | Request declares/expects a protocol outside `supportedProtocolRange` for that contract surface | `{error:{code:"unsupported_protocol", message, supportedProtocolRange:[min,max]}}` |
| `unsupported_capability` | 400 | Request requires a capability the server does not advertise | `{error:{code:"unsupported_capability", message, capabilities:[…]}}` |
| `capacity_exceeded` | 503 | New stream/lease request would exceed the configured distinct-key admission limit (see leases-and-progress.md) | `{error:{code:"capacity_exceeded", message, retryAfterSeconds}}` — retry guidance; NEVER affects existing healthy leases/streams |
| `providers_unavailable` | 503 | All catalog providers failed for a request | `{error:{code:"providers_unavailable", message, degradedProviders:[…]}}` |

Error bodies MUST NOT echo secrets, magnets, or provider credentials (FR-012).

## Versioning policy

- `/v2/*` routes are the first explicitly versioned namespace. When a contract change is
  incompatible, a new namespace/range is introduced and the old one passes through its
  removal gate (spec FR-010) — never a silent semantic change.
- `supportedProtocolRange` widening is additive and requires no client action;
  narrowing requires the removal-gate procedure.
