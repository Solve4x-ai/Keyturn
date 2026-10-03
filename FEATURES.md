# Features

This document tracks the implemented capabilities and security boundaries of Keyturn — an RMM-agnostic command center (first connector: NinjaOne).

## Current platform

- Local stdio MCP transport (two profiles — see below)
- `@modelcontextprotocol/sdk` `1.30.0`
- Node.js 22.13 or newer (built-in `node:sqlite`)
- TypeScript runtime with mocked regression tests
- Separate reporting and command processes
- Per-tenant SQLite workspace at `%USERPROFILE%\.ninjaone-mcp\data\<tenant>.db` (WAL, shared by both profiles; entity metadata + evidence + review records only — no credentials)
- **Local browser dashboard** via a Fastify `serve` process bound to `127.0.0.1` with bearer-token auth (`npm run serve`; run one listener per profile on separate ports). This is the human approval, monitoring, infrastructure, review, and reporting surface — it is not an MCP transport. Open it at `http://localhost:<port>` (required for passkey approvals).
- **Optional live inventory sync** — `NINJA_SYNC_INTERVAL_MINUTES=<n>` makes the serve process refresh organizations, devices, policies, and locations from NinjaOne every *n* minutes. Plain NinjaOne API reads (≈4–5 calls per sync at ~100 devices); **no AI/LLM tokens**, nothing runs on endpoints.
- **Demo mode** — `npm run demo` runs the full UI against a fictional MSP (three organizations, ~85 devices) with no RMM account, fully sandboxed and read-only.
- **Knowledge base access** — read-only tools to list and read NinjaOne knowledge base articles (client and global) and global custom fields, so answers follow the MSP's own procedures.
- **Health write-back** — `set_health_status` plans write one NinjaOne Health Status custom field on a device or organization through the approval pipeline, then read it back (`verified` / `unknown`). Policy switch `healthWritebackEnabled`, off by default.
- No MCP HTTP/SSE transport, Docker service, or hosted gateway — local by design

## Authentication and profile isolation

### Reporting

- API Services Client Credentials flow
- Intended for a Monitoring-only NinjaOne application
- Loads only `config/reporting.env`
- Exposes the curated read-only tool set
- Hides known write tools

### Command

- Native application Authorization Code flow
- S256 PKCE, state validation, loopback validation, and refresh tokens
- Intended for Monitoring and Management scopes with Control disabled
- Loads only `config/command.env` and its profile-specific token file
- Fails closed when authorization is missing or invalid

The profiles do not share credential variables or token storage.

## Read and audit capabilities

- Organizations, locations, devices, alerts, activities, inventory, policies, users, contacts, and tickets
- Ticket metadata such as statuses, priorities, severities, types, tags, boards, and assigned users
- Complete paginated device and ticket retrieval
- Explicit completeness and truncation metadata
- Device activity and audit investigation
- Endpoint catalog search and domain navigation
- Fixed, curated endpoint discovery without arbitrary URL execution
- Local read-only audit exports with:
  - fixed export directory
  - safe output-name handling
  - pagination limits
  - secret-field redaction
  - completeness metadata

## Command capabilities and gates

When deliberately enabled by local policy, the command profile can expose:

- Create, update, and comment on tickets
- Reboot and maintenance-mode operations
- Device metadata and service control
- Alert reset, device approval, and policy assignment

Protection layers include:

- separate command authentication
- explicit organization allowlist
- category-level policy flags
- fail-closed unknown-tool handling
- target-organization checks
- explicit per-call confirmation fields (ticket writes)
- **approval-pipeline-only endpoint tools** — on the command profile, `run_device_script`, reboot / maintenance / service control / device approval / policy assignment, patching, software deployment, remote control, and destructive tools are **refused** from MCP calls (`APPROVAL_PIPELINE_REQUIRED`) and journaled as blocked. `confirm: true` cannot run them. Endpoint work goes through `create_plan` → human approval → dispatch. (`NINJA_REQUIRE_PLAN_APPROVAL=0` is the documented legacy escape hatch.)

The tracked example policy disables ticket writes and device management. Local operators must opt in explicitly.

## Disabled or absent high-risk capabilities

- Device scripts disabled by policy
- OS and software patch actions disabled by policy
- Software deployment disabled by policy
- Administrative writes disabled and blocked
- Destructive operations disabled
- Remote-control session creation not implemented
- Generic arbitrary API request execution not implemented
- Network MCP transport not implemented

