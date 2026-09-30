# Changelog

All notable changes to Mission Control are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.0] — 2026-09-30 — first public release

Mission Control began as a fork of
[NinjaOneMCP](https://github.com/Lungshot/NinjaOneMCP) and grew into a local
command center with a human-approval pipeline. This is the first public
release.

### Added

- **Command Center UI** — Mission Control HUD, Organizations, Devices,
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

[Unreleased]: https://github.com/Solve4x-ai/Mission-Control/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Solve4x-ai/Mission-Control/releases/tag/v1.5.0
