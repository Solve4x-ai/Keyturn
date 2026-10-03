# Keyturn — Tools Reference (NinjaOne connector)

This document provides detailed information about all available MCP tools exposed by the NinjaOne connector.

> Security note: use the reporting profile for normal investigation. Tools that change NinjaOne are available only through the separately authenticated command profile and only when local policy enables them. A `confirm: true` argument is not independent physical approval.

## Confirmation Pattern

All tools that **mutate state** include a `confirm` boolean parameter (default `false`).
When `confirm` is false the tool performs a **dry-run**: it returns a human-readable
description of what would happen and instructs the caller to re-invoke with
`confirm: true` to execute.

Example dry-run response:
```
DRY RUN — no changes made.
Would reboot device id=123 (SCB-PC18) in NORMAL mode.
Re-call with confirm=true to execute.
```

Tools marked with **(confirm)** below use this pattern.

## Name-or-ID parameters

Device, organization, and policy ID parameters also accept **names** —
`{id: "WS-042"}` works anywhere `{id: 12345}` does. Names resolve server-side
through the local entity cache (exact → prefix → substring → normalized match).
Ambiguous input fails with a candidate list; it never guesses. Numeric strings
are treated as IDs. List tools accept `detail:"summary"|"full"` (summary is the
default) and several accept `filter:"<saved filter name>"`.

---

## Phase 1 — Read-only operations

### Workspace (local state, resolution, history)

These tools operate on the local per-tenant SQLite workspace
(`%USERPROFILE%\.ninjaone-mcp\data\<tenant>.db`) — entity metadata only, no credentials.

| Tool | Description | Parameters |
|------|-------------|------------|
| `resolve_devices` | Resolve device names/IDs to IDs; batch via `names[]` | `name?`, `names?`, `organization?`, `refresh?`, `filter?` |
| `resolve_organizations` | Resolve org names/IDs to IDs | `name?`, `names?`, `refresh?` |
| `resolve_locations` | Resolve location names/IDs to IDs | `name?`, `names?`, `organization?`, `refresh?` |
| `resolve_policies` | Resolve policy names/IDs to IDs | `name?`, `names?`, `refresh?` |
| `sync_entities` | Sync entities into the local cache now; reports adds/changes/removals | `entities?` |
| `get_entity_changes` | Field-level change history (offline flips, renames, `__appeared__`, `__disappeared__`) | `entityType?`, `entityId?`, `field?`, `since?`, `limit?` |
| `get_operation_journal` | Local journal of command-profile calls (dry-runs + executions), args redacted | `since?`, `tool?`, `limit?` |
| `save_filter` | Save a named parameter preset | `name`, `entityType`, `params` |
| `list_saved_filters` | List saved presets | `entityType?` |
| `delete_saved_filter` | Delete a preset | `name` |
| `set_context` | Pin a session organization scope (name or ID); `null` clears | `organization` |
| `get_context` | Show session scope, cache counts, and sync state | — |

### Discovery and navigation

| Tool | Description | Parameters |
|------|-------------|------------|
| `find_endpoint` | Search the pinned NinjaOne OpenAPI catalog; never executes requests | `query?`, `category?`, `method?`, `limit?` |
| `describe_endpoint` | Show parameters, schemas, and responses for an exact catalog endpoint | `endpoint` |
| `ninjaone_navigate` | List domains or currently exposed tools in one domain | `domain?` |

### Device Management

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_devices` | List devices with optional filtering | `df?`, `pageSize?`, `after?` |
| `get_devices_complete` | Auto-page devices with explicit completeness metadata and optional organization path scoping | `organizationId?`, `df?`, `pageSize?`, `maxPages?`, `maxItems?` |
| `get_device` | Get device details by ID | `id` |
| `get_device_software` | Get installed software for a device | `id` |
| `get_device_activities` | Get activity history for a device | `id`, `pageSize?` |
| `get_device_dashboard_url` | Get dashboard URL for a device | `id` |
| `search_devices_by_name` | Search devices by name (client-side) | `name`, `limit?` |
| `find_windows11_devices` | Find Windows 11 devices | `limit?` |

### Organization Management

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_organizations` | List all organizations | `pageSize?`, `after?` |
| `get_organization` | Get organization details | `id` |
| `get_organization_locations` | Get locations for an organization | `id` |
| `get_organization_policies` | Get policies for an organization | `id` |
| `create_organization` | Create a new organization | `name`, `description?`, `nodeApprovalMode?`, `tags?` |
| `update_organization` | Update an organization | `id`, `name?`, `description?`, `tags?` |
| `generate_organization_installer` | Generate device installer | `installerType`, `organizationId?`, `locationId?` |

