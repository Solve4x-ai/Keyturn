# Changelog

All notable changes to Mission Control (Solve4x command center; NinjaOne connector). Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely; entries explain the
*why* so future maintainers (human or AI) can review decisions in context.

## Command Center v3 — 2026-09-27

### Added

- **Mission Control** landing HUD, **Analytics** (7 d – 1 y), **command palette**, **Operations** list, **Runbook library**, and redesigned **Approvals / Plan review / Operation** pages.
- **Global organization scope** switch ("All orgs" + searchable picker) applied to every page; **Organizations** directory and per-tenant **organization command pages**.
- **Visual Infrastructure** backed by `GET /api/v1/orgs/:id/infrastructure/topology`: AD map with FSMO roles, DNS zone grid, DHCP scope gauges, Group Policy health, coverage matrix, evidence-derived health signals with evidence age, and inspector drawers.
- **Passkey (WebAuthn) approvals** — YubiKey / Bitwarden; enforced once a key is enrolled; bootstrap-guarded enrollment; plan-hash-bound single-use challenges; signed assertions stored with approvals. Schema v15.
- Live inventory sync (`NINJA_SYNC_INTERVAL_MINUTES`) — NinjaOne API reads only.

### Security

- Endpoint-affecting MCP tools can no longer bypass the plan → approval pipeline with `confirm: true`.
- `powershellSessionMaxCommands: 0` disables chained device sessions.

### Fixed

- **GPO status was inverted.** `Get-GPO` GpoStatus is the .NET enum (3 = AllSettingsEnabled), not AD `flags` (0 = enabled). Extractor v4 decodes it correctly, the three GPO finding rules (v2) test the intended condition, labels are re-derived on read, and migration v16 retracts the v1 findings raised on the inverted condition. Verified against GPMC on a production DC, 31/31 GPOs.
- Inspector drawer sat under the sticky top bar (close button unreachable) and persisted across pages.
- SSE live indicator showed "offline" until the first heartbeat.

## Unreleased — Investigations retired

### Removed

- **Investigations** (schema v14) — the M3-era evidence-clipboard surface is
  retired, superseded by the Review Center's evidence-linked item model.
  Removed: Investigations nav tab + views, device-drawer pin workflow,
  `/api/v1/investigations*` routes, `pin_snapshot_evidence` MCP tool,
  `SnapshotService.pinEvidence`, store CRUD, and the `investigations` +
  `investigation_items` tables (`MIGRATION_14` drops them on upgrade —
  destructive, scoped, intentional per product direction).

## Unreleased — REVIEW-1 Review Center

Milestone packet: [docs/review-center.md](docs/review-center.md).

### Added

- **Review Center** (`#/review/<org>/<tab>`) — durable org-scoped review
  records over retained infrastructure evidence: observations, risks, and
  improvements with immutable revisions, optimistic concurrency, typed
  evidence links (same-org validated), questions/answers (conflict-aware,
  "I don't know" is terminal), provenance-gated decisions, suppressions,
  and operation/plan links. Findings auto-import as `proposed` items on the
  ingestion sweep — never confirmed without a human decision.
- **13 review MCP tools** (5 read, 8 write) + matching `/api/v1/orgs/:org/review/*`
  REST routes. Writes require the command profile AND the
  `reviewWritesEnabled` policy flag (default off in `policy.example.json`).
- **Zero-executor invariant** — `ReviewService` holds only the EntityStore;
  no path to the NinjaOne API exists. Structural test asserts it.
- Schema v12 (`MIGRATION_12`): review_items, revisions, questions, answers,
  evidence_links, decisions, suppressions, item_ops, events, org_annotations.
- **Auto-reassessment** — a decided item flags `reassessment_needed` when its
  linked entity gains a new contradictory finding; the recorded decision is
  never rewritten.
- **Finding enrichment** — imported findings carry human-readable
  consequence ("why it might matter"), knowns/unknowns, and
  entity-specific open questions; earlier items are backfilled in place.
