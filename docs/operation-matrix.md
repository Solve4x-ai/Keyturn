# Operation Matrix — NinjaOne MCP (M0 starter)

**Source:** `src/index.ts` dispatch cases + `src/ninja-api.ts` `makeRequest` paths (v1.3.0). Permission column = profile/policy gate, not upstream OAuth scope (upstream scope: monitoring for all reads; management assumed for writes — unverified per-endpoint). "—" = not applicable. `unverified` = not confirmed against the live tenant or the pinned spec.

**Cross-cutting facts (verified in source):**
- Rate-limit handling: none — no 429 retry/backoff in `makeRequest` (single retry only on 401 token refresh).
- Cancellation semantics: none — no upstream job-cancel calls exist; async ops (scripts, scans) return after HTTP acceptance only.
- Dry-run meaning: local only — server returns `DRY RUN` text when `confirm` is absent; no upstream dry-run API is used.
- Completion signal: HTTP response only for most writes; script/PowerShell ops poll `/v2/device/{id}/activities`.
- Retry class: idempotent GETs safe to retry; writes not auto-retried (good).

## Meta / workspace (local — no upstream call)

| Canonical operation | Legacy aliases | Upstream path | Permission | Target | OS | Pagination | Response shape | Dry-run | Retry | Completion | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| get_auth_profile | — | none (local config) | both | server | — | — | profile, scopes, baseUrl | — | — | immediate | code-verified |
| find_endpoint / describe_endpoint | — | none (spec catalog) | both | catalog | — | limit | endpoint cards | — | — | immediate | unit-tested |
| ninjaone_navigate | — | none | both | catalog | — | — | domain tool list | — | — | immediate | unit-tested |
| list_regions | — | none | both | server | — | — | region list | — | — | immediate | code-verified |
| set_region | — | none (mutates baseUrl) | both | server | — | — | new baseUrl | — | — | immediate | code-verified; **risk: process-global** |
| resolve_devices/organizations/locations/policies | — | GET list endpoints on lazy sync | both | entity | all | full sync | `{resolved, notFound, ambiguous}` | — | — | immediate | unit+live |
| sync_entities | — | GET /v2/devices, /v2/organizations, /v2/policies, /v2/organization/{id}/locations | both | tenant | — | full scan | SyncReport | — | idempotent | sync counts | unit+live |
| get_entity_changes | — | none (SQLite) | both | entity | — | limit≤2000 | change rows | — | — | immediate | unit-tested |
| get_operation_journal | — | none (SQLite) | both | journal | — | limit≤1000 | journal rows | — | — | immediate | unit-tested |
| save_filter / list_saved_filters / delete_saved_filter | — | none (SQLite) | both | filter | — | — | filter rows | — | — | immediate | unit-tested |
| set_context / get_context | — | none (session field) | both | session | — | — | org scope | — | — | immediate | code-verified |

## Devices — reads

