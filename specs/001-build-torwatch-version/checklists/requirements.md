# Requirements Checklist: TorWatch Version 2 — Shared Backend and BFF for Multiple Clients

**Purpose**: Standard Spec Kit requirements-quality validation of the active feature specification before planning.
**Created**: 2026-09-04
**Feature**: [spec.md](../spec.md) (`specs/001-build-torwatch-version/spec.md`)

**Review Ownership**: This checklist is a reviewer-owned requirements-quality review artifact. Mark an item `[x]` only when the reviewer determines the requirements-quality criterion is satisfied.
**Marker Semantics**: `[x]` means the criterion has been reviewed and satisfied for requirements quality. It does not mean implementation work is complete.

## Requirement Completeness

- [x] CHK001 All functional requirements are defined with clear MUST/MAY semantics and no open decision points remain (no `NEEDS CLARIFICATION` markers present; FR-013 resolved to strict deferral of pairing/authentication).
- [x] CHK002 The scope boundary between this milestone and deferred milestones is explicit (FR-013, FR-014, Assumptions).
- [x] CHK003 Every user story has at least one verifiable acceptance scenario, including the migration-safety story (User Story 4, three scenarios).

## Requirement Clarity

- [x] CHK004 Requirements distinguish the four compatibility commitments: permanent core outcomes, temporary Version 1 migration compatibility, intentional Version 2 contract evolution, and permanent compatibility only where explicitly specified ("Compatibility and Contract Evolution" section).
- [x] CHK005 Version 1 compatibility is stated as migration-scoped, not permanent API identity (FR-010, User Story 4, SC-003).
- [x] CHK006 The client/device identifier's role is unambiguous: required for progress/protocol/lease coordination but explicitly not an authentication credential or security boundary (FR-013, Client/Deployment entity).
- [x] CHK007 Removal of obsolete routes is governed by explicit removal-gate conditions rather than left implicit (FR-010: no remaining consumer, contract tests green, rollback path recorded).

## Requirement Consistency

- [x] CHK008 Requirements are consistent with the constitution's safe-evolution gates: characterization tests before refactoring, new path implemented and verified before old path removal, per-client migration and verification, adapters while old clients remain (FR-002, FR-010; Constitution v2.0.0 principles II–V).
- [x] CHK009 Requirements are consistent with the `docs/v2-server-package/` handoff where applicable (single gateway, trusted-LAN posture, system endpoints, multi-arch artifacts) and explicitly supersede the handoff's "no route changes" freeze through specified versioned evolution rather than silent contradiction.
- [x] CHK010 Terminology is consistent across stories, requirements, and entities (client-neutral BFF, protocol version, watch lease, client/device identifier; "pairing" no longer used to mean protocol detection).

## Acceptance Criteria Quality

- [x] CHK011 Success criteria are measurable or objectively verifiable (SC-001 through SC-006 define observable outcomes, deployment facts, and failure tolerances).
- [x] CHK012 SC-003 verifies migration safety with zero *unexplained* regressions rather than an unbounded zero-change rule, matching FR-010 and User Story 4.
- [x] CHK013 Data-preservation success criteria distinguish migration-attributable loss from general failure (SC-005: "no data loss attributable to the V2 migration").
- [x] CHK014 Resource and deployment criteria name the concrete target envelope (4 GB ARM host, one active stream, no OOM termination; SC-006).

## Edge Case Coverage

- [x] CHK015 Provider degradation, no-viable-source outcomes, lease contention, protocol-version mismatch, mid-stream disconnect, restart during streaming, and provider data conflicts are each addressed with required behavior (Edge Cases section).
- [x] CHK016 Protocol-version mismatch edge case is phrased as detect-and-report compatibility behavior, consistent with deferred authentication (Edge Cases; FR-011, FR-013).

## Non-Functional Requirements

- [x] CHK017 Security posture is explicit and realistic for the milestone: trusted LAN/private overlay only, no public exposure until a later security specification covers authentication, authorization, opaque stream sessions, and abuse controls (FR-013).
- [x] CHK018 Secret and diagnostic redaction is required in all new backend/BFF paths (FR-012).
- [x] CHK019 Operability requirements are present: liveness, readiness, version/protocol reporting, restart/upgrade data preservation (FR-004, FR-009, SC-004, SC-005).

## Specification Workflow

- [x] CHK020 No `NEEDS CLARIFICATION` markers remain anywhere in the specification.
- [x] CHK021 No plan or implementation artifacts were created for this feature (only `spec.md` and `checklists/requirements.md` exist under the feature directory).
- [x] CHK022 The specification is ready for `/speckit.plan` without further clarification.

## Notes

- The specification was repaired on 2026-09-04 to align with Constitution v2.0.0: FR-002, FR-010, User Story 4, and SC-003 were rewritten from a permanent API freeze to migration-safe evolution with removal gates; FR-013 was resolved by strictly deferring client pairing/authentication and requiring trusted-LAN/private-overlay deployment.
- No remaining failures found. All items validated against the repaired specification text on 2026-09-04.
- Reviewer guidance: `/speckit.implement` reads checklist checkbox state as a gate and must not modify markers.
