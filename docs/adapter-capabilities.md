# M4.5 Adapter Capabilities — validated against live tenant

Validation target: `WS-001` (device id 123), reporting profile, read-only.
Date: 2026-09-16 (session timestamps are epoch-ms unless noted).

Per-resource: client method, real response shape, pagination, field mappings,
completeness rules, and known limitations. Fields not listed here are not
persisted — allowlists in `src/snapshots.ts` are the contract.

## identity — `getDevice(id)`

- Shape: scalar object. Persisted keys: `created, displayName, dnsName,
  lastContact, locationId, nodeClass, offline, organizationId, os, systemName`.
- `source_observed_at` = `lastContact` (epoch-s → ms). Honest: this is device
  heartbeat, not per-resource observation time.
- Completeness: `complete` (single fetch, no pagination).

## network — `queryNetworkInterfaces('id = {device}')` + device `ipAddresses`/`publicIP`

- Shape: `{ interfaces[], ipAddresses[], publicIP }` (merged).
- Interface item keys (real): `interfaceName, adapterName, macAddress,
  ipAddress, subnetMask, defaultGateway, dnsServers, interfaceType, linkSpeed,
  mtu, status, interfaceIndex`.
- Pagination: `queryAllFiltered`, cursor, pageSize 500.
- Limitation: `ipAddress` is singular per interface row; no DHCP/DNS-server
  *configuration* inference — `dnsServers` is the observed list only.

## last_user — `queryLoggedOnUsers('id = {device}')`

- Real shape: `{ userName, logonTime, deviceId }`.
- `source_observed_at` = `logonTime` (already epoch-ms).
- **Do not** label this "current user" — it is the last *reported* logged-on
  user per NinjaOne's collection cadence.

## policy_assignment — `getDevice(id)` policy fields + `getPolicy` name join

- Persisted: `nodeClass, policyId, rolePolicyId, observedName` (resolved via
  `getPolicy`; `observedName` is null if the policy lookup fails — never
  fabricate a name).
- Completeness: `complete`.

## software_inventory — `querySoftware('id = {device}')`

- Item keys (real): `name, publisher, version, installDate`.
- Live count on test device: 356 items, single page.
- Completeness: `complete` only when cursor exhausted; partial pages →
  `partial` and comparison must not claim removals.

## os_patch_state — `queryOSPatches('id = {device}')` ⚠ method name

- **Correct client method is `queryOSPatches`** (capital OS). An earlier
  adapter used `queryOsPatches`, which does not exist → `api_error`.
- This endpoint returns **pending/available** patches only. Zero results is
  honest "none pending" — never report "0 failed / all installed".
- Item keys (real): `id, name, kbNumber, status, severity, type, timestamp`.
  (`kbNumber`, not `kbArticleId`.)
- df filter is device-scoped (`id = {device}`); `deviceId = …` is rejected
  with 500 InvalidFilterException.
- Live result on test device: 0 pending patches.

## software_patch_state — `querySoftwarePatches('id = {device}')`

- Same semantics: pending only. Live result: 0 items.
- Item keys: `id, name, status, type, timestamp` (unverified on this device —
  zero rows observed; allowlist kept minimal).

## storage — `queryVolumes('id = {device}')`

- Item keys (real): `name, driveLetter, label, deviceType, fileSystem,
  capacity, freeSpace, serialNumber, timestamp`.
- Live: 2 volumes on test device.

## alerts — `getDeviceAlerts(id)`

- Item keys (real): `uid, severity, priority, conditionName,
  conditionHealthStatus, createTime, updateTime, sourceType, subject`.
- **No `status` field exists** — earlier allowlist picked a nonexistent key.
  Health is `conditionHealthStatus`.
- Live: 1 alert (disk-free-space condition) on test device.

## os_patch_history — `getDeviceOSPatchInstalls(id)`

- Item keys (real): `id, name, kbNumber, status, type, installedAt`.
- Live: 884 install events — this is a *history*, not current state. Never
  merge with `os_patch_state` to imply coverage.

## software_patch_history — `getDeviceSoftwarePatchInstalls(id)`

- Live: 0 items on test device. Allowlist: `id, name, productName, status,
  type, installedAt` (shape unverified — no rows observed).

## Cross-cutting

- **Forbidden**: HTTP 403 → observation `collection_status='forbidden'`,
  never an empty list. Verified via mocked test (no 403 available live).
- **Malformed**: 200 with invalid shape → `malformed`/`failed`, never success.
- **Dedupe**: canonical JSON → `sha256(conn|type|version|json)`; identical
  content reuses the payload row, fresh observation still written.
- **Adapter versioning**: observations stamp `adapter_version` (v1 = initial
  guessed fields, v2 = live-validated shapes in this doc). Comparisons across
  versions diff the shared-field intersection only — fields unique to one
  version are reported as `schemaDelta`, never as endpoint adds/removes;
  zero shared fields → `not_comparable` / `schema_version_change`.
  Observations captured before the column existed default to v1.
- **Rate limit**: shared upstream client handles Retry-After; adapter timeout
  wraps each resource fetch (30 s).
- **Unverified live**: `software_patch_state`/`software_patch_history` item
  shapes (0 rows on test device); forbidden/partial coverage paths are
  mock-tested only. One successful device does not generalize to other OS
  types, device classes, or permission configurations.