- **Logical-entity dedupe** — `unknown-domain`/FQDN alias twins supersede
  onto resolved canonical entities (fixes double-counted domain
  controllers); a one-time repair pass supersedes stale twins.

## Unreleased — R5 Reporting & point-in-time

### Added

- **Reports/Analytics UI** (`#/reports/<org>`) — org + window picker,
  rendered report sections, browser print-to-PDF stylesheet.
- **`generate_report` `reportType:"org"`** + `GET /api/v1/orgs/:org/report`
  — org report combines operations (verified vs attempted), infrastructure
  entity/coverage state, and review outcomes (decisions by disposition,
  open questions, reassessments, suppressions). `format:"markdown"`
  produces the management-readable document; JSON stays AI-consumable.
- **As-of infrastructure browsing** — `?at=`/`asOf` on
  list_infrastructure_entities (REST + MCP) replays the latest observation
  per entity collected at-or-before T; `evidenceHorizon` is disclosed and
  pre-coverage dates report "not yet measured" rather than empty data.
  Infrastructure UI tabs carry an "As of" date selector.

## Unreleased — K4 DNS record detail

### Added

- **Triage scoring (schema v13)** — `severity` (critical|high|medium|low,
  how bad if true) × `confidence` (high|medium|low, how sure the evidence
  is) → `priority_score` (1–12) on review items; inbox + digest sort by
  score. Settable on propose/revise (validated enums, carried on
  revisions), defaulted per finding rule, backfilled on import. The UI
  shows severity/confidence badges and the score column.