| Canonical operation | Tool | Upstream path | Permission | Pagination | Response shape | Completion | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List devices | get_devices | GET /v2/devices?df&pageSize&after | reporting | cursor `after` | array (summary default) | HTTP | live-verified |
| List devices complete | get_devices_complete | GET /v2/organization/{orgId}/devices (all pages) | reporting | full scan w/ cursor-loop detect | `{complete, scanned, items}` | scan end | unit-tested |
| Get device | get_device | GET /v2/device/{id} | reporting | — | device object | HTTP | live-verified |
| Device dashboard URL | get_device_dashboard_url | GET /v2/device/{id}/dashboard-url | reporting | — | `{url}` | HTTP | code-verified |
| Search devices by name | search_devices_by_name | local resolver (sync'd cache) | reporting | limit | summary list | immediate | unit+live |
| Find Windows 11 devices | find_windows11_devices | GET /v2/queries/operating-systems scan | reporting | full scan | summary list | scan end | code-verified |
| Device activities | get_device_activities | GET /v2/device/{id}/activities?pageSize&olderThan | reporting | `olderThan` cursor | activity array | HTTP | code-verified |
| Device software | get_device_software | GET /v2/device/{id}/software | reporting | upstream-defined | array | HTTP | code-verified |
| Device alerts | get_device_alerts | GET /v2/device/{id}/alerts?lang | reporting | upstream-defined | array | HTTP | code-verified |
| Stale devices | get_stale_devices | GET /v2/devices + client-side filter | reporting | full scan | device list | scan end | code-verified; 500-fallback noted in code |
| Devices pending patches | get_devices_pending_patches | /v2/queries/* scan (client filter) | reporting | full scan | device list | scan end | unverified (composite) |
| Pending (undiscovered) devices | get_pending_devices | composite via /v2/devices | reporting | upstream-defined | array | HTTP | unverified (delegated) |

## Devices — writes (command profile, policy + confirm + org boundary)

| Canonical operation | Tool | Upstream path | Policy gate | Dry-run meaning | Retry class | Completion signal | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reboot device | reboot_device | POST /v2/device/{id}/reboot/{mode} | deviceManagement | local dry-run | not retried | HTTP accept (not verified effect) | code-verified |
| Set maintenance | set_device_maintenance | PUT / DELETE /v2/device/{id}/maintenance | deviceManagement | local | not retried | HTTP accept | code-verified |
| Approve devices | approve_devices | POST /v2/devices/approval/{mode} | deviceManagement | local | not retried | HTTP accept | code-verified |
| Update device | update_device | PATCH /v2/device/{id} | deviceManagement | local | not retried | HTTP accept | code-verified |
| Assign policy | assign_device_policy | PATCH /v2/device/{id} {policyId} | deviceManagement | local | not retried | HTTP accept; 404 annotated | code-verified (no dedicated endpoint — documented) |
| Scan/apply OS patches | scan_device_os_patches, apply_device_os_patches | POST /v2/device/{id}/patch/os/{scan,apply} | deviceManagement | local | not retried | HTTP accept | code-verified |
| Scan/apply SW patches | scan/apply_device_software_patches | POST /v2/device/{id}/patch/software/{scan,apply} | deviceManagement | local | not retried | HTTP accept | code-verified |
| Control Windows service | control_windows_service | POST /v2/device/{id}/windows-service/{serviceId}/control | deviceManagement | local | not retried | HTTP accept | code-verified; **serviceId numeric — name resolution deferred** |
| Configure Windows service | configure_windows_service | POST /v2/device/{id}/windows-service/{serviceId}/configure | deviceManagement | local | not retried | HTTP accept | code-verified |
| Update device custom fields | update_device_custom_fields | PATCH /v2/device/{id}/custom-fields | deviceManagement | local | not retried | HTTP accept | code-verified |
| Run script | run_device_script | POST /v2/device/{id}/script/run | deviceScriptsEnabled (default OFF) | local | not retried | activityId → poll activities | code-verified |
| Run PowerShell | run_device_powershell | POST /v2/device/{id}/script/run (script id from policy) | deviceScriptsEnabled + powershellRunnerScriptId | local | not retried | poll /v2/device/{id}/activities | code-verified |
| Get script result | get_script_result | GET /v2/device/{id}/activities (filter) | command read | paged | activity entries | immediate | code-verified (no dedicated endpoint — documented) |
| Get PowerShell result | get_powershell_result | GET /v2/device/{id}/activities | command read | paged | activity entries | immediate | code-verified |

## Organizations / locations / contacts / users

| Canonical operation | Tool | Upstream path | Permission | Pagination | Completion | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| List/get orgs | get_organizations, get_organization | GET /v2/organizations, /v2/organization/{id} | reporting | `after` cursor | HTTP | live-verified |
| Org locations | get_organization_locations | GET /v2/organization/{id}/locations | reporting | upstream | HTTP | code-verified |
| Org policies | get_organization_policies | composite: /v2/policies + device overrides | reporting | — | HTTP | code-verified (documented: no direct GET) |
| Org devices | — (internal) | GET /v2/organization/{id}/devices | reporting | `after` | scan | unit-tested via complete-queries |
| Generate installer | generate_organization_installer | POST /v2/organization/generate-installer | command + org boundary | — | HTTP accept | code-verified |
| Create/update org | create_organization, update_organization | POST /v2/organizations, PATCH /v2/organization/{id} | adminWrites (default OFF) | — | HTTP accept | code-verified |
| Create/update location | create_location, update_location | POST/PATCH /v2/organization/{orgId}/locations[/{id}] | adminWrites | — | HTTP accept | code-verified |
| Contacts CRUD | get_contacts, get_contact, create/update/delete_contact | GET/POST/PATCH/DELETE /v2/contacts, /v2/contact/{id} | reads: reporting; writes: adminWrites | upstream | HTTP | code-verified |
| End users CRUD | get_end_users, get_end_user, create/update/delete_end_user | /v2/users* (buildUserCollectionPath) | reads reporting; writes adminWrites | upstream | HTTP | code-verified; exact path unverified |
| Technicians | get_technicians, get_technician | /v2/users* technician paths | reporting | upstream | HTTP | code-verified |
| Role members | add_role_members, remove_role_members | PATCH /v2/user/role/{id}/{add,remove}-members | adminWrites | — | HTTP accept | code-verified |
| Org custom fields | update_org_custom_fields | PATCH /v2/organization/{id}/custom-fields | adminWrites | — | HTTP accept | code-verified |

## Policies / alerts

| Canonical operation | Tool | Upstream path | Permission | Completion | Verification |
| --- | --- | --- | --- | --- | --- |
| List policies | get_policies | GET /v2/policies?templateOnly | reporting | HTTP | code-verified |
| Get policy | get_policy | GET /v2/policies + client filter | reporting | HTTP | code-verified (no single-GET — documented) |
| Device policy overrides | get_device_policy_overrides, reset_device_policy_overrides | GET/DELETE /v2/device/{id}/policy/overrides | read reporting / reset deviceManagement | HTTP | code-verified |
| List/get alerts | get_alerts, get_alert | GET /v2/alerts?df&sourceType&since; get_alert = list+filter | reporting | upstream | code-verified (no single-GET — documented) |
| Reset alert | reset_alert | DELETE /v2/alert/{uid} (org check via fresh alert+device) | deviceManagement | HTTP accept | code-verified |

## Inventory queries (/v2/queries/* — all reporting, cursor-paged)

All share: `GET /v2/queries/<ep>?df&cursor&pageSize`, summary-shaped rows, HTTP completion, code-verified.

antivirus-status, antivirus-threats, computer-systems, device-health, operating-systems, logged-on-users, processors, disks, volumes, network-interfaces, raid-controllers, raid-drives, software, os-patches, software-patches, os-patch-installs, software-patch-installs, windows-services, custom-fields, custom-fields-detailed, scoped-custom-fields, scoped-custom-fields-detailed, policy-overrides, backup/usage — tools: `query_<snake>` each.

| Canonical operation | Tool | Upstream path | Pagination | Verification |
| --- | --- | --- | --- | --- |
| Search software/patches/services | search_software, search_os_patches, search_windows_services | /v2/queries/{software,os-patches,windows-services} via queryAllFiltered | full scan + client filter | unit-adjacent (queryAllFiltered) |

## Tickets

| Canonical operation | Tool | Upstream path | Permission | Pagination | Dry-run | Completion | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List boards | get_ticket_boards | GET /v2/ticketing/trigger/boards | reporting | — | — | HTTP | code-verified |
| List statuses | get_ticket_statuses | GET /v2/ticketing/statuses | reporting | — | — | HTTP | code-verified |
| List tickets | get_tickets | POST /v2/ticketing/trigger/board/{boardId}/run | reporting | cursor | — | HTTP | code-verified |
| List tickets complete | get_tickets_complete | same, all pages via getTicketsComplete | reporting | full scan | — | scan end | unit-tested |
| Get ticket / log | get_ticket, get_ticket_log | GET /v2/ticketing/ticket/{id}[/log-entry] | reporting | — | — | HTTP | code-verified |
| Create ticket | create_ticket | POST /v2/ticketing/ticket | ticketWrites + clientId boundary | — | local | HTTP accept | code-verified |
| Update ticket | update_ticket | PUT /v2/ticketing/ticket/{id} | ticketWrites + fresh-ticket boundary | — | local | HTTP accept | code-verified |
| Add comment | add_ticket_comment | POST /v2/ticketing/ticket/{id}/comment (multipart `comment` part) | ticketWrites | — | local | HTTP accept | code-verified |

## Webhooks / activities / automations / misc

| Canonical operation | Tool | Upstream path | Permission | Completion | Verification |
| --- | --- | --- | --- | --- | --- |
| Webhook config | get/set/delete_webhook_config | GET/PUT/DELETE /v2/webhook | read reporting; writes adminWrites | HTTP | code-verified |
| Activities | get_activities | GET /v2/activities?… | reporting | upstream paged | code-verified |
| Automation scripts | list_automations | GET /v2/automation/scripts | reporting | upstream | code-verified |
| Scripting options | get_device_scripting_options | GET /v2/device/{id}/scripting/options | command only | HTTP | unit-tested (profile-gated) |
| Read-only audit export | export_readonly_audit | composite reads → local file in NINJA_EXPORT_DIR | reporting | file written | unit-tested (redaction+path) |

## Known upstream gaps (documented in source, not invented)

- No `GET /v2/organization/{id}/policies` — composite fallback used.
- No `GET /v2/alert/{uid}` (405) — list+filter fallback.
- No dedicated script-result endpoint — activity polling.
- No dedicated policy-assign endpoint — `PATCH /v2/device/{id}` with `policyId`.
- Patch approve/reject — dashboard-only per source comment.
- A native-console feature is not proof of public API support (work-order §4).

## Unverified capabilities (open API questions — do not implement on faith)

`df` filter grammar coverage (does `systemName` filter server-side?), rate-limit headers/429 semantics, webhook payload availability on this tenant tier, end-user path shape (`buildUserCollectionPath`), location-id global uniqueness, ticket `clientId` mutability, approval-mode values for `/v2/devices/approval/{mode}`.