`confirm: true` verifies declared intent inside the MCP call; it is not evidence of human approval, and it no longer unlocks any endpoint action. Human approval happens on the local UI's plan-review page and, once an approver key is enrolled, requires a passkey ceremony (below).

## Human-presence approvals (passkeys)

- Approve plans with a **hardware security key (e.g. YubiKey)** or a **password-manager passkey (e.g. Bitwarden)** — enroll several and choose any at approval time. Implemented as a dependency-free WebAuthn relying party (ES256, EdDSA, RS256).
- **Enforced once the first key is enrolled**: bearer-token approvals are refused; dispatch refuses any approval that was not passkey-verified (including stale pre-enrollment approvals); chained device sessions only count when opened by a passkey approval.
- User verification (PIN / touch / biometric) is mandatory. Each challenge is single-use, expires in 5 minutes, and is bound to one plan id + plan hash — a revised plan needs a new ceremony. RP id, origin, signature, and signature-counter regression are verified.
- The signed assertion is stored with the approval (`credential_id`, `assertion_json`), so approvals are independently re-verifiable; the approver is recorded as `passkey:<key name>`.
- Enrollment bootstrap: the first key enrolls with the local bearer session; every further enrollment and every revocation requires an existing key, and the last key cannot be revoked — enforcement cannot be switched off through the API.
- `powershellSessionMaxCommands: 0` disables chained device sessions so every command needs its own approval; the approval page discloses the active session policy.
- Honest limit: this closes the supported approval paths. It does not defend against software that edits the database or server code as the same OS user — that requires running the command center under a separate account.

## Operation contract (plans → approval → dispatch → receipt)

The execution path for endpoint work; the harness proposes, a human approves:

- `select_devices` — materializes a FROZEN device set into a selection handle; membership is fixed at creation, expires after 1 h, one org per selection
- `create_plan` — immutable plan from `runbookId`+`params` or a custom command; single device or `selectionId` batch with optional `canarySize`; returns a `reviewUrl`; executes nothing
- Human approval happens only on the local UI's plan page (`#/plan/<id>`), with the exact script, params, targets, and TTL shown; approvals expire (5 min) and are single-use
- `dispatch_plan` — idempotent per plan; `accepted` means submitted upstream, never "done"
- Durable reconcile sweep (~45 s) drains queued targets serially, survives restarts, and turns `accepted` into `verified`/`failed`/`partial`/`unknown` with per-target receipts
- `canarySize` batches dispatch N canaries first; all-verified auto-releases the remainder, any failure parks the batch at `canary_paused` pending a trusted UI release
- `list_operation_targets`, `list_operations`, `cancel_operation`, `get_operation` — per-target truth, bounded pages, honest cancel semantics (`accepted` runs are flagged + disclosed, not claimed stopped)
- Wire transport: params serialized as JSON data (never string-concatenated), gzip + UTF-16LE base64 envelope, ~7 K wire budget; runbooks are a versioned registry with param schemas, digests, and revocation (`runbook_revoked` fails closed)
- Stable contract envelope `{schemaVersion:1, ok, code, nextAction}` with fixed error codes — see `TOOLS.md` Phase 5

## Infrastructure evidence model (INFRA-1)

Read-only endpoint diagnostics land in a durable evidence store rather than chat memory:

- Runbooks `diag/domain-context`, `diag/dns-servers`, `diag/dhcp-scopes` (v4), `diag/dhcp-clients` — all pure `Get-*` reads
- **Immutable observations** (`entity_observations`, `relationship_observations`) timestamped `observed_at`/`collected_at`; `infra_current` is a rebuildable projection, never the source of truth
- **Coverage records** per source × namespace × section: complete / partial / failed / unverified / not-applicable — absence is claimed only where a complete enumeration ran
- Entity categories: domain, forest, domain-controller, fsmo-role, site, dns-server, dns-zone, dns-record, dhcp-server, dhcp-scope, dhcp-reservation, dhcp-lease, gpo, container — logical-entity dedup supersedes alias/`unknown-domain` twins while preserving evidence
- `diag/dns-records` collects normalized per-zone records (name/type/ttl/data/timestamp); records live in per-server zone namespaces (`dns-zone:<zone>@<server>`) so scoped absence stays correct and inter-DC zone divergence is visible; truncated zones are excluded from absence evaluation
- Deterministic finding `dns-static-in-dhcp-pool`: a static A record targeting an address inside an observed dynamic pool is flagged for validation (outlives lease churn, re-targets the name to lease holders)
- Conflict handling: competing observations surface as `conflicting`, never silently resolved
- Findings auto-fire on ingest (unauthorized DHCP, orphan AD authorizations, unlinked/disabled GPOs…) and flow into the Review Center
- **As-of replay**: `list_infrastructure_entities?asOf=<date>` (MCP + REST + UI date picker) returns the latest evidence collected at-or-before T, with `evidenceHorizon` disclosed — "as of T" means *known by T*, and pre-coverage dates honestly report "not yet measured"
- UI Infrastructure view: per-category tabs, coverage/freshness panel, entity detail drawers with observation history, and the as-of selector