### Locations

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_location` | Create a location | `organizationId`, `name`, `address?`, `description?` |
| `update_location` | Update a location | `organizationId`, `locationId`, `name?`, `address?`, `description?` |

### Alerts

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_alerts` | Get system alerts | `since?` |
| `get_alert` | Get alert by UID | `uid` |
| `get_device_alerts` | Get alerts for a device | `id`, `lang?` |

### Users & Roles

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_end_users` | List end users | — |
| `get_end_user` | Get end user by ID | `id` |
| `create_end_user` | Create an end user | `firstName`, `lastName`, `email`, `phone?`, `organizationId?`, `fullPortalAccess?`, `sendInvitation?` |
| `update_end_user` | Update an end user | `id`, `firstName?`, `lastName?`, `email?`, `phone?` |
| `delete_end_user` | Delete an end user | `id` |
| `get_technicians` | List technicians | — |
| `get_technician` | Get technician by ID | `id` |
| `add_role_members` | Add users to a role | `roleId`, `userIds` |
| `remove_role_members` | Remove users from a role | `roleId`, `userIds` |

### Contacts

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_contacts` | List contacts | — |
| `get_contact` | Get contact by ID | `id` |
| `create_contact` | Create a contact | `organizationId`, `firstName`, `lastName`, `email`, `phone?`, `jobTitle?` |
| `update_contact` | Update a contact | `id`, `firstName?`, `lastName?`, `email?`, `phone?`, `jobTitle?` |
| `delete_contact` | Delete a contact | `id` |

### Device Control

| Tool | Description | Parameters |
|------|-------------|------------|
| `control_windows_service` | Control a Windows service | `id`, `serviceId`, `action` (START/STOP/RESTART) |
| `configure_windows_service` | Configure service startup type | `id`, `serviceId`, `startupType` |

### Patch Scanning

| Tool | Description | Parameters |
|------|-------------|------------|
| `scan_device_os_patches` | Scan for OS patches | `id` |
| `scan_device_software_patches` | Scan for software patches | `id` |

### System Information Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `query_antivirus_status` | Antivirus status across devices | `df?`, `cursor?`, `pageSize?` |
| `query_antivirus_threats` | Antivirus threat detections | `df?`, `cursor?`, `pageSize?` |
| `query_computer_systems` | Computer system information | `df?`, `cursor?`, `pageSize?` |
| `query_device_health` | Device health status | `df?`, `cursor?`, `pageSize?` |
| `query_operating_systems` | Operating system info | `df?`, `cursor?`, `pageSize?` |
| `query_logged_on_users` | Currently logged-on users | `df?`, `cursor?`, `pageSize?` |

### Hardware Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `query_processors` | Processor information | `df?`, `cursor?`, `pageSize?` |
| `query_disks` | Disk drive information | `df?`, `cursor?`, `pageSize?` |
| `query_volumes` | Disk volume information | `df?`, `cursor?`, `pageSize?` |
| `query_network_interfaces` | Network interfaces | `df?`, `cursor?`, `pageSize?` |
| `query_raid_controllers` | RAID controllers | `df?`, `cursor?`, `pageSize?` |
| `query_raid_drives` | RAID drives | `df?`, `cursor?`, `pageSize?` |

### Software & Patch Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `query_software` | Installed software | `df?`, `cursor?`, `pageSize?` |
| `query_os_patches` | OS patches | `df?`, `cursor?`, `pageSize?` |
| `query_software_patches` | Software patches | `df?`, `cursor?`, `pageSize?` |
| `query_os_patch_installs` | OS patch install history | `df?`, `cursor?`, `pageSize?` |
| `query_software_patch_installs` | Software patch install history | `df?`, `cursor?`, `pageSize?` |
| `query_windows_services` | Windows services | `df?`, `cursor?`, `pageSize?` |

