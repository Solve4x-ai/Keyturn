# Changelog

All notable changes to Keyturn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Knowledge base reads** — `list_kb_articles` and `get_kb_article` let your AI read your NinjaOne knowledge base (client and global articles); `get_system_custom_fields` reads global custom fields. Read-only, both profiles.
- **Health write-back** — `propose_health_status` creates a plan to write a NinjaOne *Health Status* custom field on a device or organization (HEALTHY / NEEDS_ATTENTION / UNHEALTHY / UNKNOWN + description). It goes through the same approval pipeline as scripts and reads the field back afterwards: `verified` when NinjaOne shows the approved value, `unknown` (with what was stored) otherwise. Requires the new `healthWritebackEnabled` policy switch (off by default) and an existing Health Status field in NinjaOne.
- Plan review, approvals, and the device drawer show the exact field change for health plans.

### Changed

- Pinned NinjaOne API spec refreshed for NinjaOne 15.1 (+5 operations). Global custom field writes and device geolocation history are deliberately not exposed.

## [1.5.0] — 2026-09-30 — first public release

Keyturn began as a fork of
[NinjaOneMCP](https://github.com/Lungshot/NinjaOneMCP) and grew into a local
command center with a human-approval pipeline. This is the first public
release.

### Added

- **Dashboard** — Overview, Organizations, Devices,
  Infrastructure (Active Directory, DNS, DHCP, Group Policy, evidence
  coverage), Review Center, Approvals, Operations, Runbooks, Analytics,
  Reports, Security, and Settings. Zero-framework ES modules; dark, light, and
  system themes; `Ctrl+K` command palette; one organization scope across every
  page.
- **Plan → approval → receipt pipeline** — immutable, hashed plans; single-use
  expiring approvals; WebAuthn passkey enforcement once a key is enrolled;
  fresh preflight before dispatch; canary batches; receipt reconciliation.
- **Two isolated NinjaOne profiles** — read-only `reporting` (client
  credentials) and `command` (Native app, PKCE, rotating refresh token with a
  cross-process lock).
- **Evidence store** — per-tenant SQLite with versioned migrations; read-only
  diagnostic runbooks collect AD / DNS / DHCP / GPO state as timestamped
  observations with explicit coverage.
- **Review Center** — AI- and rule-proposed risks, improvements, and
  questions with provenance; human decisions are recorded and never
  rewritten.
- **Settings** — connector status and credential tests, in-app PKCE
  reconnect, passkey-gated policy editor, and one-click MCP client config
  merge for Claude Desktop (including the Microsoft Store build), Cursor,
  Windsurf, Codex, and Devin.
- **Demo mode** — `npm run demo` explores the full UI with a fictional MSP and
  no RMM account.
- ~80 MCP tools over stdio; see [TOOLS.md](TOOLS.md).

[Unreleased]: https://github.com/Solve4x-ai/Keyturn/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Solve4x-ai/Keyturn/releases/tag/v1.5.0