## Review Center (REVIEW-1)

Organization-scoped durable record of observations, risks, improvements, questions, and decisions — a collaboration/evidence surface with **zero endpoint reach** (structurally: the service holds no API handle):

- `review_items` + immutable `review_item_revisions` with optimistic concurrency (`revision_conflict`)
- Typed evidence links to entities/observations/coverage; questions and answers with **provenance** — `direct`/`delegated` may decide, `reported` (harness/AI) is context only and can never become a confirmed decision
- Decisions with supersede chains; rationale required for dismiss / accept-risk / unverified closure; evidence basis required for `verified_resolved`
- Fingerprint dedupe on import; suppressions with reason/expiry; review-due dates; **auto-reassessment** — a decided item flags `reassessment_needed` when its linked entity gains a new contradictory finding, without rewriting the recorded decision
- Finding-import enriches items with human-readable consequence ("why it might matter"), knowns/unknowns, and genuinely-entity-specific open questions (e.g. "Is DC05 intended to serve DHCP?")
- Operation/plan links record context — linking never approves or dispatches
- UI `#/review/<org>`: Inbox / Questions / Risks / Improvements / Decisions tabs, expandable evidence, full-context text, answer/decision controls — no "Fix" button anywhere
- 13 MCP tools (5 reads both profiles, 8 writes gated by command profile + `reviewWritesEnabled`); REST routes back the UI

## Dashboard

Vanilla ES modules, no framework, no build step, no runtime dependencies. Design system "Aurora": oklch color tokens, glass surfaces, dark / light / system themes × cyan / blue / violet / teal accents × compact / comfortable density, collapsible grouped sidebar, View Transitions between pages, container-query layouts.

- **Overview** (`#/hud`, landing page) — fleet online ring with offline aging, server constellation with evidence-backed DC / DNS / DHCP roles, ranked attention queue (pending approvals, offline servers, failed operations, critical risks, stale sync), 14-day operations chart, AI findings by severity and category, merged activity stream, per-organization health, org scope switcher, and a network-edge card reserved for the SNMPv3 agent. Every live-looking number shows "as of last sync". Backed by `GET /api/v1/hud` (one local aggregate, ~15 ms).
- **Analytics** (`#/analytics`) — 7-day to 1-year windows: operations throughput and outcome mix, per-runbook reliability with median time-to-receipt, p50/p95 receipt latency, most-worked devices, observed change volume, findings opened vs closed, check-in distribution, infrastructure knowledge, and tool usage. Backed by `GET /api/v1/analytics`.
- **Organization scope switch** (top bar) — an "All orgs" segment plus a searchable organization picker showing each tenant's online ratio, servers, and open risks. The scope applies to every page: Keyturn, Analytics, Devices, and Organizations filter to it; Infrastructure, Review Center, and Reports follow it and show an organization chooser while "All" is selected. It persists across reloads, deep links (`?org=<id>`, `?org=all`, or an org in the path) override it, and in-page links keep it.
- **Organizations** (`#/organizations`) — tenant cards with online ring, servers, offline count, and risk posture.
- **Organization page** (`#/org/<id>`) — a command page per tenant: online ring, six KPIs (endpoints, servers up, open risks, approvals, 30-day operation success, evidence completeness), needs-attention queue, an infrastructure snapshot (domain, DCs with FSMO, DNS/DHCP/GPO tiles, DHCP scope utilization), server constellation, AI findings, offline devices, and recent activity. Opening it scopes the whole app to that organization.
- **Infrastructure, visual edition** — backed by `GET /api/v1/orgs/:id/infrastructure/topology` (one structured model built from the evidence store, ~30 ms):
  - *Overview*: domain hero with functional levels and the five FSMO roles, DC cards (live agent LED, IP, OS, site, GC/RODC, FSMO pips), DNS / DHCP / GPO service cards, **health signals** derived from collected evidence (unauthorized DHCP with active scopes, scope exhaustion, DHCP handing out non-DC or public DNS, stale AD DHCP authorizations, nonsecure dynamic-update zones, scavenging off, FSMO concentration, unlinked GPOs), findings, and an evidence-completeness strip.
  - *Directory*: forest → domain → site → DC tree, and an FSMO role map.
  - *DNS*: per-server switch, forwarders and scavenging, zone-set divergence between servers, and a zone grid (type, AD-integrated, dynamic-update mode, record count, record-type mix) with filters (forward / reverse / nonsecure / not AD-integrated) and search. A zone opens an inspector with searchable, type-filtered records.
  - *DHCP*: per-server authorization status, scope cards with utilization gauges, range, gateway, DNS servers (non-DC and public resolvers highlighted), and lease time. A scope opens its clients (leases and reservations, filterable, linked to device pages). AD authorization records are checked against live agents.
  - *Group Policy*: status counts as filters, by-policy cards (status, links, modified) or by-container view; a GPO opens its links and dates.
  - *Evidence*: a source × section coverage matrix plus plan-backed refresh buttons (approval required).
  - Every inspector keeps the full evidence and observation history one click away. An "as of" date still replays historical evidence in list form.
  - Health signals state the age of the evidence they come from, so a signal about configuration changed since the last collection is visibly stale rather than presented as current.