### Custom Fields & Policy Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `query_custom_fields` | Custom field values | `df?`, `cursor?`, `pageSize?` |
| `query_custom_fields_detailed` | Detailed custom fields | `df?`, `cursor?`, `pageSize?` |
| `query_scoped_custom_fields` | Scoped custom fields | `df?`, `cursor?`, `pageSize?` |
| `query_scoped_custom_fields_detailed` | Detailed scoped custom fields | `df?`, `cursor?`, `pageSize?` |
| `query_policy_overrides` | Policy overrides | `df?`, `cursor?`, `pageSize?` |
| `query_backup_usage` | Backup usage statistics | `df?`, `cursor?`, `pageSize?` |
| `get_system_custom_fields` | Global (system-level) custom field values | — |

### Knowledge Base

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_kb_articles` | List/search knowledge base articles — client (`organization`, default) or MSP-wide (`global`) | `scope?`, `organizationId?`, `articleName?`, `includeArchived?` |
| `get_kb_article` | Read one article by id; content over 60k chars is truncated | `articleId`, `global?` |

### Region Utilities

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_regions` | List supported regions and base URLs | — |
| `set_region` | Set region or base URL | `region?`, `baseUrl?` |

---

## Phase 2 — Write operations with confirmation guardrails

### Alert Management

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `reset_alert` | **(confirm)** | Reset/acknowledge an alert | `uid`, `confirm?` |

### Device Management

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `reboot_device` | **(confirm)** | Reboot a device | `id`, `mode?` (NORMAL/FORCED), `confirm?` |
| `set_device_maintenance` | **(confirm)** | Set maintenance mode | `id`, `mode` (ON/OFF), `duration?`, `confirm?` |
| `update_device` | **(confirm)** | Update display name or user data | `id`, `displayName?`, `userData?`, `confirm?` |

### Patch Application

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `apply_device_os_patches` | **(confirm)** | Apply OS patches | `id`, `patches`, `confirm?` |
| `apply_device_software_patches` | **(confirm)** | Apply software patches | `id`, `patches`, `confirm?` |

### Ticketing (full CRUD)

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `get_ticket_boards` | — | List all ticket boards | — |
| `get_tickets` | — | List tickets from a board | `boardId`, `pageSize?`, `after?` |
| `get_tickets_complete` | — | Scan every page of an explicit board, then filter locally | `boardId`, `status?`, `organizationId?`, `deviceId?`, `pageSize?`, `maxPages?`, `maxItems?` |
| `get_ticket` | — | Get ticket detail | `ticketId` |
| `get_ticket_log` | — | Get ticket activity log | `ticketId` |
| `create_ticket` | **(confirm)** | Create a new ticket | `boardId`, `subject`, `description?`, `status?`, `priority?`, `severity?`, `deviceId?`, `assignedAppUserId?`, `confirm?` |
| `update_ticket` | **(confirm)** | Update a ticket | `ticketId`, `subject?`, `description?`, `status?`, `priority?`, `severity?`, `assignedAppUserId?`, `confirm?` |
| `add_ticket_comment` | **(confirm)** | Add comment to a ticket | `ticketId`, `comment`, `appUserId?`, `confirm?` |

### Custom Field Writes

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `update_device_custom_fields` | **(confirm)** | Write custom fields on a device | `deviceId`, `fields`, `confirm?` |
| `update_org_custom_fields` | **(confirm)** | Write custom fields on an org | `orgId`, `fields`, `confirm?` |

---

## Phase 3 — Webhooks & event-driven integration

### Webhook Configuration

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `get_webhook_config` | — | Show current webhook config | — |
| `set_webhook_config` | **(confirm)** | Configure a webhook endpoint | `webhookUrl`, `secret?`, `activities?`, `confirm?` |
| `delete_webhook_config` | **(confirm)** | Remove webhook config | `confirm?` |

> Note: GET /v2/webhook is not supported by the NinjaOne API via client credentials. `get_webhook_config` returns an informational message.

### Polling Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_stale_devices` | Devices not checked in for N hours | `sinceHours?` (default 48) |
| `get_devices_pending_patches` | Devices with pending/failed patches | `status?` (PENDING/FAILED) |