- **`diag/dns-records` v1** — normalized per-zone DNS record collection
  (name/type/ttl/data/timestamp; `ts:null` = static record) plus per-zone
  aging, converging on the proven checkpoint-audit field shape. Records are
  `dns-record` entities under per-server zone namespaces
  (`dns-zone:<zone>@<server>`) — scoped absence stays correct per zone
  copy and inter-DC zone divergence remains visible. Truncated zones are
  excluded from absence evaluation (a capped dump can't prove removal).
- **`dns-static-in-dhcp-pool` finding** — a static A record inside an
  observed dynamic DHCP range is flagged: the record outlives lease churn
  and silently re-targets the name to whoever holds the lease. Surfaced as
  a validation finding, not asserted misconfiguration.

### Fixed

- **`diag/ad-health` v3 exceeded the 7000-char wire budget** (7160) — the
  programmatically-derived compressed-footer variant could never dispatch.
  v2 body trimmed (dropped the unconsumed `replicationMeasure` block);
  v3 now encodes at 6976. Regression guard added: every registered runbook
  script is asserted to fit the wire budget in tests.

## [1.5.0] — 2026-09-15 — "Command Center M3" release

Milestone packet: `docs/m3-packet.md` (internal). Read-only UI +
persistent investigations only — no writes, no approvals, no embedded
assistant, no packaging.

### Added

- **Built-in read-only UI** (`public/` — vanilla HTML/CSS/JS, zero build step,
  zero new dependencies) served by `npm run serve` at `http://127.0.0.1:3939`.
  Left-nav shell: Overview, Devices, Investigations, Activity. Profile badge,
  connection id, and sync-age freshness always visible. Pass the serve token
  once via `?token=` (saved to localStorage) or enter it when prompted.
- **`/api/v1` read-only data routes** on the local server — server-paginated
  `devices` (q substring on name/display/dns, `orgId`), `devices/:id` detail
  (entity + org + recent changes + journal), `overview`, `changes`, `journal`.
  Every response projects allowlisted columns only — `raw_json` can never
  egress (invariant 10; a live-smoke catch fixed during M3).
- **Persistent investigations** (schema v4, additive) — `investigations`
  (uuid, connection_id, title, org scope, `revision`, `last_seen_seq`
  watermark) + `investigation_items` (entity refs, allowlisted snapshot,
  note, per-item watermark). Revision-checked updates (optimistic
  concurrency, §16.2) — HTTP 409 on stale revision.
- **Stale evidence on reopen** — `GET /api/v1/investigations/:id` annotates
  each item: `entity_removed`, `fields_changed` (+changed field list), or
  `new_observations` (+count) computed against stored snapshots and the
  change log; returns `changesSince` (new entity_changes since the
  investigation watermark) then advances `last_seen_seq` — honest
  "since last visit" semantics, old evidence retained never rewritten.
- **SSE invalidation stream** — `GET /api/v1/events/stream`: compact
  post-commit `{seq,kind,entityType,added,changed,removed,at}` events,
  `Last-Event-ID` resume, `resync_required` when the cursor outdates the
  retained ring, 25s heartbeat.
- **Scheduler** — `NINJA_SYNC_INTERVAL_MINUTES` runs `sync_entities` on a
  timer inside `serve` (default off).

### Changed

- `src/serve.ts` now serves the static UI shell at `/` + `/assets/*`
  (unauthenticated shell; every data route still requires the bearer token,
  `cache-control: no-store` on all responses, paths confined to `public/`).
- `PERSIST_ALLOWLISTS.device` gained `device_id` (the PK — needed for
  projections; still no upstream blob).

### Verified

- 48/48 node tests, 7/7 PowerShell runner, `npm audit` clean.
- Live tenant smoke: real `us2.ninjarmm.com.db` migrated v3→v4 in place;
  WS-001 (id 123, org Solve4x) browsed + drawer detail via `/api/v1`.
- HTTP-level restart acceptance: create investigation → capture evidence →
  kill server → drift data → respawn → evidence marked
  `stale:"fields_changed"` with changes-since-last-visit.

## [1.4.0] — 2026-09-15 — "Command Center M0–M2" release

Milestone-driven work per the internal command-center work order.
Milestone packets: `docs/m0-gap-assessment.md` (internal),
[docs/operation-matrix.md](docs/operation-matrix.md),
`docs/m1-packet.md` and `docs/m2-packet.md` (internal).

### M0 — foundational safety

- **`src/connections.ts`** (new) — explicit connection identity: local UUID +
  `~/.ninjaone-mcp/connections.json` manifest replaces host-named databases as
  the tenant key. Legacy `<host>.db` files are adopted in place (registered,
  never copied/merged); ambiguous same-host claims resolve deterministically
  (oldest wins, loud stderr, no merge); `NINJA_CONNECTION_ID` selects
  explicitly and fails closed on unknown ids. *Why:* a sanitized hostname is
  not proof of tenant identity (invariant 1).
- **Schema v2 (additive)** — `connection_meta` self-describing row; a file
  stamped for connection A opened as B fails closed. `operation_journal`
  gains `connection_id`.
- **`src/org-boundary.ts`** (new) — `enforceOrganizationBoundary` moved
  verbatim out of `index.ts` for unit testing. **Known gap recorded (not
  fixed, M4):** cached resolved org can still authorize writes.
- **`main()` is now opt-in** — importing `dist/index.js` no longer spawns
  stdio; `NinjaOneMCPServer` is exported and constructible in tests.
- **Principal model** — `RuntimeSecurity.principal` + `NinjaOneAPI.getPrincipal()`:
  reporting→client_credentials, command→native_pkce; no cross-profile
  fallback (tested both directions).
- **Persistence allowlist stub** — `raw_json` columns retained but no longer
  populated (invariant 10); `PERSIST_ALLOWLISTS` exported; model-egress
  allowlist constants in `projections.ts`.

### M1 — inventory, resolver, honest change coverage

- **Scope-aware sync generations** — `syncDevices(list, {scopeOrgId})` sweeps
  only within scope; a partial scan can never false-delete out-of-scope rows
  (invariant 9). `sync_state` keys: `devices` vs `devices:org:N`.
- **Schema v3 (additive)** — `entities_device.name_norm` + index; normalized
  lookups hit the indexed column; ctor backfills existing rows.
- **Explicit change coverage** — `sync_entities` and `get_entity_changes`
  return `trackedFields` so consumers know exactly which fields diffs cover.
- **Typed saved filters** — `save_filter` validates entity type and param
  keys/kinds against `FILTER_PARAM_TYPES`; invalid filters are rejected.

### M2 — integrated local server + shared dispatch

- **`executeToolCall(name, args, sessionId)`** — the one dispatch path for
  every adapter: profile allowlist → name-or-ID resolution → confirm gate →
  org boundary → dispatch → journal. stdio handler now delegates to it.
- **`src/serve.ts` + `npm run serve`** — Fastify loopback server
  (`fastify@5.12.3`): bearer auth on all routes (token generated per install
  at `~/.ninjaone-mcp/serve.token`, 0600, or `NINJA_SERVE_TOKEN`), `POST
  /tools/:name`, `GET /health`, `GET /events`, `GET|PUT /context`. No UI —
  that's M3.
- **Session-scoped contexts** — `sessionOrgId` → `Map<sessionId, orgId>`;
  HTTP sessions keyed by `x-session-id` header (invariant 12).
- **Rate limiting** — per-process 100ms spacing gate + one bounded 429 retry
  honoring `Retry-After` (≤30s). No blanket retries.
- **Cross-process refresh lock** — `tokens.lock` mutex around command PKCE
  refresh+rotate with stale-lock recovery.
- **Scheduler + invalidations** — opt-in `NINJA_SYNC_INTERVAL_MINUTES`;
  syncs emit `invalidations` events retained in a 50-entry ring (`GET /events`).
- **DB-worker decision** — main-thread `DatabaseSync` (measured ~6ms/97
  devices); worker deferred, revisit >100k rows.

## [1.3.0] — 2026-09-15 — "Workspace" release

Goal: stop burning tokens on ID lookups and make the server a daily-driver
command center with durable local state. Full plan in `plan.md` (internal);
operator guide in `RUNBOOK.md` (internal).

### Added — local SQLite workspace (`node:sqlite`, zero new dependencies)

- **`src/storage.ts`** — DB open/migrate/WAL, per-tenant file at
  `%USERPROFILE%\.ninjaone-mcp\data\<tenant-host>.db`, `NINJA_DB_PATH`
  override, recursive secret redaction for journaled args.
  *Why built-in `node:sqlite` and not `better-sqlite3`:* no native module =
  no node-gyp/prebuilt-binary install failures for OSS distribution;
  preserves the two-runtime-dependency posture.
- **`src/entity-store.ts`** — entity tables (devices, orgs, locations,
  policies), `sync_state`, `entity_changes`, `saved_filters`,
  `operation_journal`. Field-level diffing on every sync records
  `__appeared__` / `__disappeared__` / per-field changes; missing entities
  are deleted after recording so tables always hold *current* state.
- **`src/entity-resolver.ts`** — name resolution with an exact → prefix →
  substring → normalized ladder, lazy TTL sync (devices 15 min, others 24 h;
  `NINJA_CACHE_*_TTL_MIN`), serialized concurrent syncs, org scoping.
  *Ambiguous input always fails with a candidate list — resolution never
  guesses,* because a wrong guess on a write tool is a production incident.
- **`src/projections.ts`** — slim summaries (device/org/ticket/alert/
  location) cutting list payloads from ~30 fields to ~7.

### Added — tools (12, all reporting-safe)

| Tool | Purpose |
|---|---|
| `resolve_devices` / `_organizations` / `_locations` / `_policies` | Name/ID → ID via cache; batch `names[]`; `refresh` forces sync |
| `sync_entities` | On-demand sync returning added/changed/removed counts |
| `get_entity_changes` | Field-level change history — "which devices went offline since X" |
| `get_operation_journal` | Audit of command-profile calls: tool, redacted args, resolved target IDs, dry-run flag, status |
| `save_filter` / `list_saved_filters` / `delete_saved_filter` | Named parameter presets reusable via `filter` param |
| `set_context` / `get_context` | Sticky session organization scope + cache/sync introspection |

### Changed

- **Name-or-ID parameters**: ~25 tools' `id`/`organizationId`/`deviceId`/
  `policyId`/`clientId`/`nodeId`/`deviceIds[]` params accept names.
  Implemented via `applyNameOrIdSchema` (widens JSON Schema to
  `["number","string"]` with updated descriptions) + `resolveEntityArgs` in
  the dispatch wrapper — resolution happens **before** the confirm gate and
  org boundary, and the resolved record is reused for the boundary check so
  it costs zero extra API calls. Numeric strings normalize to numbers.
- **Slim projections**: `detail:"summary"` is the default on `get_devices`,
  `get_devices_complete`, `get_organizations`, `get_tickets`,
  `get_tickets_complete`, `get_alerts`; `detail:"full"` restores raw output.
- **Session org defaulting**: when `set_context` is pinned, tools with an
  org param slot use it when the arg is omitted.
- **Dry-run labels** now reuse the resolved device record — name-based
  dry-runs cost no API fetch.
- `search_devices_by_name` searches the full cached inventory instead of
  only the first API page; falls back to a one-page API scan if the store
  is unavailable.
- Node.js requirement **20+ → 22.13+** (unflagged `node:sqlite`);
  `engines` added to package.json. README/SETUP/TOOLS/FEATURES updated.
- `ninjaone_navigate` gained the `workspace` domain.
- Tool counts: reporting **70 → 82**, command **85 → 97** (policy-dependent).

### Fixed

- `search_devices_by_name` silently missed every device past the first
  200-device API page — now resolves through the complete cached inventory.
- **Same-millisecond sync collision**: `sweepMissing` compared
  `seen_at < syncStarted` where two syncs could share a `Date.now()` mark,
  under-reporting removals. Replaced with a strictly-increasing per-store
  write mark. (Caught by a flaky regression test.)
- Saved-filter org names reaching `get_devices_complete` bypassed
  `resolveEntityArgs` (filters merge inside the handler) — now resolved
  there too.
- `readOrganizationId` didn't recognize the cache's `org_id` column —
  resolved records now feed the org boundary without a re-fetch.
- Pre-existing `npm audit` findings (`fast-uri` high, `hono` moderate —
  transitive via the MCP SDK) resolved via `npm audit fix`; audit is clean.

### Security invariants verified unchanged

- Reporting profile exposes no write tools (regression-tested).
- Command profile still fails closed on unknown tools; category gates,
  `confirm` semantics, and the org allowlist are untouched — and are
  exercised *after* name resolution, never bypassed by it.
- Journal args pass through `redactArgs` (keys matching
  token/secret/password/etc. → `[REDACTED]`); DB stores entity metadata only.
- `node:sqlite`'s `ExperimentalWarning` goes to **stderr**; the stdio
  protocol channel on stdout is unaffected.

### Verification

- `npm run verify` — build + 22 mocked regression tests + 7 PowerShell
  runner tests: **all pass**.
- `npm audit` — **0 vulnerabilities**.
- Live smoke against the real tenant (reporting profile, read-only calls):
  2 orgs + 97 devices synced in ~7 ms; `get_device {id:"chambers"}` resolved
  by name in one call; `"acme"` correctly refused as 83-way ambiguous;
  batch resolve returned 2 hits + 1 clean not-found; change feed returns
  entity names inline.

### Notes for the next maintainer

- **Multi-process caveat**: reporting and command share the DB file under
  WAL — safe for reads/writes, but two *simultaneous* same-ms syncs could
  under-detect removals (benign; next sync heals).
- Sync marks (`seen_at`) are timestamps, not logical clocks — fine at real
  sync intervals; the regression test that caught the collision is the
  guardrail.
- Locations sync per-org (N+1 at sync time, tiny); `locationId` params stay
  numeric for now — location resolution by name needs org context (v2 item).
- `df` filter syntax may support server-side name matching — unverified
  (syntax doc is an external PDF); if true, exact-name resolution could
  short-circuit the cache.