- **Derived fields are re-derived on read.** Raw collected values are immutable; interpretations (e.g. GPO enabled/disabled labels) are recomputed with the current decoder in every list, detail, history, as-of, and change-feed read, so a decoder fix corrects the UI, reports, and MCP clients without rewriting evidence. Findings raised by a superseded rule version are retracted by migration; human review records are never rewritten.
- Inspector drawers sit above the top bar (close button always reachable) and close automatically on navigation.
- **Command palette** (Ctrl+K or `/`) — jump to pages, devices, organizations, review findings, and runbooks; local data only, never executes.
- **Attention bell** — the same ranked queue as the Overview, from any page.
- **Devices** — fleet stat cards, server / workstation and online / offline filters, status dots, check-in aging measured against the last sync.
- **Approvals** — plan cards with live expiry countdowns; approval-mode banner.
- **Plan review** — line-numbered exact script, parameters, frozen target sets, impact (classification, disruption, scope, side effects), device-session disclosure, provenance, and a passkey approve button.
- **Operations** (`#/operations`) — execution history with outcome filters and search; operation detail with receipts, structured results, and an event timeline.
- **Runbook library** (`#/runbooks`) — reviewed, versioned scripts with purpose, classification, parameters, limits, review status, digest, and full script.
- **Approval security** (`#/security`) — enroll / revoke approver keys, see what guards execution and its limits.
- **Activity** — the tool-call journal with result icons (ok / dry run / blocked / error) and device names.
- Existing Infrastructure, Review Center, and Reports views restyled to the same system.

## Reporting & analytics

- `generate_report` MCP tool + `GET /api/v1/orgs/:org/report` REST: `reportType:"operations"` (work performed — verified vs attempted vs failed, observed software changes, coverage gaps) or `"org"` (adds infrastructure entity/coverage state and review outcomes — decisions by disposition, open questions, reassessments, suppressions)
- Windows: `sinceDays` (1–400, default quarter) or explicit `since`/`until`; org-scoped; `format:"json"` for AI consumption or `"markdown"` for human documents
- Reports keep attempted vs verified distinct, disclose coverage gaps and evidence horizons, and carry method notes — safe input for AI-generated prose/PDF
- UI Reports view (`#/reports/<org>`): org + window picker, rendered sections, browser print-to-PDF stylesheet

## Local workspace and efficiency

- Name-or-ID resolution on device, organization, and policy parameters —
  numeric values pass through; names resolve via the local cache with an
  exact → prefix → substring → normalized ladder. Ambiguous names always
  error with a candidate list; resolution never guesses.
- `resolve_devices` / `resolve_organizations` / `resolve_locations` /
  `resolve_policies` tools with batch `names[]` support.
- `sync_entities` — manual or TTL-driven lazy sync; TTLs tunable via
  `NINJA_CACHE_*_TTL_MIN` env vars (devices 15 min, others 24 h defaults).
- `get_entity_changes` — field-level diff history recorded on every sync:
  appearances, disappearances, renames, offline flips, org/location moves.
- `get_operation_journal` — append-only local audit of command-profile tool
  calls with redacted args, resolved target IDs, dry-run flag, and outcome.