### Activity Log

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_activities` | System-wide activity log | `pageSize?`, `after?`, `type?`, `deviceId?`, `userId?`, `status?` |
| `export_readonly_audit` | Save an approved complete TXT/JSON audit artifact | `template`, target IDs, optional time range/search terms/format/pagination limits |

Approved audit templates:

- `device_activity`
- `organization_activity`
- `device_inventory`
- `patch_reboot`
- `ticket_device`

Audit files are restricted to the configured export directory and include
generation metadata, pagination completeness, query boundaries, matches, and a
SHA-256 hash. Credential- and token-shaped fields are redacted.

---

## Phase 4 — Script execution & policy management

### Script/Automation Execution

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `list_automations` | — | List saved automation scripts | `lang?` |
| `get_device_scripting_options` | — | List scripts/actions available for a device | `deviceId`, `lang?` |
| `run_device_script` | **(confirm)** | Run a script on a device | `deviceId`, `scriptId`, `runAs?`, `parameters?`, `timeout?`, `confirm?` |
| `run_device_powershell` | **(confirm)** | Run an approved PowerShell command through the configured saved runner | `deviceId`, `command`, `timeoutSeconds?`, `confirm?` |
| `get_powershell_result` | — | Retrieve a PowerShell runner result by run ID | `deviceId`, `runId` |
| `get_script_result` | — | Poll script run result | `deviceId`, `activityId` |

> Note: Script execution requires authorization code flow in NinjaOne. The public API can list and run saved scripts, but the pinned API specification does not expose creation or upload of script definitions.

### Policy Management

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `get_policies` | — | List all policies | `templateOnly?` |
| `get_policy` | — | Get policy detail | `policyId` |
| `assign_device_policy` | **(confirm)** | Assign policy to a device | `deviceId`, `policyId`, `confirm?` |
| `get_device_policy_overrides` | — | Get policy overrides for a device | `id` |
| `reset_device_policy_overrides` | **(confirm)** | Reset all policy overrides | `id`, `confirm?` |

### Device Approval

| Tool | Confirm | Description | Parameters |
|------|---------|-------------|------------|
| `get_pending_devices` | — | List devices awaiting approval | — |
| `approve_devices` | **(confirm)** | Approve or reject devices | `mode` (APPROVE/REJECT), `deviceIds`, `confirm?` |

## Phase 5 — Operation contract (M5A, harness-first)

Durable plan → trusted approval → dispatch → receipt. The MCP client proposes;
the browser UI approves. These tools return a stable envelope:
`{schemaVersion:1, connectionId, ok, code?, summary?, nextAction?, ...}`.

| Tool | Profile | Description | Parameters |
|------|---------|-------------|------------|
| `list_runbooks` | both | Discover reviewed runbooks (compact summaries) | `category?`, `query?` |
| `get_runbook` | both | Full runbook detail: param schema, applicability, limits, digest | `id`, `version?` |
| `select_devices` | both | Materialize a FROZEN device set → selection handle (count + preview; ids stay server-side) | `orgId?`, `offline?`, `q?`, `deviceIds?` |
| `get_selection` | both | Selection detail: count, member preview, exclusions+reasons, criteria, expiry | `selectionId` |
| `list_selections` | both | Recent frozen selections for cross-session resume | `limit?` |
| `create_plan` | command | Immutable plan — `deviceId` (single) or `selectionId`+`canarySize?` (batch); `runbookId`+`params` or custom `command`. Executes nothing. | `deviceId?`, `selectionId?`, `canarySize?`, `runbookId?`, `runbookVersion?`, `params?`, `command?`, `timeoutSeconds?` |
| `propose_health_status` | command + `healthWritebackEnabled` | Plan to write one NinjaOne Health Status custom field (HEALTHY / NEEDS_ATTENTION / UNHEALTHY / UNKNOWN + description) on a device or org; read back after approval → `verified` or `unknown`. Field must exist in NinjaOne. Executes nothing. | `deviceId?` \| `organizationId?`, `field`, `status`, `description?` |
| `dispatch_plan` | command | Dispatch an already-approved plan (approval comes from the UI) | `planId` |
| `get_operation` | both | Operation status + receipt summary; `detail:"full"` adds bounded stdout/stderr; batch ops include target-count rollup | `operationId`, `detail?` |
| `list_operations` | both | Recent operations, bounded rows + cursor for cross-session resume | `status?`, `since?`, `limit?`, `cursor?` |
| `cancel_operation` | command | Cancel undispatched work; accepted runs flagged + disclosed honestly; batch: queued/held targets cancel outright | `operationId` |
| `list_operation_targets` | both | Per-target batch results: status/device/error per target, seq-cursor paging | `operationId`, `status?`, `limit?`, `cursor?` |
| `generate_report` | both | Windowed management report. `reportType:"operations"` (default): work performed (verified vs attempted), observed software removals, coverage gaps. `reportType:"org"`: adds infrastructure entity/coverage state and review outcomes (decisions by disposition, open questions, reassessments, suppressions) | `reportType?` (`operations`\|`org`), `sinceDays?` (1-400, default 91=quarter), `since?`, `until?`, `orgId?`, `format?` (`json`\|`markdown`) |
| `get_infrastructure_summary` | both | Org infrastructure knowns: per-category observed/conflicting counts + per-section coverage/freshness. Local projection only — never executes on endpoints. | `orgId` |
| `list_infrastructure_entities` | both | List known infra entities (DCs, FSMO roles, DNS zones/servers, DHCP servers/scopes/reservations/leases, GPOs) with status, attrs, collection age. `asOf` replays latest evidence collected at-or-before a date — response discloses `evidenceHorizon`; absent = not-yet-collected, not provably absent | `orgId`, `category?`, `status?`, `q?`, `asOf?`, `limit?`, `cursor?` |
| `get_infrastructure_entity` | both | Entity detail: current attrs, observation history, relationships, evidence (producing operations) | `orgId`, `entityId` |
| `get_infrastructure_coverage` | both | Per-section collection coverage: complete/partial/failed/unverified/not-applicable + last collected, per source | `orgId` |
| `get_endpoint_infrastructure` | both | What infra an endpoint was observed using (DNS/DHCP/domain context) vs what exists | `deviceId` |
| `list_infrastructure_changes` | both | Recent observations/change events across infra entities in a window | `orgId`, `sinceDays?`, `category?`, `limit?` |

Stable error codes: `plan_not_found`, `stale_plan`, `approval_required`,
`approval_expired`, `approval_mismatch`, `approval_consumed`, `forbidden`,
`target_offline`, `target_not_found`, `invalid_params`, `runbook_not_found`,
`runbook_revoked`, `operation_not_found`, `dispatch_failed`,
`upstream_cancel_unsupported`, `operation_not_supported`,
`selection_not_found`, `selection_expired`, `empty_selection`,
`selection_too_large`, `cross_org_selection`, `nothing_held`.

- Params are bound as **data**: validated server-side, serialized to JSON,
  base64-encoded into `$__p` — never concatenated into executable text.
- `create_plan` returns `reviewUrl` — the plan-review page in the local UI
  where a human approves. A plan changes nothing until approved + dispatched.
- `dispatch_plan` is idempotent per plan: re-dispatching returns the existing
  operation (dedupe by plan hash), never a second upstream submission.
- Reconciliation: the long-lived `serve` process sweeps accepted operations
  every ~45s (`NINJA_RECONCILE_TICK_MS`, `0` disables); `get_operation` also
  reconciles on read. `accepted` means submitted, not finished — a result is
  only final at `verified`/`failed`.

### Batch operations (M5B)

- `select_devices` freezes a set: the member ids stored at creation ARE the
  truth. Re-evaluating a filter creates a NEW selection; an approved plan's
  membership never expands. Selections expire after 1 h — an expired handle
  can't seed a plan (re-select), but plans keep their embedded members.
- One organization per selection/plan — cross-org work is separate scoped
  plans. Exclusions (unknown ids, out-of-allowlist orgs) are recorded with
  reasons, never silently dropped or substituted.
- `canarySize` on a batch plan dispatches the first N targets and holds the
  rest. All canaries verified → the remainder auto-releases (the gate is
  disclosed on the approval card). Any failed/unknown canary → parent
  `canary_paused`; releasing the remainder is a trusted UI action.
- Parent status is a rollup that conserves the frozen count: `verified`
  only when every target verified; mixed terminal outcomes → `partial`;
  per-target truth via `list_operation_targets`. Target statuses: `held`,
  `queued`, `submitting`, `accepted`, `cancel_requested`, `verified`,
  `failed`, `skipped`, `canceled`, `unknown`.
- Dispatch is durable, not in-memory: `queued` targets survive restart and
  drain via the sweep (`NINJA_BATCH_TICK_MAX` per pass, default 5, serial
  submission). An atomic queued→submitting claim prevents duplicate
  dispatch; a `submitting` marker older than 5 min becomes `unknown`
  (crash window — upstream acceptance undetermined, needs review before
  any retry). Exactly-once upstream execution is NOT claimed.
- Per-target preflight runs at dispatch time: fresh upstream identity,
  allowlist org, plan-org match, online state — failures become `skipped`
  with the reason recorded on the target row.

### Review Center (REVIEW-1, local-state only)

Durable review records over infrastructure findings — org-scoped, immutable
revisions, optimistic concurrency. **Zero endpoint reach**: the service holds
no API handle and can never dispatch. Reads are on both profiles; writes need
the command profile + `reviewWritesEnabled` policy flag.

| Tool | Profile | Description | Parameters |
|------|---------|-------------|------------|
| `get_review_digest` | both | Counts by state/assessment/workflow + oldest-open age | `org` |
| `list_review_items` | both | Items filtered by state/assessment/disposition/type/status/q | `org`, filters…, `limit?`, `cursor?` |
| `get_review_item` | both | Full item: current revision, immutable history, evidence links, questions/answers, decisions, op links | `org`, `itemId` |
| `list_review_questions` | both | Open/answered questions across the org | `org`, `state?` |
| `list_org_annotations` | both | Operator context annotations (lifecycle, env quirks) | `org`, `entityId?` |
| `propose_review_item` | command | Create/refresh a proposed item — dedupe by fingerprint | `org`, `type`, `title`, `summary?`, `severity?`, `confidence?`, … |
| `revise_review_item` | command | New revision (requires `expectedRevision`) | `org`, `itemId`, `expectedRevision`, fields… |
| `ask_review_question` | command | Attach an open question; item → `awaiting_context` | `org`, `itemId`, `question` |
| `answer_review_question` | command | Answer with provenance — `reported` is context, never a decision | `org`, `questionId`, `answer`, `provenance` |
| `add_org_annotation` | command | Org-scoped annotation linked to entities/items | `org`, `kind`, `text`, `entityIds?`, `itemIds?` |
| `record_review_decision` | command | Decide — `direct`/`delegated` provenance only; rationale required for dismiss/accept/unverified-close; evidence basis for verified_resolved | `org`, `itemId`, `assessment?`, `disposition`, `rationale?`, `provenance` |
| `suppress_review` | command | Suppress a fingerprint (with reason + optional expiry) | `org`, `fingerprint`, `reason`, `expiresAt?` |
| `link_review_operation` | command | Link an existing operation/plan as context — never approves or dispatches | `org`, `itemId`, `operationId?`, `planId?` |

Stable codes: `review_item_not_found`,
`revision_conflict`, `provenance_required`, `rationale_required`,
`evidence_required`, `suppressed`, `cross_org`, `decision_superseded`.

---

## Device Filter Syntax

Use NinjaONE's filter syntax for the `df` parameter:

```
org = 1                           # Devices in organization 1
status = 'ONLINE'                 # Online devices only
name LIKE '%server%'              # Devices with 'server' in name
org = 1 AND status = 'ONLINE'     # Combined filter
lastSeen > '2024-01-01'          # Devices seen after date
os.name = 'Windows 10'           # Windows 10 devices
```

## Response Format

All tools return MCP-standard responses:
```json
{
  "content": [{ "type": "text", "text": "JSON formatted response data" }]
}
```

## API Limitations

- **Ticketing creation** requires authorization code flow (user context), not client credentials
- **Script execution** requires authorization code flow
- **Webhook GET** is not available via the API; use `set_webhook_config` / `delete_webhook_config`
- **Organization/location deletion** is only available via the NinjaOne dashboard
- **End user phone update** is read-only after creation

## Regression verification

`npm run verify` compiles the server and runs mocked safety tests. The suite does
not contact NinjaOne. It verifies profile isolation, fail-closed unknown tools,
disabled high-risk actions, confirmation requirements, discovery-only behavior,
navigator filtering, cursor-loop handling, complete organization-scoped device
pagination, complete board scans, and secret-safe exports.