- `save_filter` / `list_saved_filters` / `delete_saved_filter` — named
  parameter presets merged into `filter`-accepting tools.
- `set_context` / `get_context` — sticky in-memory session organization scope.
- `detail:"summary"` default projections on device, organization, ticket, and
  alert list tools; `detail:"full"` restores raw API output.
- `search_devices_by_name` now resolves through the full cached inventory
  rather than scanning only the first API page.

## Safety and regression coverage

Automated tests cover:

- reporting profile write isolation
- command profile fail-closed behavior
- category flags and confirmation requirements
- organization targeting
- pagination and completeness behavior
- export path safety and redaction
- endpoint navigation
- local stdio-only distribution
- entity sync diffing (appear/change/disappear)
- resolver match ladder, ambiguity refusal, and organization scoping
- journal argument redaction
- saved-filter round-trips and summary projections
- plan→approval→dispatch lifecycle: stale/expired/mismatch approvals, idempotent dispatch, canary gate, per-target truth
- runbook registry: versioning, digest pinning, revocation fail-closed, wire budget
- infra extraction/projection for all runbook versions incl. DHCP v4 + clients v1
- scoped absence semantics (absence only from complete enumeration) and conflict surfacing
- logical-entity dedupe / `unknown-domain` supersession
- as-of replay (evidence-at-T selection, horizon disclosure)
- review lifecycle: revision conflicts, provenance gates, required rationale/evidence, suppression, dedupe, auto-reassessment, cross-org rejection, zero-executor construction
- org report outcome separation (proposed vs verified-resolved vs unverified closure)
- MCP confirm-flag bypass regression: `run_device_script` via the runner script id, reboot, and service control are refused with no upstream call
- WebAuthn with real ES256 / Ed25519 software authenticators: enrollment bootstrap and step-up, UV required, origin / RP binding, single-use plan-bound challenges, replay, signature tampering, counter regression, revocation rules, and enforcement at approve / dispatch / session reuse
- Infrastructure topology: FSMO holders via relationships, DC twin collapse, agent matching, DHCP utilization and option decoding, stale authorizations, "unlinked" only under complete link coverage, empty-org honesty, org isolation
- HUD and analytics semantics: evidence-only roles, offline-server ranking, org scoping, success rate from terminal outcomes only, no imputed durations
- PowerShell runner contract (separate `npm run test:runner`)

Development verification:

```powershell
npm run verify
npm audit
```

The ordinary test suite uses mocks and does not modify the live NinjaOne tenant.

## Roadmap (planned, not yet built)

- **Network edge agent** — an SNMPv3 collector deployed on each site network reporting switches, firewalls, access points, and printers back to the command center; a Network view and live device tiles on Keyturn (the HUD already reserves the slot and reports "not connected" honestly).
- **Approved device actions as runbooks** — reboot, service restart, maintenance mode, and patch operations rebuilt as plan-backed runbooks so they return to use behind passkey approval.
- **Review Center and Reports redesign** on the v3 system; scheduled management reports (e.g. "software cleaned up over the last 6 months") with Markdown / HTML / PDF export.
- **Settings page** — appearance, default views, sync interval, session policy visibility, and about/build info.
- **Notifications** — optional alerts (e.g. a server goes offline, a plan awaits approval) once a delivery channel is chosen.
- **OS-level separation** — run the command-profile server under its own Windows account so an agent running as the operator cannot touch its database or code.
- **Multi-target maintenance at scale** — vetted install / uninstall / standardization runbooks with canary batches across organizations.

## Deliberately deferred

- MCP Tasks: not currently needed for synchronous local operations
- MCP Apps UI: not needed — the local Fastify browser UI is the approval/visibility surface
- Independent Windows approval broker: superseded by the local plan-approval UI plus passkey (WebAuthn) human-presence verification
- Streamable HTTP / remote MCP transport: deferred until a remote deployment has a concrete need and dedicated security design
- Docker/hosted deployment: deferred because local stdio minimizes network exposure and operational complexity
- Server-side PDF rendering: print-to-PDF via the browser stylesheet is the current path

## Maintenance principles

- Prefer the smallest secure implementation that fully supports the approved workflow.
- Remove duplicate or obsolete code after reference and runtime verification.
- Keep reporting the default operational profile.
- Add capabilities narrowly, with tests and safe defaults.
- Do not trade security or correctness for fewer lines of code.
- Keep this file synchronized with material capability, dependency, or security changes.
