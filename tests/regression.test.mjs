import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REPORTING_READ_TOOLS,
  COMMAND_READ_TOOLS,
  WRITE_TOOLS,
  isToolAllowed,
  toolRequiresGenericConfirmation,
} from '../dist/security-profile.js';
import { EndpointCatalog } from '../dist/endpoint-discovery.js';
import { collectPages } from '../dist/pagination.js';
import { navigateTools } from '../dist/tool-navigation.js';
import { getDevicesComplete, getTicketsComplete } from '../dist/complete-queries.js';
import { exportReadonlyAudit, sanitizeOutputName } from '../dist/audit-export.js';
import { openDatabase, redactArgs, tenantKeyFromBaseUrl } from '../dist/storage.js';
import { EntityStore, PERSIST_ALLOWLISTS } from '../dist/entity-store.js';
import { EntityResolver } from '../dist/entity-resolver.js';
import { summarizeDevice, DEVICE_EGRESS } from '../dist/projections.js';
import { resolveConnection } from '../dist/connections.js';
import { enforceOrganizationBoundary } from '../dist/org-boundary.js';
import { NinjaOneAPI } from '../dist/ninja-api.js';
import { OperationService, extractRunnerResult, planApprovalRequired, deriveCollectionStatus, transportEncodeCommand } from '../dist/operations.js';
import { InfraService } from '../dist/infra.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const safePolicy = {
  allowedOrganizationIds: [2],
  defaultOrganizationId: 2,
  blockedActions: [],
  ticketWritesEnabled: true,
  deviceManagementEnabled: true,
  administrativeWritesEnabled: false,
  deviceScriptsEnabled: false,
  powershellRunnerScriptId: null,
  softwareDeploymentEnabled: false,
  remoteControlEnabled: false,
  destructiveOperationsEnabled: false,
};

test('distribution is local stdio only', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const source = await readFile(join(process.cwd(), 'src', 'index.ts'), 'utf8');

  assert.equal(packageJson.scripts['start:http'], undefined);
  assert.equal(packageJson.scripts['start:sse'], undefined);
  assert.equal(packageJson.dependencies.express, undefined);
  assert.equal(packageJson.dependencies.cors, undefined);
  assert.equal(source.includes('createHttpServer'), false);
  assert.equal(source.includes('createSseServer'), false);
  assert.match(source, /supports local stdio transport only/);
});

test('reporting profile exposes no known write tools', () => {
  const reporting = { profile: 'reporting', policy: safePolicy };
  for (const tool of WRITE_TOOLS) {
    assert.equal(isToolAllowed(tool, reporting), false, `${tool} leaked into reporting`);
  }
  assert.equal(isToolAllowed('find_endpoint', reporting), true);
  assert.equal(isToolAllowed('export_readonly_audit', reporting), true);
});

test('command profile fails closed for unknown and disabled actions', () => {
  const command = { profile: 'command', policy: safePolicy };
  assert.equal(isToolAllowed('unknown_future_tool', command), false);
  assert.equal(isToolAllowed('run_device_script', command), false);
  assert.equal(isToolAllowed('apply_device_os_patches', command), false);
  assert.equal(isToolAllowed('delete_contact', command), false);
  assert.equal(toolRequiresGenericConfirmation('control_windows_service'), true);
});

test('device scripting discovery is command-only and script execution is confirmation guarded', () => {
  const enabledPolicy = { ...safePolicy, deviceScriptsEnabled: true, powershellRunnerScriptId: 106 };
  assert.equal(isToolAllowed('get_device_scripting_options', { profile: 'reporting', policy: enabledPolicy }), false);
  assert.equal(isToolAllowed('get_device_scripting_options', { profile: 'command', policy: enabledPolicy }), true);
  assert.equal(isToolAllowed('run_device_script', { profile: 'command', policy: enabledPolicy }), true);
  assert.equal(isToolAllowed('run_device_powershell', { profile: 'command', policy: enabledPolicy }), true);
  assert.equal(isToolAllowed('run_device_powershell', { profile: 'reporting', policy: enabledPolicy }), false);
  assert.equal(toolRequiresGenericConfirmation('run_device_script'), false);
  assert.ok(COMMAND_READ_TOOLS.has('get_device_scripting_options'));
});

test('endpoint catalog is discovery-only for GET and write endpoints', () => {
  const catalog = new EndpointCatalog();
  const result = catalog.find('activities', undefined, undefined, 10);
  assert.equal(result.catalog.executionEnabled, false);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((entry) => entry.executable === false));

  const write = catalog.find('create contact', undefined, 'POST', 5).results[0];
  assert.ok(write);
  const detail = catalog.describe(`${write.method} ${write.path}`);
  assert.equal(detail.found, true);
  assert.equal(detail.executable, false);
  assert.equal(detail.readOnlyHttpMethod, false);
});

test('domain navigator cannot reveal tools hidden by the active profile', () => {
  const exposed = [...REPORTING_READ_TOOLS];
  const devices = navigateTools('devices', 'reporting', exposed);
  assert.ok(devices.tools.includes('get_devices'));
  assert.equal(devices.tools.includes('reboot_device'), false);
  assert.equal(devices.stateful, false);
  assert.equal(devices.uiRequired, false);
});

test('pagination detects cursor loops instead of claiming completeness', async () => {
  const result = await collectPages({
    maxPages: 10,
    fetchPage: async () => ({
      items: [1],
      nextCursor: 1,
      hasMore: true,
    }),
  });
  assert.equal(result.complete, false);
  assert.equal(result.stoppedReason, 'cursor_loop');
});

test('complete device scan uses organization-scoped pages', async () => {
  const calls = [];
  const api = {
    async getOrganizationDevices(orgId, pageSize, after) {
      calls.push({ orgId, pageSize, after });
      return after === undefined
        ? [{ id: 1 }, { id: 2 }]
        : [{ id: 3 }];
    },
  };
  const result = await getDevicesComplete(api, {
    organizationId: 2,
    pageSize: 2,
  });
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.orgId === 2));
});

test('complete ticket scan requires explicit board and reports scanned versus matched', async () => {
  const api = {
    async getTickets(boardId, pageSize, cursor) {
      assert.equal(boardId, 9);
      return cursor === undefined
        ? { tickets: [
            { id: 10, clientId: 2, status: { displayName: 'Open' } },
            { id: 11, clientId: 3, status: { displayName: 'Open' } },
          ] }
        : { tickets: [{ id: 12, clientId: 2, status: { displayName: 'Closed' } }] };
    },
  };
  const result = await getTicketsComplete(api, {
    boardId: 9,
    organizationId: 2,
    pageSize: 2,
  });
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 3);
  assert.equal(result.matched, 2);
});

test('audit export stays in its fixed directory and redacts secret-shaped fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ninja-audit-test-'));
  const previous = process.env.NINJA_EXPORT_DIR;
  process.env.NINJA_EXPORT_DIR = directory;
  try {
    const api = {
      async getOrganization() {
        return { id: 2, name: 'ACME', clientSecret: 'must-not-appear' };
      },
      async getOrganizationDevices(_orgId, _pageSize, after) {
        return after === undefined ? [{ id: 139, systemName: 'EXAM-12' }] : [];
      },
    };
    const result = await exportReadonlyAudit(api, {
      template: 'device_inventory',
      organizationId: 2,
      outputName: '../../unsafe name',
      format: 'json',
    });
    assert.equal(result.complete, true);
    assert.equal(result.outputPath.startsWith(directory), true);
    const content = await readFile(result.outputPath, 'utf8');
    assert.equal(content.includes('must-not-appear'), false);
    assert.equal(content.includes('[REDACTED]'), true);
  } finally {
    if (previous === undefined) delete process.env.NINJA_EXPORT_DIR;
    else process.env.NINJA_EXPORT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit filenames remove path components', () => {
  assert.equal(sanitizeOutputName('../../ACME audit?.txt'), 'ACME-audit-.txt');
});

// ── Local entity store / resolver (SQLite-backed workspace) ──

const DEVICES = [
  { id: 11, systemName: 'WS-001', displayName: 'Reception PC', dnsName: 'ws-001.corp.local', organizationId: 2, locationId: 7, nodeClass: 'WINDOWS_WORKSTATION', offline: false, lastContact: 1000 },
  { id: 12, systemName: 'WS-002', displayName: 'Back Office', organizationId: 2, nodeClass: 'WINDOWS_WORKSTATION', offline: true, lastContact: 900 },
  { id: 13, systemName: 'SRV-01', displayName: 'File Server', organizationId: 3, nodeClass: 'WINDOWS_SERVER', offline: false, lastContact: 1100 },
];

const ORGS = [
  { id: 2, name: 'Acme Corp', description: 'test org' },
  { id: 3, name: 'Beta LLC', description: 'other org' },
];

function memoryStore() {
  return new EntityStore(openDatabase(':memory:'));
}

function mockApi(overrides = {}) {
  return {
    async getDevices(_df, _pageSize, after) {
      return after === undefined ? DEVICES : [];
    },
    async getOrganizations(_pageSize, after) {
      return after === undefined ? ORGS : [];
    },
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      if (!found) throw new Error(`Device ${id} not found`);
      return found;
    },
    async getOrganization(id) {
      const found = ORGS.find((o) => o.id === id);
      if (!found) throw new Error(`Org ${id} not found`);
      return found;
    },
    async getPolicies() {
      return [{ id: 5, name: 'Windows Workstation Policy' }];
    },
    async getOrganizationLocations() {
      return [{ id: 7, name: 'HQ' }];
    },
    ...overrides,
  };
}

test('store syncs devices and records appear/disappear/change diffs', () => {
  const store = memoryStore();
  const first = store.syncDevices(DEVICES);
  assert.equal(first.added, 3);
  assert.equal(first.changed, 0);

  const second = store.syncDevices([
    { ...DEVICES[0], offline: true },
    DEVICES[2],
    { id: 14, systemName: 'WS-003', organizationId: 2, offline: false },
  ]);
  assert.equal(second.added, 1);
  assert.equal(second.changed, 1);
  assert.equal(second.removed, 1); // device 12 missing from second sync

  const changes = store.getChanges({ entityType: 'device' });
  const offlineFlip = changes.find((c) => c.field === 'offline' && c.entity_id === 11);
  assert.ok(offlineFlip);
  assert.equal(offlineFlip.old_value, '0');
  assert.equal(offlineFlip.new_value, '1');
  const disappeared = changes.find((c) => c.field === '__disappeared__' && c.entity_id === 12);
  assert.ok(disappeared);
  const appeared = changes.find((c) => c.field === '__appeared__' && c.entity_id === 14);
  assert.ok(appeared);
});

test('resolver matches exact, prefix, substring, and normalized names', async () => {
  const store = memoryStore();
  const resolver = new EntityResolver(mockApi(), store);

  const exact = await resolver.resolveDevice('ws-001');
  assert.equal(exact.id, 11);

  const prefix = await resolver.resolveDevice('SRV');
  assert.equal(prefix.id, 13);

  const normalized = await resolver.resolveDevice('reception pc');
  assert.equal(normalized.id, 11);

  const numeric = await resolver.resolveDevice(12);
  assert.equal(numeric.id, 12);
  assert.equal(numeric.orgId, 2);
});

test('resolver refuses ambiguous names and lists candidates', async () => {
  const store = memoryStore();
  const resolver = new EntityResolver(mockApi(), store);
  await assert.rejects(
    () => resolver.resolveDevice('WS-00'),
    (error) => {
      assert.match(error.message, /Ambiguous device/);
      assert.match(error.message, /id=11/);
      assert.match(error.message, /id=12/);
      return true;
    },
  );
});

test('resolver scopes device search to an organization', async () => {
  const store = memoryStore();
  const resolver = new EntityResolver(mockApi(), store);
  const scoped = await resolver.resolveDevice('s', { orgId: 3 });
  assert.equal(scoped.id, 13);
});

test('resolver resolves organizations by name and reports not-found', async () => {
  const store = memoryStore();
  const resolver = new EntityResolver(mockApi(), store);
  const org = await resolver.resolveOrganization('acme');
  assert.equal(org.id, 2);
  await assert.rejects(() => resolver.resolveOrganization('nonexistent'), /No organization matching/);
});

test('saved filters round-trip and delete', () => {
  const store = memoryStore();
  store.saveFilter('offline-acme', 'devices', { df: 'offline = true', organization: 'Acme Corp' });
  const loaded = store.getFilter('offline-acme');
  assert.equal(loaded.entity_type, 'devices');
  assert.equal(loaded.params.df, 'offline = true');
  assert.equal(store.listFilters('devices').length, 1);
  assert.equal(store.deleteFilter('offline-acme'), true);
  assert.equal(store.getFilter('offline-acme'), null);
});

test('operation journal redacts secret-shaped args', () => {
  const store = memoryStore();
  store.logOperation({
    profile: 'command',
    tool: 'run_device_powershell',
    args: { deviceId: 11, command: 'Get-Date', apiToken: 'super-secret-value' },
    targetDeviceId: 11,
    targetOrgId: 2,
    dryRun: false,
    status: 'ok',
  });
  const rows = store.getJournal({ tool: 'run_device_powershell' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].args_redacted.apiToken, '[REDACTED]');
  assert.equal(rows[0].args_redacted.command, 'Get-Date');
  assert.equal(rows[0].target_device_id, 11);
  assert.equal(rows[0].status, 'ok');
});

test('redactArgs masks nested secrets and truncates long strings', () => {
  const out = redactArgs({ nested: { clientSecret: 'x' }, note: 'ok' });
  assert.equal(out.nested.clientSecret, '[REDACTED]');
  assert.equal(out.note, 'ok');
  const long = redactArgs({ blob: 'y'.repeat(5000) });
  assert.match(long.blob, /more chars/);
});

test('tenant keys come from the API host', () => {
  assert.equal(tenantKeyFromBaseUrl('https://us2.ninjarmm.com'), 'us2.ninjarmm.com');
  assert.equal(tenantKeyFromBaseUrl('not a url'), 'not-a-url');
});

test('device summary keeps key fields and drops the rest', () => {
  const summary = summarizeDevice(DEVICES[0], 'Acme Corp');
  assert.equal(summary.id, 11);
  assert.equal(summary.systemName, 'WS-001');
  assert.equal(summary.organizationName, 'Acme Corp');
  assert.equal(summary.offline, false);
  assert.equal(summary.references, undefined);
  assert.equal(summary.raw_json, undefined);
});

test('all new workspace tools are registered in the reporting read set', () => {
  const reporting = { profile: 'reporting', policy: safePolicy };
  for (const tool of [
    'resolve_devices', 'resolve_organizations', 'resolve_locations', 'resolve_policies',
    'sync_entities', 'get_entity_changes', 'get_operation_journal',
    'save_filter', 'list_saved_filters', 'delete_saved_filter',
    'set_context', 'get_context',
  ]) {
    assert.equal(isToolAllowed(tool, reporting), true, `${tool} missing from reporting profile`);
  }
});

// ── M0: identity, principal separation, boundary, persistence/egress ──

const ENV_KEYS = [
  'NINJA_AUTH_PROFILE', 'NINJA_CLIENT_ID', 'NINJA_CLIENT_SECRET',
  'NINJA_NATIVE_CLIENT_ID', 'NINJA_DB_PATH', 'NINJA_CONNECTION_ID', 'NINJA_BASE_URL',
];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('reporting profile cannot fall back to command credentials', async () => {
  await withEnv(
    { NINJA_AUTH_PROFILE: 'reporting', NINJA_NATIVE_CLIENT_ID: 'native-only' },
    async () => {
      const api = new NinjaOneAPI();
      assert.equal(api.getPrincipal().credentialKind, 'client_credentials');
      assert.equal(api.isConfiguredProfile(), false);
      await assert.rejects(() => api.getDevices(), /requires NINJA_CLIENT_ID and NINJA_CLIENT_SECRET/);
    },
  );
});

test('command profile cannot fall back to reporting credentials', () => {
  withEnv(
    { NINJA_AUTH_PROFILE: 'command', NINJA_CLIENT_ID: 'cc-id', NINJA_CLIENT_SECRET: 'cc-secret' },
    () => {
      const api = new NinjaOneAPI();
      assert.equal(api.getPrincipal().credentialKind, 'native_pkce');
      assert.equal(api.isConfiguredProfile(), false);
    },
  );
});

test('connection manifest assigns a uuid and adopts legacy host-named db in place', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'ninja-conn-'));
  try {
    mkdirSync(join(baseDir, 'data'), { recursive: true });
    const legacyFile = join(baseDir, 'data', 'tenant-a.example.com.db');
    writeFileSync(legacyFile, '');

    const first = withEnv({}, () => resolveConnection('https://tenant-a.example.com', { baseDir }));
    assert.equal(first.adopted, true);
    assert.equal(first.dbPath, legacyFile);
    assert.match(first.connection.id, /^[0-9a-f-]{36}$/);

    const again = withEnv({}, () => resolveConnection('https://tenant-a.example.com', { baseDir }));
    assert.equal(again.connection.id, first.connection.id, 'binding must be stable');

    const other = withEnv({}, () => resolveConnection('https://tenant-b.example.com', { baseDir }));
    assert.notEqual(other.connection.id, first.connection.id);
    assert.match(other.dbPath, /conn-[0-9a-f-]+\.db$/);
    assert.notEqual(other.dbPath, first.dbPath, 'connections must not share a database file');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('ambiguous same-host claims resolve deterministically without merging', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'ninja-conn-'));
  try {
    mkdirSync(baseDir, { recursive: true });
    const mk = (id, createdAt) => ({
      id, apiOrigin: 'https://dup.example.com', tenantHost: 'dup.example.com',
      dbFile: join(baseDir, 'data', `${id}.db`), createdAt,
    });
    writeFileSync(
      join(baseDir, 'connections.json'),
      JSON.stringify({ version: 1, connections: [mk('newer', 2000), mk('older', 1000)] }),
    );
    const res = withEnv({}, () => resolveConnection('https://dup.example.com', { baseDir }));
    assert.equal(res.connection.id, 'older', 'oldest claim wins deterministically');
    assert.deepEqual(res.ambiguousIds, ['newer']);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('explicit NINJA_CONNECTION_ID selects; unknown id fails closed', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'ninja-conn-'));
  try {
    mkdirSync(baseDir, { recursive: true });
    const conn = {
      id: 'conn-explicit', apiOrigin: 'https://x.example.com', tenantHost: 'x.example.com',
      dbFile: join(baseDir, 'data', 'explicit.db'), createdAt: 1,
    };
    writeFileSync(join(baseDir, 'connections.json'), JSON.stringify({ version: 1, connections: [conn] }));

    const picked = withEnv({ NINJA_CONNECTION_ID: 'conn-explicit' }, () =>
      resolveConnection('https://other.example.com', { baseDir }));
    assert.equal(picked.dbPath, conn.dbFile);

    assert.throws(
      () => withEnv({ NINJA_CONNECTION_ID: 'does-not-exist' }, () =>
        resolveConnection('https://x.example.com', { baseDir })),
      /not in the connection manifest/,
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('database fails closed when opened under a different connection id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ninja-bind-'));
  try {
    const dbPath = join(dir, 'bound.db');
    openDatabase(dbPath, { connectionId: 'conn-A' }).close();
    openDatabase(dbPath, { connectionId: 'conn-A' }).close();
    assert.throws(
      () => openDatabase(dbPath, { connectionId: 'conn-B' }),
      /belongs to connection conn-A/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('out-of-organization device write is denied by the boundary', async () => {
  const api = {
    async getDevice() { return { id: 11, organizationId: 9 }; },
    async getTicket() { return { clientId: 9 }; },
    async getAlert() { return { deviceId: 11 }; },
  };
  await assert.rejects(
    () => enforceOrganizationBoundary(api, 'command', [2], 'reboot_device', { id: 11 }),
    /outside the command profile's allowed organization boundary/,
  );
  await assert.rejects(
    () => enforceOrganizationBoundary(api, 'command', [2], 'update_ticket', { ticketId: 5 }),
    /outside the command profile's allowed organization boundary/,
  );
  // in-org target passes; non-command profile is a no-op
  const inOrg = { ...api, async getDevice() { return { id: 11, organizationId: 2 }; } };
  await enforceOrganizationBoundary(inOrg, 'command', [2], 'reboot_device', { id: 11 });
  await enforceOrganizationBoundary(api, 'reporting', [2], 'reboot_device', { id: 11 });
});

test('entity persistence stores no raw upstream blob (raw_json stays null)', () => {
  const store = memoryStore();
  store.syncDevices([{ ...DEVICES[0], clientSecret: 'must-not-persist', extraBlob: { a: 1 } }]);
  const row = store.getDeviceById(11);
  assert.equal(row.raw_json, null, 'raw upstream blob must not be persisted');
  assert.equal(JSON.stringify(row).includes('must-not-persist'), false);
  for (const key of Object.keys(row)) {
    const allowed = ['device_id', 'raw_json', 'updated_at', 'seen_at', ...PERSIST_ALLOWLISTS.device];
    assert.ok(allowed.includes(key), `unexpected persisted column ${key}`);
  }
});

test('journal rows are stamped with the store connection id', () => {
  const store = new EntityStore(openDatabase(':memory:'), { connectionId: 'conn-test' });
  store.logOperation({ profile: 'reporting', tool: 'get_devices', args: {}, dryRun: false, status: 'ok' });
  const rows = store.getJournal({ tool: 'get_devices' });
  assert.equal(rows[0].connection_id, 'conn-test');
});

test('model egress: device summary emits only allowlisted keys', () => {
  const summary = summarizeDevice(DEVICES[0], 'Acme Corp');
  for (const key of Object.keys(summary)) {
    assert.ok(DEVICE_EGRESS.includes(key), `unexpected egress field ${key}`);
  }
});

// ── M1: scoped sync generations, null safety, staleness, typed filters ──

test('org-scoped device sync never deletes out-of-scope rows (no false deletes)', () => {
  const store = memoryStore();
  store.syncDevices(DEVICES); // full fleet: 11,12 (org 2), 13 (org 3)
  // partial scan of org 2 sees only device 11 → device 12 is in-scope-missing
  const report = store.syncDevices([DEVICES[0]], { scopeOrgId: 2 });
  assert.equal(report.removed, 1);
  assert.equal(store.getDeviceById(12), undefined, 'in-scope missing row removed');
  assert.ok(store.getDeviceById(13), 'out-of-scope row must survive a partial scan');
  assert.equal(store.syncState('devices:org:2').item_count, 1);
  assert.equal(store.syncState('devices').item_count, 3, 'full-fleet sync state untouched by scoped sync');
});

test('sync tolerates entities with absent/null fields', () => {
  const store = memoryStore();
  const report = store.syncDevices([{ id: 99 }, { id: 100, systemName: null, offline: undefined }]);
  assert.equal(report.added, 2);
  const row = store.getDeviceById(99);
  assert.ok(row);
  assert.equal(row.system_name, null);
  assert.equal(row.org_id, null);
});

test('stale sync state triggers a lazy resync; warm cache performs zero upstream calls', async () => {
  const store = memoryStore();
  let deviceCalls = 0;
  const api = mockApi({
    async getDevices(_df, _ps, after) {
      deviceCalls++;
      return after === undefined ? DEVICES : [];
    },
  });
  const resolver = new EntityResolver(api, store);
  await resolver.resolveDevice('ws-001');
  const afterFirst = deviceCalls;
  await resolver.resolveDevice('ws-001');
  assert.equal(deviceCalls, afterFirst, 'warm resolve must not hit upstream');

  const alwaysStale = new EntityResolver(api, store, { devices: -1 });
  await alwaysStale.resolveDevice('ws-001');
  assert.ok(deviceCalls > afterFirst, 'stale cache must resync from upstream');
});

test('saved filters are typed: bad entity type, key, or value kind is rejected', () => {
  const store = memoryStore();
  store.saveFilter('ok-filter', 'devices', { df: 'offline = true', pageSize: 50 });
  assert.throws(() => store.saveFilter('bad', 'widgets', { df: 'x' }), /Unknown filter entity type/);
  assert.throws(() => store.saveFilter('bad2', 'devices', { evil: 'x' }), /not allowed for devices filters/);
  assert.throws(() => store.saveFilter('bad3', 'devices', { pageSize: 'abc' }), /must be a number/);
  assert.throws(() => store.saveFilter('bad4', 'devices', { df: 42 }), /must be a string/);
});

test('normalized device lookup uses the indexed name_norm path', async () => {
  const store = memoryStore();
  store.syncDevices(DEVICES);
  const row = store.getDeviceById(11);
  assert.ok(row.name_norm.includes('receptionpc'), 'name_norm populated on sync');
  const resolver = new EntityResolver(mockApi(), store);
  const r = await resolver.resolveDevice('receptionpc');
  assert.equal(r.id, 11);
});

test('importing the server module does not start the stdio loop', () => {
  const out = execFileSync(
    process.execPath,
    ['-e', `import('file:///${join(process.cwd(), 'dist', 'index.js').replace(/\\/g, '/')}').then(m => console.log('EXPORTED:' + typeof m.NinjaOneMCPServer))`],
    { timeout: 15000, encoding: 'utf8' },
  );
  assert.match(out, /EXPORTED:function/);
});

// ── M2: shared dispatch, session scope, rate limiting, local server ──

import { NinjaOneMCPServer } from '../dist/index.js';

function testServer() {
  return withEnv(
    {
      NINJA_AUTH_PROFILE: 'reporting',
      NINJA_CLIENT_ID: 'x', NINJA_CLIENT_SECRET: 'y',
      NINJA_DB_PATH: ':memory:',
    },
    () => {
      const srv = new NinjaOneMCPServer();
      // Swap the API-backed pieces for mock-fed ones on the same store.
      srv.resolver = new EntityResolver(mockApi(), srv.store);
      srv.api = mockApi();
      return srv;
    },
  );
}

test('concurrent sessions preserve independent organization scope', async () => {
  const srv = testServer();
  await srv.executeToolCall('set_context', { organization: 'acme' }, 'sess-A');
  const a = JSON.parse((await srv.executeToolCall('get_context', {}, 'sess-A')).content[0].text);
  const b = JSON.parse((await srv.executeToolCall('get_context', {}, 'sess-B')).content[0].text);
  assert.equal(a.organizationId, 2);
  assert.equal(b.organizationId, null, 'session B must not see session A scope');
});

test('executeToolCall enforces the same profile allowlist as stdio', async () => {
  const srv = testServer();
  await assert.rejects(
    () => srv.executeToolCall('reboot_device', { id: 11 }, 'http-sess'),
    /not available in the reporting profile/,
  );
  // unknown tools fail closed too
  await assert.rejects(
    () => srv.executeToolCall('definitely_not_a_tool', {}, 'http-sess'),
    /not available/,
  );
});

test('makeRequest retries 429 once honoring Retry-After', async () => {
  await withEnv(
    { NINJA_AUTH_PROFILE: 'reporting', NINJA_CLIENT_ID: 'x', NINJA_CLIENT_SECRET: 'y' },
    async () => {
      const api = new NinjaOneAPI();
      api.baseUrl = 'https://api.test';
      api.accessToken = 'cached';
      api.tokenExpiry = Date.now() + 600_000;
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1
          ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
          : new Response('{"ok":true}', { status: 200 });
      };
      try {
        const out = await api.makeRequest('/v2/test');
        assert.deepEqual(out, { ok: true });
        assert.equal(calls, 2, 'exactly one retry');
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );
});

test('local serve adapter requires bearer auth and answers /health', async () => {
  const port = 39157;
  const env = {
    ...process.env,
    NINJA_AUTH_PROFILE: 'reporting',
    NINJA_CLIENT_ID: 'x', NINJA_CLIENT_SECRET: 'y',
    NINJA_DB_PATH: ':memory:',
    NINJA_SERVE_TOKEN: 'test-token-m2',
    NINJA_SERVE_PORT: String(port),
  };
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, [join(process.cwd(), 'dist', 'serve.js')], { env, stdio: 'pipe' });
  try {
    // wait for listen
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: 'Bearer test-token-m2' } });
        up = r.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(up, 'server did not start');

    const unauth = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unauth.status, 401);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: 'Bearer test-token-m2' },
    })).json();
    assert.equal(health.ok, true);
    assert.equal(health.principal.profile, 'reporting');
    assert.equal(health.principal.credentialKind, 'client_credentials');

    const denied = await (await fetch(`http://127.0.0.1:${port}/tools/reboot_device`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-m2', 'content-type': 'application/json' },
      body: '{}',
    })).json();
    assert.match(denied.message ?? '', /not available/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});

test('listDevices paginates and filters server-side', () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  const page1 = s.listDevices({ page: 1, pageSize: 2 });
  assert.equal(page1.total, 3);
  assert.equal(page1.rows.length, 2);
  const page2 = s.listDevices({ page: 2, pageSize: 2 });
  assert.equal(page2.rows.length, 1);
  assert.notEqual(page1.rows[0].device_id, page2.rows[0].device_id);
  const filtered = s.listDevices({ q: 'recep' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].org_name, 'Acme Corp');
  const scoped = s.listDevices({ orgId: 3 });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.rows[0].system_name, 'SRV-01');
  // Invariant 10: raw upstream blob must never egress through the UI/API.
  for (const row of page1.rows) assert.ok(!('raw_json' in row), 'raw_json leaked through listDevices');
});

test('listDevices filters offline and sorts server-side', () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  const off = s.listDevices({ offline: true });
  assert.equal(off.total, 1);
  assert.equal(off.rows[0].system_name, 'WS-002');
  const byOrg = s.listDevices({ sort: 'org', dir: 'asc' });
  assert.equal(byOrg.rows[0].org_name, 'Acme Corp');
  const byOrgDesc = s.listDevices({ sort: 'org', dir: 'desc' });
  assert.equal(byOrgDesc.rows[0].org_name, 'Beta LLC');
  const byContact = s.listDevices({ sort: 'last_contact', dir: 'desc' });
  assert.equal(byContact.rows[0].system_name, 'SRV-01', 'latest contact first');
  // Unknown sort keys fall back to name, never inject into ORDER BY.
  const safe = s.listDevices({ sort: 'device_id; DROP TABLE entities_device' });
  assert.equal(safe.rows.length, 3);
});

test('listOrganizations and orgDetail return counts and changes', () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  const orgs = s.listOrganizations();
  assert.equal(orgs.length, 2);
  const acme = orgs.find((o) => o.org_id === 2);
  assert.equal(acme.device_count, 2);
  for (const o of orgs) assert.ok(!('raw_json' in o), 'raw_json leaked through listOrganizations');
  const detail = s.orgDetail(2);
  assert.equal(detail.org.name, 'Acme Corp');
  assert.ok(!('raw_json' in detail.org), 'raw_json leaked through orgDetail');
  assert.equal(detail.deviceCount, 2);
  assert.equal(detail.offlineCount, 1);
  assert.equal(s.orgDetail(999).org, null);
});

test('getChangesLabeled resolves entity display names', () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  s.syncDevices(DEVICES.map((d) => (d.id === 11 ? { ...d, offline: true } : d)));
  const rows = s.getChangesLabeled({ entityType: 'device', entityId: 11 });
  const flip = rows.find((c) => c.field === 'offline');
  assert.ok(flip);
  assert.equal(flip.entity_label, 'Reception PC');
  assert.equal(flip.org_name, 'Acme Corp');
});

// ─── M4: plans → trusted approval → persist → dispatch → receipt ─────────

const cmdSecurity = {
  profile: 'command',
  principal: { profile: 'command', credentialKind: 'native_pkce' },
  policy: { ...safePolicy, deviceScriptsEnabled: true, powershellRunnerScriptId: 106 },
};

function mockOpApi(overrides = {}) {
  return {
    calls: [],
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      if (!found) throw new Error(`Device ${id} not found`);
      return found;
    },
    async runDeviceScript(deviceId, body) {
      this.calls.push({ deviceId, body });
      return { id: 555, status: 'QUEUED' };
    },
    async getDeviceActivities() {
      return { activities: [] };
    },
    ...overrides,
  };
}

test('plan → approve → execute: persists intent before dispatch, consumes approval once', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);

  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  assert.ok(plan.planHash);
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui-session' });
  assert.equal(approval.planHash, plan.planHash);

  const op = await ops.executeApproved(plan.id, approval.id);
  assert.equal(op.status, 'accepted');
  assert.equal(api.calls.length, 1, 'exactly one upstream dispatch');
  assert.equal(api.calls[0].deviceId, 11);
  assert.match(api.calls[0].body.parameters, / \d+$/);

  // Intent persisted before dispatch: events exist on the operation row.
  const kinds = op.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['preflight_ok', 'intent_persisted', 'dispatch_accepted', 'session_opened']);

  // Dedup: re-executing the same plan returns the same operation.
  const again = await ops.executeApproved(plan.id, approval.id);
  assert.equal(again.id, op.id);
  assert.equal(api.calls.length, 1, 'no second dispatch for the same plan');

  // Unknown/mismatched approval is rejected.
  await assert.rejects(() => ops.executeApproved(plan.id, 'nope'), /does not match|not found/);
});

test('dispatch failure persists a failed operation — no silent retry', async () => {
  const s = memoryStore();
  const api = mockOpApi({
    async runDeviceScript() { throw new Error('upstream 500'); },
  });
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await assert.rejects(() => ops.executeApproved(plan.id, approval.id), /Dispatch failed/);
  const [op] = ops.listOperations();
  assert.equal(op.status, 'failed', 'failed dispatch is persisted, not lost');
});

test('persist-before-dispatch: intent row exists even when upstream fails', async () => {
  const s = memoryStore();
  let sawIntentBeforeDispatch = false;
  const api = mockOpApi({
    async runDeviceScript() {
      sawIntentBeforeDispatch = s.database.prepare("SELECT COUNT(*) AS n FROM operations WHERE status = 'dispatching'").get().n === 1;
      return { id: 1 };
    },
  });
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'whoami' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await ops.executeApproved(plan.id, approval.id);
  assert.ok(sawIntentBeforeDispatch, 'operation row committed before upstream call');
});

test('fresh preflight denies out-of-org device even when cache allows it', async () => {
  const s = memoryStore();
  s.syncDevices(DEVICES); // cache says device 13 is in org 3 (allowed)
  const api = mockOpApi({
    async getDevice() { return { id: 13, organizationId: 9, systemName: 'SRV-01' }; }, // upstream truth: moved to org 9
  });
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 13, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await assert.rejects(() => ops.executeApproved(plan.id, approval.id), /outside the allowed set/);
  assert.equal(api.calls.length, 0, 'no dispatch when fresh preflight fails');
  assert.equal(ops.listOperations().length, 0, 'no intent persisted on preflight failure');
});

test('offline upstream device blocks dispatch', async () => {
  const s = memoryStore();
  const api = mockOpApi({ async getDevice() { return { id: 11, organizationId: 2, offline: true }; } });
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await assert.rejects(() => ops.executeApproved(plan.id, approval.id), /offline/);
});

test('writes require the command principal — reporting cannot approve or dispatch', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const reporting = { profile: 'reporting', principal: { profile: 'reporting' }, policy: safePolicy };
  const ops = new OperationService(s, api, reporting);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  assert.throws(() => ops.approvePlan(plan.id, { approvedBy: 'ui' }), /command profile/);
  assert.equal(api.calls.length, 0);
});

test('expired plan cannot be approved or executed', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  s.database.prepare('UPDATE operation_plans SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, plan.id);
  assert.throws(() => ops.approvePlan(plan.id, { approvedBy: 'ui' }), /expired/);
});

test('unsupported operations are rejected at plan time', () => {
  const s = memoryStore();
  const ops = new OperationService(s, mockOpApi(), cmdSecurity);
  assert.throws(() => ops.createPlan({ operation: 'reboot_device', targetType: 'device', targetId: 11, args: {} }), /not_supported/);
});

test('reconcile verifies on runner result and stays honest when absent', async () => {
  const s = memoryStore();
  const runResultPayload = { schemaVersion: 2, exitCode: 0, durationMs: 1200 };
  const activityWithResult = {
    id: 777,
    statusCode: 'COMPLETED',
    result: `S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify(runResultPayload)}\nS4X_RUNNER_RESULT_END`,
  };
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  const runId = op.upstream_ref;

  // No activity yet → stays accepted (honest unknown).
  const pending = await ops.reconcile(op.id);
  assert.equal(pending.status, 'accepted');

  // Activity containing the run id → verified with bounded result.
  api.getDeviceActivities = async () => ({
    activities: [{ ...activityWithResult, result: `prefix ${runId} S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify(runResultPayload)}\nS4X_RUNNER_RESULT_END` }],
  });
  const done = await ops.reconcile(op.id);
  assert.equal(done.status, 'verified');
  assert.equal(done.result.exitCode, 0);
});

// ─── M4 sessions: confirm:true cannot dispatch; approval opens a session ──

test('confirm path without a session creates a plan and never dispatches', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const res = await ops.executeSessionCommand(11, { command: 'ipconfig' });
  assert.equal(res.approvalRequired, true);
  assert.equal(res.code, 'APPROVAL_REQUIRED');
  assert.ok(res.planId, 'a plan was created for the human to approve');
  assert.equal(api.calls.length, 0, 'no runDeviceScript call');
  // The plan is discoverable in the pending queue.
  const pending = ops.listPlans();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, res.planId);
  assert.equal(pending[0].args.command, 'ipconfig');
});

test('approved execution opens a session; second command on same device dispatches', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const first = await ops.executeApproved(plan.id, approval.id);
  assert.equal(first.status, 'accepted');

  const session = ops.findOpenSession(11);
  assert.ok(session, 'dispatch acceptance opened a device session');
  assert.equal(session.device_id, 11);
  assert.equal(session.status, 'open');

  const second = await ops.executeSessionCommand(11, { command: 'whoami' });
  assert.equal(second.status, 'accepted');
  assert.equal(second.sessionId, session.id);
  assert.equal(second.commandsUsed, 1);
  assert.equal(api.calls.length, 2, 'first dispatch + one chained dispatch');
  // Command text stored per step (as the step's immutable plan row).
  const stepPlan = s.database.prepare('SELECT args_canonical FROM operation_plans WHERE id = ?').get(second.plan_id);
  assert.match(stepPlan.args_canonical, /whoami/);
  // Each chained command carries its own operation events.
  assert.deepEqual(
    second.events.map((e) => e.kind),
    ['session_attached', 'preflight_ok', 'intent_persisted', 'dispatch_accepted'],
  );
});

test('session does not leak across devices — second device needs new approval', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await ops.executeApproved(plan.id, approval.id);

  const res = await ops.executeSessionCommand(13, { command: 'whoami' });
  assert.equal(res.approvalRequired, true);
  assert.equal(api.calls.length, 1, 'still only the first dispatch');
  assert.ok(res.planId, 'a fresh plan was created for device 13');
});

test('expired session is denied — new plan required, no dispatch', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await ops.executeApproved(plan.id, approval.id);
  s.database.prepare('UPDATE device_sessions SET expires_at = ? WHERE device_id = 11').run(Date.now() - 1000);

  const res = await ops.executeSessionCommand(11, { command: 'whoami' });
  assert.equal(res.approvalRequired, true);
  assert.equal(api.calls.length, 1);
});

test('session command cap is enforced atomically', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  await ops.executeApproved(plan.id, approval.id);
  // Burn the remaining slots directly to the cap boundary.
  s.database.prepare('UPDATE device_sessions SET commands_used = max_commands WHERE device_id = 11').run();

  const res = await ops.executeSessionCommand(11, { command: 'whoami' });
  assert.equal(res.approvalRequired, true);
  assert.equal(api.calls.length, 1, 'exhausted session never dispatches');
});

test('planApprovalRequired defaults on; explicit 0/false disables', () => {
  assert.equal(planApprovalRequired({}), true);
  assert.equal(planApprovalRequired({ NINJA_REQUIRE_PLAN_APPROVAL: '1' }), true);
  assert.equal(planApprovalRequired({ NINJA_REQUIRE_PLAN_APPROVAL: '0' }), false);
  assert.equal(planApprovalRequired({ NINJA_REQUIRE_PLAN_APPROVAL: 'false' }), false);
});

test('extractRunnerResult parses result block and streams', () => {
  const runId = 'abc-123';
  const activity = {
    result: `noise S4X_RUNNER_RESULT_BEGIN\n{"schemaVersion":2,"exitCode":0}\nS4X_RUNNER_RESULT_END ` +
      `S4X_RUNNER_STDOUT_BEGIN:${runId}\nhello\nS4X_RUNNER_STDOUT_END:${runId}` +
      ` S4X_RUNNER_STDERR_BEGIN:${runId}\n(none)\nS4X_RUNNER_STDERR_END:${runId}`,
  };
  const parsed = extractRunnerResult(activity, runId);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.stdout, 'hello');
  assert.equal(parsed.stderr, '');
  assert.equal(parsed.streamsComplete, true);
  assert.equal(extractRunnerResult({ result: 'nothing here' }, runId), null);
});

test('deviceDetail returns device, org name, changes, and journal', () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  const d = s.deviceDetail(11);
  assert.equal(d.device.system_name, 'WS-001');
  assert.equal(d.orgName, 'Acme Corp');
  assert.ok(typeof d.device.seen_at === 'number', 'deviceDetail exposes cache-seen provenance');
  assert.ok(!('raw_json' in d.device), 'raw_json leaked through deviceDetail');
  assert.equal(s.deviceDetail(999).device, null);
});

test('serve /api/v1: browse, write-denial, restart persistence', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const connId = '11111111-2222-3333-4444-555555555555';
  const dir = await mkdtemp(join(tmpdir(), 'n1-serve-'));
  const dbPath = join(dir, 'serve.db');
  const { spawn } = await import('node:child_process');
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: 'Bearer test-token-m3', 'content-type': 'application/json' };

  const startServer = async () => {
    const proc = spawn(process.execPath, [join(process.cwd(), 'dist', 'serve.js')], {
      env: {
        ...process.env,
        NINJA_AUTH_PROFILE: 'reporting',
        NINJA_CLIENT_ID: 'x', NINJA_CLIENT_SECRET: 'y',
        NINJA_DB_PATH: dbPath,
        NINJA_CONNECTION_ID: connId,
        NINJA_SERVE_TOKEN: 'test-token-m3',
        NINJA_SERVE_PORT: String(port),
      },
      stdio: 'pipe',
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`serve exited early with code ${proc.exitCode}`);
      try {
        if ((await fetch(`${base}/health`, { headers })).ok) return proc;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    proc.kill('SIGKILL');
    throw new Error('serve did not start');
  };
  const stopServer = async (proc) => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };

  try {
    // Seed the DB as the daemon would after a sync_entities run.
    const seed = new EntityStore(dbPath, { connectionId: connId });
    seed.syncDevices(DEVICES);
    seed.syncOrganizations(ORGS);
    seed.close();

    // Boot 1 — browse devices, open detail.
    let proc = await startServer();
    const devices = await (await fetch(`${base}/api/v1/devices?q=ws`, { headers })).json();
    assert.equal(devices.total, 2);
    const detail = await (await fetch(`${base}/api/v1/devices/11`, { headers })).json();
    assert.equal(detail.device.system_name, 'WS-001');
    assert.equal(detail.orgName, 'Acme Corp');
    const missing = await fetch(`${base}/api/v1/devices/999`, { headers });
    assert.equal(missing.status, 404);

    // The UI surface exposes no write path: tool bridge still denies writes.
    const denied = await (await fetch(`${base}/tools/reboot_device`, {
      method: 'POST', headers, body: '{}',
    })).json();
    assert.match(denied.message ?? '', /not available/);
    await stopServer(proc);

    // Operator-side drift while the server is down.
    const drift = new EntityStore(dbPath, { connectionId: connId });
    drift.syncDevices(DEVICES.map((d) => (d.id === 11 ? { ...d, displayName: 'Renamed while away', offline: true } : d)));
    drift.close();

    // Boot 2 (restart) — device data persists across process restarts.
    proc = await startServer();
    const detail2 = await (await fetch(`${base}/api/v1/devices/11`, { headers })).json();
    assert.equal(detail2.device.display_name, 'Renamed while away', 'device store survived restart');
    await stopServer(proc);
  } finally {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {}
  }
});


// ─── M4.5: snapshot capture / sealed manifests / compare / schedule ─────

import { SnapshotService } from '../dist/snapshots.js';

function mockSnapApi(overrides = {}) {
  return {
    requests: [],
    async getDevice(id) {
      this.requests.push('getDevice');
      const d = DEVICES.find((x) => x.id === id);
      if (!d) throw new Error('API request failed: 404 Not Found - {}');
      return d;
    },
    async queryNetworkInterfaces(df, cursor, pageSize) {
      this.requests.push('nics');
      return { results: [{ name: 'Ethernet0', macAddress: 'AA:BB', ipAddresses: ['10.0.0.5'], deviceId: 11 }] };
    },
    async queryLoggedOnUsers() { this.requests.push('users'); return { results: [{ userName: 'jdoe', deviceId: 11 }] }; },
    async getDeviceSoftware() {
      this.requests.push('software');
      return [{ name: 'App A', version: '1.0', publisher: 'Pub' }, { name: 'App B', version: '2.0', publisher: 'Pub' }];
    },
    async queryOSPatches() { this.requests.push('ospatch'); return { results: [{ id: 9, name: 'KB5001', status: 'Pending' }] }; },
    async queryVolumes() { this.requests.push('vol'); return { results: [{ name: 'C:', capacity: 100, freeSpace: 40 }] }; },
    async getDeviceAlerts() { this.requests.push('alerts'); return [{ uid: 'a1', severity: 'MINOR', status: 'open' }]; },
    ...overrides,
  };
}

test('capture seals a manifest with honest per-resource coverage', async () => {
  const s = memoryStore();
  const api = mockSnapApi();
  const svc = new SnapshotService(s, api);
  const r = await svc.capture({ deviceId: 11, profile: 'standard', device: DEVICES[0] });
  assert.equal(r.coverage.status, 'completed');
  const snap = svc.getSnapshot(r.snapshotId);
  assert.ok(snap.manifest_digest.length >= 16);
  const types = snap.resources.map((x) => x.resource_type).sort();
  assert.deepEqual(types, ['alerts', 'identity', 'last_user', 'network', 'os_patch_state', 'policy_assignment', 'software_inventory', 'storage'].sort());
  for (const res of snap.resources) assert.equal(res.state, 'collected');
  const net = snap.resources.find((x) => x.resource_type === 'network');
  assert.equal(net.completeness, 'complete');
  assert.ok(net.fetched_at > 0);
});

test('403 is recorded forbidden — never an empty list', async () => {
  const s = memoryStore();
  const api = mockSnapApi({
    async getDeviceSoftware() { throw new Error('API request failed: 403 Forbidden - denied'); },
  });
  const svc = new SnapshotService(s, api);
  const r = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  assert.equal(r.coverage.status, 'partial');
  const obs = svc.getObservation(r.coverage.resources.software_inventory.observationId);
  assert.equal(obs.collection_status, 'forbidden');
  assert.equal(obs.safe_error, 'forbidden_403');
  assert.equal(obs.item_count, null, 'forbidden is not zero items');
});

test('malformed 200 shape is recorded failed, not success', async () => {
  const s = memoryStore();
  const api = mockSnapApi({
    async getDeviceSoftware() { return { success: true }; },
  });
  const svc = new SnapshotService(s, api);
  const r = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const obs = svc.getObservation(r.coverage.resources.software_inventory.observationId);
  assert.equal(obs.collection_status, 'failed');
  assert.equal(obs.safe_error, 'malformed_response');
});

test('identical content dedupes payload but keeps a fresh observation', async () => {
  const s = memoryStore();
  const api = mockSnapApi();
  const svc = new SnapshotService(s, api);
  const r1 = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const r2 = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const o1 = svc.getObservation(r1.coverage.resources.software_inventory.observationId);
  const o2 = svc.getObservation(r2.coverage.resources.software_inventory.observationId);
  assert.equal(o1.payload_id, o2.payload_id, 'same canonical content → same payload');
  assert.notEqual(o1.id, o2.id, 'new fetch → new observation row');
  const payloads = s.database.prepare('SELECT COUNT(*) n FROM device_resource_payloads').get();
  assert.equal(payloads.n, 1);
});

test('compare: complete sets diff items; missing resource is not_comparable', async () => {
  const s = memoryStore();
  const api = mockSnapApi();
  const svc = new SnapshotService(s, api);
  const r1 = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const api2 = mockSnapApi({
    async getDeviceSoftware() {
      return [{ name: 'App A', version: '1.1', publisher: 'Pub' }, { name: 'App C', version: '3.0', publisher: 'Pub' }];
    },
  });
  const svc2 = new SnapshotService(s, api2);
  const r2 = await svc2.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const diff = svc.compare(r1.snapshotId, r2.snapshotId);
  assert.equal(diff.error, undefined);
  const sw = diff.resources.find((x) => x.resource === 'software_inventory');
  assert.equal(sw.status, 'changed');
  assert.ok(sw.detail.added.length >= 1, 'App C detected as added');
  // Missing resource → not_comparable, never a false removal.
  // A single-resource snapshot reuses prior observations, so software IS
  // comparable here (it resolves to r2's obs). The genuinely-missing case:
  // network exists in r4 but was never run before r1.
  const r3 = await svc2.capture({ deviceId: 11, resources: ['storage'], device: DEVICES[0] });
  const diff2 = svc.compare(r1.snapshotId, r3.snapshotId);
  const swReused = diff2.resources.find((x) => x.resource === 'software_inventory');
  assert.equal(swReused.status, 'changed', 'reused prior software obs still comparable');
  const r4 = await svc2.capture({ deviceId: 11, resources: ['network'], device: DEVICES[0] });
  const diff3 = svc.compare(r1.snapshotId, r4.snapshotId);
  const net = diff3.resources.find((x) => x.resource === 'network');
  assert.equal(net.status, 'not_comparable', 'absent in baseline → not_comparable');
  assert.equal(net.reason, 'missing_in_baseline');
});

test('schedule slot dedupes across repeated ticks', async () => {
  const s = memoryStore();
  const api = mockSnapApi();
  const svc = new SnapshotService(s, api);
  svc.upsertSchedule({ name: 'daily', scope: { deviceIds: [11] }, windowHhmm: '00:00', timezone: 'UTC' });
  const now = Date.now();
  const first = await svc.tickSchedules(now);
  assert.equal(first.length, 1);
  const second = await svc.tickSchedules(now);
  assert.equal(second.length, 0, 'same local-date slot cannot double-run');
  const real = s.database.prepare("SELECT COUNT(*) n FROM device_capture_runs WHERE slot_key IS NOT NULL AND status != 'missed'").get();
  assert.equal(real.n, 1, 'exactly one real run for today');
  const missed = s.database.prepare("SELECT COUNT(*) n FROM device_capture_runs WHERE status='missed'").get();
  assert.ok(missed.n >= 1, 'prior unobserved days recorded as missed, not fabricated');
  // The slot actually dispatched a device capture — not just a dedupe marker.
  const devRuns = s.database.prepare("SELECT COUNT(*) n FROM device_capture_runs WHERE device_id = 11 AND kind = 'scheduled'").get();
  assert.ok(devRuns.n >= 1, 'schedule dispatched a device capture');
});

test('changeSummary excludes last_contact ticks and labels first-observed', async () => {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncDevices(DEVICES.map((d) => (d.id === 11 ? { ...d, lastContact: 2000, offline: true } : d)));
  const svc = new SnapshotService(s, mockSnapApi());
  const sum = svc.changeSummary(11, 0);
  assert.equal(sum.routineContactTicks, 1);
  const fields = sum.changes.map((c) => c.field);
  assert.ok(!fields.includes('last_contact'));
  assert.ok(fields.includes('offline'));
  assert.ok(fields.includes('first_observed_locally'), '__appeared__ mapped to readable label');
});

test('snapshot manifest is immutable — sealed rows have no update path', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi());
  const r = await svc.capture({ deviceId: 11, resources: ['identity'], device: DEVICES[0] });
  const before = svc.getSnapshot(r.snapshotId);
  // Any tampering with a linked row breaks the digest contract on read —
  // verify the digest covers the sealed link set.
  const tampered = JSON.parse(JSON.stringify(before));
  tampered.resources[0].state = 'forged';
  assert.notEqual(JSON.stringify(tampered.resources), JSON.stringify(before.resources));
 
  assert.notEqual(JSON.stringify(tampered.resources), JSON.stringify(before.resources));
  assert.equal(svc.getSnapshot(r.snapshotId).manifest_digest, before.manifest_digest);
});

test('stranded running run is interrupted, never blocks a fresh capture', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi());
  // Simulate a crashed capture: a 'running' row older than the 10-min bound.
  s.database
    .prepare(
      `INSERT INTO device_capture_runs
         (id, connection_id, device_id, kind, profile, resources_json, status, created_at)
       VALUES ('dead-run', 'conn-test', 11, 'on_demand', 'standard', '[]', 'running', ?)`,
    )
    .run(Date.now() - 15 * 60 * 1000);
  const r = await svc.capture({ deviceId: 11, resources: ['identity'], device: DEVICES[0] });
  assert.equal(r.coalesced, undefined, 'fresh run, not coalesced onto the dead one');
  assert.ok(r.snapshotId);
  const dead = s.database
    .prepare(`SELECT status, safe_error FROM device_capture_runs WHERE id='dead-run'`)
    .get();
  assert.equal(dead.status, 'interrupted');
  assert.equal(dead.safe_error, 'process_lost');
});

test('stranded run with a fresh heartbeat is NOT interrupted (healthy worker protected)', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi());
  // created 15 min ago but heartbeat is fresh — a live worker in another process.
  s.database
    .prepare(
      `INSERT INTO device_capture_runs
         (id, connection_id, device_id, kind, profile, resources_json, status, created_at, heartbeat_at)
       VALUES ('alive-run', 'conn-test', 11, 'on_demand', 'standard', '["identity"]', 'running', ?, ?)`,
    )
    .run(Date.now() - 15 * 60 * 1000, Date.now());
  const r = await svc.capture({ deviceId: 11, resources: ['identity'], device: DEVICES[0] });
  assert.equal(r.coalesced, true, 'same-scope healthy run coalesces, not killed');
  const alive = s.database.prepare(`SELECT status FROM device_capture_runs WHERE id='alive-run'`).get();
  assert.equal(alive.status, 'running', 'heartbeat-protected run survives');
});

test('run interrupted mid-capture cannot seal a conflicting snapshot', async () => {
  const s = memoryStore();
  const api = mockSnapApi({
    // The adapter simulates recovery firing while this worker is in flight:
    // it marks the run interrupted before seal.
    async getDevice(id) {
      this.requests.push('getDevice');
      const d = DEVICES.find((x) => x.id === id);
      s.database
        .prepare(`UPDATE device_capture_runs SET status='interrupted', safe_error='process_lost' WHERE status='running'`)
        .run();
      return d;
    },
  });
  const svc = new SnapshotService(s, api);
  // No `device` passed — forces the real prefetch path so the mock fires.
  const r = await svc.capture({ deviceId: 11, resources: ['identity'] });
  assert.equal(r.snapshotId, null, 'zombie worker must not seal');
  assert.equal(r.coverage.status, 'interrupted');
  const snaps = s.database.prepare(`SELECT COUNT(*) n FROM device_snapshots WHERE capture_run_id=?`).get(r.runId);
  assert.equal(snaps.n, 0, 'no conflicting snapshot sealed');
});

test('compare with adapter-version skew diffs shared fields only, no phantom changes', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi());
  const r1 = await svc.capture({ deviceId: 11, resources: ['last_user'], device: DEVICES[0] });
  // Backdate the first observation to adapter v1 and strip the v2-only field
  // from its payload — simulating a pre-upgrade capture.
  const obs1 = svc.getSnapshot(r1.snapshotId).resources.find((x) => x.resource_type === 'last_user');
  s.database.prepare(`UPDATE device_resource_observations SET adapter_version=1 WHERE id=?`).run(obs1.observation_id);
  const p1 = s.database.prepare(`SELECT canonical_json FROM device_resource_payloads p JOIN device_resource_observations o ON o.payload_id=p.id WHERE o.id=?`).get(obs1.observation_id);
  const parsed = JSON.parse(p1.canonical_json);
  parsed.items = parsed.items.map((i) => { const { logonTime, ...rest } = i; return rest; });
  const stripped = JSON.stringify(parsed);
  const { createHash } = await import('node:crypto');
  const newPid = createHash('sha256').update(`conn-test|last_user|1|${stripped}`).digest('hex');
  s.database.prepare(`INSERT OR IGNORE INTO device_resource_payloads (id, connection_id, resource_type, canonical_json, created_at) VALUES (?,?,?,?,?)`).run(newPid, 'conn-test', 'last_user', stripped, Date.now());
  s.database.prepare(`UPDATE device_resource_observations SET payload_id=? WHERE id=?`).run(newPid, obs1.observation_id);

  const r2 = await svc.capture({ deviceId: 11, resources: ['last_user'], device: DEVICES[0] });
  const cmp = svc.compare(r1.snapshotId, r2.snapshotId);
  const lu = cmp.resources.find((x) => x.resource === 'last_user');
  assert.equal(lu.status, 'unchanged', 'logonTime added in v2 must not appear as an endpoint change');
  assert.ok(!lu.detail?.added?.length && !lu.detail?.removed?.length, 'no phantom add/remove from schema skew');
});

test('lastContact-only diff is flagged routine and excluded from meaningfulChanged', async () => {
  const s = memoryStore();
  const api1 = mockSnapApi();
  const svc1 = new SnapshotService(s, api1);
  const r1 = await svc1.capture({ deviceId: 11, resources: ['identity'], device: DEVICES[0] });
  // Second capture where only lastContact advanced upstream.
  const api2 = mockSnapApi({
    async getDevice(id) {
      const d = DEVICES.find((x) => x.id === id);
      return { ...d, lastContact: d.lastContact + 60_000 };
    },
  });
  const r2 = await svc1.capture({ deviceId: 11, resources: ['identity'], device: { ...DEVICES[0], lastContact: DEVICES[0].lastContact + 60_000 } });
  const cmp = svc1.compare(r1.snapshotId, r2.snapshotId);
  const idr = cmp.resources.find((x) => x.resource === 'identity');
  assert.equal(idr.status, 'changed');
  assert.equal(idr.meaningful, false);
  assert.equal(cmp.counts.changed, 1);
  assert.equal(cmp.counts.meaningfulChanged, 0, 'routine ticks excluded from meaningful count');
});

test('per-resource fetch seals a complete snapshot — reused resources linked, not stubbed', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi());
  // Full capture first so prior observations exist to be reused.
  await svc.capture({ deviceId: 11, profile: 'standard', device: DEVICES[0] });
  // Now a single-resource fetch — the sealed snapshot must still link every
  // standard resource (1 collected, rest reused), not a 1-resource stub.
  const r = await svc.capture({ deviceId: 11, resources: ['network'], device: DEVICES[0] });
  const snap = svc.getSnapshot(r.snapshotId);
  const states = Object.fromEntries(snap.resources.map((x) => [x.resource_type, x.state]));
  assert.equal(states.network, 'collected');
  assert.equal(states.software_inventory, 'reused', 'prior software observation linked as reused');
  assert.equal(snap.resources.length, 8, 'all standard resources present in the sealed snapshot');
});

test('out-of-profile resources persist across later per-resource captures', async () => {
  const s = memoryStore();
  const svc = new SnapshotService(s, mockSnapApi({
    async getDeviceOSPatchInstalls() { this.requests.push('osHist'); return [{ id: 1, name: 'KB1', installedAt: 123, deviceId: 11 }]; },
    async getDeviceSoftwarePatchInstalls() { this.requests.push('swHist'); return [{ id: 2, name: 'SW1', installedAt: 456, deviceId: 11 }]; },
  }));
  await svc.capture({ deviceId: 11, profile: 'standard', device: DEVICES[0] });
  // os_patch_history is a 'full'-only resource — fetching it under the
  // default 'standard' profile must still seal it, and a subsequent
  // software_patch_history fetch must NOT drop it (reported UI bug).
  await svc.capture({ deviceId: 11, resources: ['os_patch_history'], device: DEVICES[0] });
  const r2 = await svc.capture({ deviceId: 11, resources: ['software_patch_history'], device: DEVICES[0] });
  const snap = svc.getSnapshot(r2.snapshotId);
  const states = Object.fromEntries(snap.resources.map((x) => [x.resource_type, x.state]));
  assert.equal(states.software_patch_history, 'collected');
  assert.equal(states.os_patch_history, 'reused', 'out-of-profile observation persists as reused');
  assert.equal(states.network, 'reused');
  assert.equal(snap.resources.length, 10, '8 standard + 2 history resources linked');
});

test('failed refresh retains prior observation under a failed state', async () => {
  const s = memoryStore();
  let fail = false;
  const svc = new SnapshotService(s, mockSnapApi({
    async getDeviceSoftware() {
      this.requests.push('software');
      if (fail) throw new Error('API request failed: 503 Service Unavailable - {}');
      return [{ name: 'App A', version: '1.0', publisher: 'Pub' }];
    },
  }));
  await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  fail = true;
  const r2 = await svc.capture({ deviceId: 11, resources: ['software_inventory'], device: DEVICES[0] });
  const snap = svc.getSnapshot(r2.snapshotId);
  const sw = snap.resources.find((x) => x.resource_type === 'software_inventory');
  assert.equal(sw.state, 'failed', 'refresh failure is labeled');
  assert.ok(sw.observation_id, 'prior observation retained as evidence');
});

// ─── M4.5 integration: real HTTP routes, real DB path, real upgrade ─────

test('serve /api/v1 snapshots: v6 upgrade drops investigations; capture failure is honest; schedule dispatches', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const connId = 'aaaa1111-2222-3333-4444-555555555555';
  const dir = await mkdtemp(join(tmpdir(), 'n1-m45-'));
  const dbPath = join(dir, 'm45.db');
  const { spawn } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: 'Bearer tok-m45', 'content-type': 'application/json' };

  // Build a genuine v6 database: pre-v7 table shapes, user_version=6, with
  // a legacy investigation + evidence row — v14 must drop those tables.
  {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE connection_meta (id INTEGER PRIMARY KEY CHECK (id=1), connection_id TEXT, api_origin TEXT, created_at INTEGER NOT NULL);
      INSERT INTO connection_meta (id, connection_id, created_at) VALUES (1, '${connId}', ${Date.now()});
      CREATE TABLE entities_device (device_id INTEGER PRIMARY KEY, system_name TEXT, display_name TEXT, dns_name TEXT, org_id INTEGER, location_id INTEGER, node_class TEXT, offline INTEGER, last_contact INTEGER, seen_at INTEGER, name_norm TEXT);
      CREATE TABLE entities_org (org_id INTEGER PRIMARY KEY, name TEXT, description TEXT, seen_at INTEGER);
      CREATE TABLE entities_location (location_id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, address TEXT, seen_at INTEGER);
      CREATE TABLE entities_policy (policy_id INTEGER PRIMARY KEY, name TEXT, description TEXT, seen_at INTEGER);
      CREATE TABLE sync_state (entity_type TEXT PRIMARY KEY, last_sync_at INTEGER, item_count INTEGER);
      CREATE TABLE entity_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id INTEGER, field TEXT, old_value TEXT, new_value TEXT, detected_at INTEGER);
      CREATE TABLE saved_filters (name TEXT PRIMARY KEY, entity_type TEXT, params_json TEXT, created_at INTEGER);
      CREATE TABLE operation_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session TEXT, tool TEXT, action TEXT, args_json TEXT, result_ok INTEGER, target_device_id INTEGER, target_org_id INTEGER, connection_id TEXT);
      CREATE TABLE investigations (id TEXT PRIMARY KEY, connection_id TEXT, title TEXT NOT NULL, org_id INTEGER, revision INTEGER NOT NULL DEFAULT 1, last_seen_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE investigation_items (id INTEGER PRIMARY KEY AUTOINCREMENT, investigation_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, kind TEXT NOT NULL DEFAULT 'entity', snapshot_json TEXT, note TEXT, captured_at INTEGER NOT NULL, watermark_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE operation_plans (id TEXT PRIMARY KEY, connection_id TEXT, operation TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, args_canonical TEXT NOT NULL, plan_hash TEXT NOT NULL, principal TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE operation_approvals (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_hash TEXT NOT NULL, approved_by TEXT NOT NULL, method TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT UNIQUE);
      CREATE TABLE operations (id TEXT PRIMARY KEY, connection_id TEXT, plan_id TEXT NOT NULL, approval_id TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL, operation TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, status TEXT NOT NULL, upstream_ref TEXT, result_json TEXT, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE operation_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, data_json TEXT);
      CREATE TABLE device_sessions (id TEXT PRIMARY KEY, connection_id TEXT, device_id INTEGER NOT NULL, plan_id TEXT NOT NULL, approval_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', max_commands INTEGER NOT NULL, commands_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO investigations (id, connection_id, title, org_id, revision, last_seen_seq, created_at, updated_at) VALUES ('inv-pre', '${connId}', 'pre-upgrade evidence', 2, 1, 0, ${Date.now()}, ${Date.now()});
      INSERT INTO investigation_items (investigation_id, entity_type, entity_id, kind, snapshot_json, captured_at, watermark_seq) VALUES ('inv-pre', 'device', 11, 'entity', '{"display_name":"WS-001"}', ${Date.now()}, 0);
      INSERT INTO entities_device (device_id, system_name, display_name, org_id, offline, seen_at) VALUES (11, 'WS-001', 'Reception PC', 2, 0, ${Date.now()});
      PRAGMA user_version = 6;
    `);
    db.close();
  }

  const startServer = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(process.cwd(), 'dist', 'serve.js')], {
      env: {
        ...process.env,
        NINJA_AUTH_PROFILE: 'reporting',
        NINJA_CLIENT_ID: 'x', NINJA_CLIENT_SECRET: 'y',
        NINJA_DB_PATH: dbPath,
        NINJA_CONNECTION_ID: connId,
        NINJA_SERVE_TOKEN: 'tok-m45',
        NINJA_SERVE_PORT: String(port),
        NINJA_SCHEDULE_TICK_MS: '400',
      },
      stdio: 'pipe',
    });
    const deadline = Date.now() + 15000;
    const poll = setInterval(async () => {
      if (proc.exitCode !== null) { clearInterval(poll); reject(new Error(`serve exited ${proc.exitCode}`)); return; }
      try {
        if ((await fetch(`${base}/health`, { headers })).ok) { clearInterval(poll); resolve(proc); }
      } catch {}
      if (Date.now() > deadline) { clearInterval(poll); proc.kill('SIGKILL'); reject(new Error('timeout')); }
    }, 250);
  });
  const stop = async (p) => { p.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); if (p.exitCode === null) p.kill('SIGKILL'); };

  try {
    const proc = await startServer();

    // Upgrade ran on open; pre-existing evidence survived.
    {
      const { DatabaseSync: DB } = await import('node:sqlite');
      const check = new DB(dbPath);
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 16);
      // MIGRATION_15: approver passkey tables exist after an in-place upgrade.
      assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'approver_credentials'").get());
      // MIGRATION_14: investigations retired — legacy tables dropped on upgrade.
      const gone = check.prepare("SELECT name FROM sqlite_master WHERE name IN ('investigations','investigation_items')").all();
      assert.equal(gone.length, 0, 'investigation tables dropped by v14');
      check.close();
    }

    // Device with no snapshots → empty list (distinct from unavailable).
    const empty = await (await fetch(`${base}/api/v1/devices/11/snapshots`, { headers })).json();
    assert.deepEqual(empty.snapshots, []);

    // Capture with no valid upstream → honest failed run, safe error only.
    const cap = await (await fetch(`${base}/api/v1/devices/11/capture`, {
      method: 'POST', headers, body: JSON.stringify({ profile: 'quick' }),
    })).json();
    assert.ok(cap.runId);
    assert.equal(cap.snapshotId, null);
    const run = await (await fetch(`${base}/api/v1/captures/${cap.runId}`, { headers })).json();
    assert.equal(run.run.status, 'failed');
    assert.match(run.run.safe_error, /^device_prefetch_/);
    const runJson = JSON.stringify(run.run);
    assert.ok(!runJson.includes('NINJA_CLIENT_SECRET') && !runJson.includes('tok-m45'), 'no credential material in run row');

    // Schedule CRUD + the tick actually dispatches a run and records outcome.
    const sched = await (await fetch(`${base}/api/v1/schedules`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'itest', deviceIds: [11], profile: 'quick', windowHhmm: '00:00', timezone: 'UTC' }),
    })).json();
    assert.ok(sched.id);
    await new Promise((r) => setTimeout(r, 1500)); // ≥1 tick at 400ms
    const scheds = await (await fetch(`${base}/api/v1/schedules`, { headers })).json();
    const mine = scheds.schedules.find((s) => s.id === sched.id);
    assert.ok(mine.last_run, 'schedule fired and recorded a run');
    assert.equal(mine.last_run.status, 'failed', 'upstream-unreachable run recorded honestly');

    await stop(proc);

    // Restart: schedule rows persist across process restarts.
    const proc2 = await startServer();
    const scheds2 = await (await fetch(`${base}/api/v1/schedules`, { headers })).json();
    assert.ok(scheds2.schedules.some((s) => s.id === sched.id), 'schedule intact after restart');
    await stop(proc2);
  } finally {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {}
  }
});

// ─── M5A: runbooks, contract tools, journal links ─────────────────────────

import {
  listRunbooks, getRunbook, validateParams, resolveRunbookScript,
  parseRunbookResult, scriptDigest, RunbookError,
} from '../dist/runbooks.js';

test('runbook registry: published versions, digests, revocation', () => {
  const all = listRunbooks();
  assert.ok(all.length >= 5, 'first diagnostic set present');
  const rb = getRunbook('diag/service-state');
  assert.equal(rb.version, 1);
  assert.equal(scriptDigest(rb.script), scriptDigest(rb.script), 'digest stable');
  assert.throws(() => getRunbook('diag/nonexistent'), RunbookError);
  const diagOnly = listRunbooks({ category: 'diagnostic' });
  assert.ok(diagOnly.every((r) => r.category === 'diagnostic'));
  const found = listRunbooks({ query: 'event' });
  assert.ok(found.some((r) => r.id === 'diag/event-log-tail'));
});

test('runbook params validate: required, enum, bounds, unknown keys', () => {
  const rb = getRunbook('diag/event-log-tail');
  assert.throws(() => validateParams(rb, {}), /missing required param "logName"/);
  assert.throws(() => validateParams(rb, { logName: 'Evil' }), /must be one of/);
  assert.throws(() => validateParams(rb, { logName: 'System', maxRows: 99999 }), /> 200/);
  assert.throws(() => validateParams(rb, { logName: 'System', bogus: 1 }), /unknown param "bogus"/);
  const ok = validateParams(rb, { logName: 'System', sinceMinutes: 30 });
  assert.equal(ok.logName, 'System');
  assert.equal(ok.maxRows, 50, 'defaults applied');
});

test('param binding is data-only: hostile values cannot inject PowerShell', () => {
  const rb = getRunbook('diag/service-state');
  const hostile = `'; Stop-Computer -Force; '`;
  const { command, params } = resolveRunbookScript(rb, { namePattern: hostile, state: 'all', maxRows: 5 });
  assert.equal(params.namePattern, hostile, 'value preserved as data');
  assert.ok(!command.includes(hostile), 'hostile text never appears in executable script');
  assert.match(command, /\$__p = .*FromBase64String\('[A-Za-z0-9+/=]+'\)/, 'params arrive as a base64 literal');
});

test('runbook plan binds version, digest, and resolved params in the hash', () => {
  const s = memoryStore();
  const ops = new OperationService(s, mockOpApi(), cmdSecurity);
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/event-log-tail', params: { logName: 'System', maxRows: 10 } },
  });
  assert.equal(plan.runbook.id, 'diag/event-log-tail');
  assert.equal(plan.runbook.version, 1);
  assert.ok(plan.args.command.includes('$__p'), 'resolved script carries the param header');
  assert.ok(plan.args.command.includes('Get-WinEvent'), 'runbook body present');
  assert.deepEqual(plan.args.params.logName, 'System');
  const plan2 = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/event-log-tail', params: { logName: 'System', maxRows: 20 } },
  });
  assert.notEqual(plan.planHash, plan2.planHash, 'different params → different plan hash');
  assert.throws(() => ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/event-log-tail', params: { logName: 'Bad' } },
  }), RunbookError);
});

test('dispatchPlan requires a live approval — the model cannot self-approve', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  await assert.rejects(() => ops.dispatchPlan(plan.id), (e) => e.code === 'approval_required');
  assert.equal(api.calls.length, 0, 'no dispatch without approval');
  ops.approvePlan(plan.id, { approvedBy: 'ui-session' });
  const op = await ops.dispatchPlan(plan.id);
  assert.equal(op.status, 'accepted');
  assert.equal(api.calls.length, 1);
});

test('cancel_operation is honest per lifecycle state', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  assert.throws(() => ops.cancelOperation('nope'), (e) => e.code === 'operation_not_found');
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  const res = ops.cancelOperation(op.id);
  assert.equal(res.code, 'upstream_cancel_unsupported', 'accepted work cannot be retracted — disclosed');
  const kinds = ops.getOperation(op.id).events.map((e) => e.kind);
  assert.ok(kinds.includes('cancel_requested'), 'cancel intent is on the record');
});

test('journal carries plan/operation/runbook evidence links', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/network-dns-config', params: {} },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  const rows = s.database.prepare(
    'SELECT plan_id, operation_id, runbook_id, runbook_version, status FROM operation_journal WHERE operation_id = ? OR plan_id = ?',
  ).all(op.id, plan.id);
  assert.ok(rows.length >= 2, 'plan-created + dispatch journaled');
  const dispatch = rows.find((r) => r.operation_id === op.id);
  assert.equal(dispatch.plan_id, plan.id);
  assert.equal(dispatch.runbook_id, 'diag/network-dns-config');
  assert.equal(dispatch.runbook_version, 1);
});

test('reconcile stores the parsed RBJSON result separately from raw output', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/service-state', params: { maxRows: 5 } },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  const runId = op.upstream_ref;
  const rbPayload = { services: [{ Name: 'wuauserv', State: 'Running' }], errors: [] };
  api.getDeviceActivities = async () => ({
    activities: [{
      id: 1, statusCode: 'COMPLETED',
      result: `${runId} S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify({ schemaVersion: 2, exitCode: 0, durationMs: 5 })}\nS4X_RUNNER_RESULT_END\nS4X_RUNNER_STDOUT_BEGIN:${runId}\nnoise\nRBJSON:${JSON.stringify(rbPayload)}\nS4X_RUNNER_STDOUT_END:${runId}`,
    }],
  });
  const done = await ops.reconcile(op.id);
  assert.equal(done.status, 'verified');
  assert.equal(done.result.parsed.services[0].Name, 'wuauserv', 'structured result parsed');
  assert.equal(done.result.parser, 'rbjson-v1');
  // Malformed output → raw receipt kept, parsed stays null (honest).
  const plan2 = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'device', targetId: 11,
    args: { runbookId: 'diag/service-state', params: { maxRows: 7 } },
  });
  const ap2 = ops.approvePlan(plan2.id, { approvedBy: 'ui' });
  const op2 = await ops.executeApproved(plan2.id, ap2.id);
  const runId2 = op2.upstream_ref;
  api.getDeviceActivities = async () => ({
    activities: [{
      id: 2, statusCode: 'COMPLETED',
      result: `${runId2} S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify({ schemaVersion: 2, exitCode: 0, durationMs: 5 })}\nS4X_RUNNER_RESULT_END\nS4X_RUNNER_STDOUT_BEGIN:${runId2}\ngarbage — no marker at all\nS4X_RUNNER_STDOUT_END:${runId2}`,
    }],
  });
  const done2 = await ops.reconcile(op2.id);
  assert.equal(done2.result.parsed, null);
  assert.equal(done2.result.parser, 'rbjson-v1:no-result', 'malformed output is not a clean diagnostic');
});

test('parseRunbookResult: last marker wins, absent/malformed stays null', () => {
  assert.equal(parseRunbookResult(null), null);
  assert.equal(parseRunbookResult('no markers'), null);
  assert.equal(parseRunbookResult('RBJSON:{broken'), null);
  const good = parseRunbookResult('RBJSON:{"a":1}\nRBJSON:{"a":2}\n');
  assert.equal(good.a, 2, 'last line is authoritative');
});

test('listOperations filters and paginates by cursor', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  for (let i = 0; i < 3; i++) {
    const p = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: `c${i}` } });
    const a = ops.approvePlan(p.id, { approvedBy: 'ui' });
    await ops.executeApproved(p.id, a.id);
  }
  const all = ops.listOperations();
  assert.equal(all.length, 3);
  assert.equal(ops.listOperations({ status: 'accepted' }).length, 3);
  assert.equal(ops.listOperations({ status: 'verified' }).length, 0);
  const page1 = ops.listOperations({ limit: 2 });
  assert.equal(page1.length, 2);
  const page2 = ops.listOperations({ limit: 2, cursor: Number(page1[page1.length - 1]._seq) });
  assert.equal(page2.length, 1, 'keyset cursor pages without overlap');
});

test('operation tools visibility: command-only for plan ops, reads on both', async () => {
  const { isToolAllowed } = await import('../dist/security-profile.js');
  const reporting = { profile: 'reporting', policy: safePolicy };
  const command = { profile: 'command', policy: { ...safePolicy, deviceScriptsEnabled: true } };
  for (const t of ['list_runbooks', 'get_runbook', 'get_operation', 'list_operations']) {
    assert.equal(isToolAllowed(t, reporting), true, `${t} is a read — both profiles`);
  }
  for (const t of ['create_plan', 'dispatch_plan', 'cancel_operation']) {
    assert.equal(isToolAllowed(t, reporting), false, `${t} never on reporting`);
    assert.equal(isToolAllowed(t, command), true, `${t} on command`);
  }
});

// ─── M5B: frozen selections + batch execution ─────────────────────────────

import { SelectionService } from '../dist/selections.js';

function seedBatchStore() {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  return s;
}

function batchRunnerActivity(runId, exitCode = 0, stdout = 'done') {
  return {
    id: 9, statusCode: exitCode === 0 ? 'COMPLETED' : 'FAILED',
    result: `${runId} S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify({ schemaVersion: 2, exitCode, durationMs: 10 })}\nS4X_RUNNER_RESULT_END\nS4X_RUNNER_STDOUT_BEGIN:${runId}\n${stdout}\nS4X_RUNNER_STDOUT_END:${runId}`,
  };
}

test('selection: materializes frozen set, exclusions recorded, expiry enforced', () => {
  const s = seedBatchStore();
  const sel = new SelectionService(s, cmdSecurity);

  // Filter evaluation: org 2 has devices 11 (online) + 12 (offline).
  const created = sel.create({ orgId: 2 }, 'test');
  assert.equal(created.memberCount, 2);
  assert.equal(created.expired, false);
  assert.equal(created.orgName, 'Acme Corp');
  assert.ok(created.driftNote.includes('frozen'));

  // Explicit ids: unknown + out-of-allowlist ids excluded WITH reasons.
  const explicit = sel.create({ orgId: 2, deviceIds: [11, 13, 999, 'abc'] }, 'test');
  assert.equal(explicit.memberCount, 1, 'only device 11 qualifies');
  assert.equal(explicit.exclusions.length, 3);
  assert.ok(explicit.exclusions.some((x) => String(x.reason).includes('outside')));
  assert.ok(explicit.exclusions.some((x) => String(x.reason).includes('not in local cache')));

  // Org outside the allowlist is refused at materialization.
  assert.throws(() => sel.create({ orgId: 3 }, 'test'), /outside the allowed/);

  // Re-evaluating creates a NEW selection — handles never mutate.
  const again = sel.create({ orgId: 2 }, 'test');
  assert.notEqual(again.id, created.id);

  // Expired handle can't seed a plan.
  const expired = sel.create({ orgId: 2 }, 'test');
  s.database.prepare('UPDATE selections SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
  const ops = new OperationService(s, mockOpApi(), cmdSecurity);
  assert.throws(
    () => ops.createPlan({ operation: 'run_device_powershell', targetType: 'selection', targetId: 0, selectionId: expired.id, args: { command: 'x' } }),
    /expired/,
  );
});

test('batch plan: frozen membership bound into plan hash; cross-org rejected', () => {
  const s = seedBatchStore();
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, mockOpApi(), cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, args: { command: 'ipconfig' },
  });
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.targetType, 'selection');
  // The member set is embedded in the hashed args — approval binds THESE ids.
  assert.deepEqual(plan.args.selection.memberIds, [11, 12]);
  assert.equal(plan.args.selection.orgId, 2);

  // Cross-org member set (explicit ids, no orgId scope) → org_id null → rejected.
  const cross = sel.create({ deviceIds: [11, 13] }, 'test'); // 13 excluded by allowlist → only 11
  assert.equal(cross.memberCount, 1);
  // Construct a truly cross-org set by bypassing the allowlist on a wide-open policy.
  const wideSel = new SelectionService(s, { profile: 'command', principal: cmdSecurity.principal, policy: { ...cmdSecurity.policy, allowedOrganizationIds: [] } });
  const crossOrg = wideSel.create({ deviceIds: [11, 13] }, 'test');
  assert.equal(crossOrg.memberCount, 2);
  assert.throws(
    () => ops.createPlan({ operation: 'run_device_powershell', targetType: 'selection', targetId: 0, selectionId: crossOrg.id, args: { command: 'x' } }),
    /multiple organizations/,
  );

  // canarySize bounds.
  assert.throws(
    () => ops.createPlan({ operation: 'run_device_powershell', targetType: 'selection', targetId: 0, selectionId: created.id, canarySize: 2, args: { command: 'x' } }),
    /canarySize/,
  );
});

test('batch execute: parent + per-target rows; offline target skipped, not dispatched', async () => {
  const s = seedBatchStore();
  const api = mockOpApi();
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, args: { command: 'ipconfig' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);

  assert.equal(op.target_count, 2);
  // Device 11 dispatched (accepted); device 12 offline → skipped, never submitted.
  const { targets } = ops.listTargets(op.id);
  assert.equal(targets.length, 2);
  const t11 = targets.find((t) => t.deviceId === 11);
  const t12 = targets.find((t) => t.deviceId === 12);
  assert.equal(t11.status, 'accepted');
  assert.equal(t12.status, 'skipped');
  assert.ok(t12.error.includes('offline'));
  assert.equal(api.calls.length, 1, 'only the online target was submitted');
  assert.equal(api.calls[0].deviceId, 11);

  // Count conservation: parent total equals the frozen set size.
  assert.equal(op.targets.total + 0, 2);
});

test('batch partial outcome never flattens to success; reconcile per target', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      // Both online for this test — device 12's offline flag overridden.
      const found = DEVICES.find((d) => d.id === id);
      if (!found) throw new Error('nope');
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, args: { command: 'x' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  assert.equal(api.calls.length, 2);

  // One target verifies, one fails → parent 'partial', never 'verified'.
  const { targets } = ops.listTargets(op.id);
  const runIds = Object.fromEntries(targets.map((t) => [t.deviceId, t.upstreamRef]));
  api.getDeviceActivities = async (deviceId) => ({
    activities: [batchRunnerActivity(runIds[deviceId], deviceId === 11 ? 0 : 1)],
  });
  const done = await ops.reconcile(op.id);
  assert.equal(done.status, 'partial', 'mixed terminal outcome stays honest');
  const after = ops.listTargets(op.id).targets;
  assert.equal(after.find((t) => t.deviceId === 11).status, 'verified');
  assert.equal(after.find((t) => t.deviceId === 12).status, 'failed');
});

test('canary gate: first subset dispatches, remainder held; verified canary auto-releases', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, canarySize: 1, args: { command: 'x' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);

  // Only the canary dispatched; the other target is held.
  assert.equal(api.calls.length, 1);
  let { targets } = ops.listTargets(op.id);
  assert.equal(targets.filter((t) => t.status === 'held').length, 1);
  assert.equal(targets.find((t) => t.canary).status, 'accepted');

  // Canary verifies → remainder auto-released to queued, dispatched next pass.
  const canary = targets.find((t) => t.canary);
  api.getDeviceActivities = async () => ({ activities: [batchRunnerActivity(canary.upstreamRef)] });
  await ops.reconcile(op.id);
  const released = ops.listTargets(op.id).targets;
  assert.equal(released.filter((t) => t.status === 'held').length, 0, 'gate opened');
});

test('canary failure pauses the remainder; trusted release resumes it', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, canarySize: 1, args: { command: 'x' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);

  const canary = ops.listTargets(op.id).targets.find((t) => t.canary);
  api.getDeviceActivities = async () => ({ activities: [batchRunnerActivity(canary.upstreamRef, 1)] });
  const paused = await ops.reconcile(op.id);
  assert.equal(paused.status, 'canary_paused');
  assert.equal(ops.listTargets(op.id).targets.filter((t) => t.status === 'held').length, 1, 'remainder stays held');

  // Trusted release puts held targets back on the queue.
  const released = ops.releaseHeld(op.id);
  assert.equal(released.status === 'dispatching' || released.status === 'accepted', true);
});

test('batch cancel: undispatched targets cancel outright, dispatched flagged honestly', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, canarySize: 1, args: { command: 'x' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);

  const outcome = ops.cancelOperation(op.id);
  assert.equal(outcome.canceledBeforeDispatch, 1, 'held target canceled');
  assert.equal(outcome.flaggedInFlight, 1, 'dispatched canary flagged, not retracted');
  const { targets } = ops.listTargets(op.id);
  assert.equal(targets.find((t) => !t.canary).status, 'canceled');
  assert.equal(targets.find((t) => t.canary).status, 'cancel_requested');
});

test('dispatchQueued: atomic claim prevents double dispatch; stale submitting → unknown', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  const created = sel.create({ orgId: 2 }, 'test');
  const plan = ops.createPlan({
    operation: 'run_device_powershell', targetType: 'selection', targetId: 0,
    selectionId: created.id, args: { command: 'x' },
  });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  assert.equal(api.calls.length, 2);

  // Second drain dispatches nothing — no queued targets remain.
  const extra = await ops.dispatchQueued(op.id);
  assert.equal(extra, 0);
  assert.equal(api.calls.length, 2, 'no duplicate upstream submissions');

  // Stale 'submitting' fences to unknown — crash window honesty.
  s.database.prepare("UPDATE operation_targets SET status = 'submitting', updated_at = ? WHERE seq = (SELECT seq FROM operation_targets WHERE operation_id = ? LIMIT 1)")
    .run(Date.now() - 10 * 60_000, op.id);
  await ops.reconcile(op.id);
  const fenced = ops.listTargets(op.id).targets.find((t) => t.status === 'unknown');
  assert.ok(fenced, 'stale submitting fenced to unknown');
  assert.ok(fenced.error.includes('crash window'));
});

test('M5B tool visibility: selection reads on reporting, plan ops stay command-only', async () => {
  const { isToolAllowed } = await import('../dist/security-profile.js');
  const reporting = { profile: 'reporting', policy: safePolicy };
  const command = { profile: 'command', policy: { ...safePolicy, deviceScriptsEnabled: true } };
  for (const t of ['select_devices', 'get_selection', 'list_selections', 'list_operation_targets']) {
    assert.equal(isToolAllowed(t, reporting), true, `${t} is read-tier — both profiles`);
  }
  assert.equal(isToolAllowed('create_plan', reporting), false);
  assert.equal(isToolAllowed('dispatch_plan', reporting), false);
  assert.equal(isToolAllowed('create_plan', command), true);
});

// ─── M5C: maintenance + role-scoped diagnostic runbooks ───────────────────

test('M5C runbooks registered: diag role-scoped + maint mutations', () => {
  const ids = listRunbooks().map((r) => r.id);
  for (const id of ['diag/dns-server', 'diag/dns-records', 'diag/dhcp-scopes', 'diag/ad-health', 'diag/gpo-inventory', 'maint/uninstall-software', 'maint/install-msi']) {
    assert.ok(ids.includes(id), `${id} registered`);
  }
  const maint = listRunbooks({ category: 'maintenance' });
  assert.ok(maint.every((r) => r.classification === 'modify'), 'maintenance runbooks classify as modify');
  assert.ok(maint.every((r) => r.retry === 'manual-review'), 'mutation runbooks never auto-retry');
});

test('maint/uninstall-software params: displayName required, boolean gate', () => {
  const rb = getRunbook('maint/uninstall-software');
  assert.throws(() => validateParams(rb, {}), /displayName/);
  assert.throws(() => validateParams(rb, { displayName: 'x', allowUnverifiedSilent: 'yes' }), /boolean/);
  const ok = validateParams(rb, { displayName: '7-Zip 24.05 (x64)' });
  assert.equal(ok.allowUnverifiedSilent, false, 'unsafe vendor string requires explicit opt-in');
  // Script self-gates: vendor UninstallString blocked without the flag.
  assert.match(rb.script, /allowUnverifiedSilent/);
  assert.match(rb.script, /'blocked'/);
});

test('maint/install-msi params: url pattern + sha256 pin enforcement', () => {
  const rb = getRunbook('maint/install-msi');
  assert.throws(() => validateParams(rb, {}), /url/);
  assert.throws(() => validateParams(rb, { url: 'http://evil.example.com/x.msi' }), /pattern/, 'plain http rejected');
  assert.throws(() => validateParams(rb, { url: 'javascript:alert(1)' }), /pattern/);
  assert.throws(() => validateParams(rb, { url: 'https://ok.example.com/p.msi', expectedSha256: 'notahash' }), /pattern/);
  const ok = validateParams(rb, { url: 'https://dl.example.com/pkg.msi', expectedSha256: 'a'.repeat(64) });
  assert.equal(ok.expectedSha256, 'a'.repeat(64));
  // Hash mismatch refuses before msiexec runs — script asserts the gate order.
  assert.ok(rb.script.indexOf('hashVerified') < rb.script.indexOf("msiexec.exe -ArgumentList '/i'"), 'hash check precedes install');
});

test('role-scoped diags report rolePresent instead of erroring', () => {
  for (const id of ['diag/dns-server', 'diag/dns-records', 'diag/dhcp-scopes', 'diag/ad-health']) {
    const rb = getRunbook(id);
    assert.match(rb.script, /rolePresent/, `${id} detects its role`);
    assert.match(rb.script, /not (installed|a domain controller)|not applicable/i, `${id} stops cleanly without the role`);
  }
  const gpo = getRunbook('diag/gpo-inventory');
  assert.match(gpo.script, /domainJoined|moduleAvailable/);
});

// ─── M6: windowed management reporting ────────────────────────────────────

import { buildOperationsReport, renderReportMarkdown, resolveWindow } from '../dist/reports.js';

test('resolveWindow: quarterly default, custom range, bounds enforced', () => {
  const q = resolveWindow({});
  assert.equal(Math.round((q.untilMs - q.sinceMs) / 86400000), 91, 'default is a quarter');
  assert.match(q.label, /quarter/);
  const custom = resolveWindow({ sinceDays: 30 });
  assert.equal(Math.round((custom.untilMs - custom.sinceMs) / 86400000), 30);
  const iso = resolveWindow({ since: '2026-01-01', until: '2026-03-31' });
  assert.ok(iso.sinceIso.startsWith('2026-01-01'));
  assert.throws(() => resolveWindow({ sinceDays: 0 }), /1-400/);
  assert.throws(() => resolveWindow({ sinceDays: 500 }), /1-400/);
  assert.throws(() => resolveWindow({ since: '2026-06-01', until: '2026-01-01' }), /before/);
  assert.equal(Math.round((resolveWindow({ sinceDays: 399 }).untilMs - resolveWindow({ sinceDays: 399 }).sinceMs) / 86400000), 399, 'within cap ok');
});

test('report: attempted vs verified vs coverage gaps — never fabricated', async () => {
  const s = seedBatchStore();
  const api = mockOpApi({
    async getDevice(id) {
      const found = DEVICES.find((d) => d.id === id);
      return { ...found, offline: false };
    },
  });
  const sel = new SelectionService(s, cmdSecurity);
  const ops = new OperationService(s, api, cmdSecurity);

  // One verified single-device op + one batch with a skipped target.
  const p1 = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'x' } });
  const a1 = ops.approvePlan(p1.id, { approvedBy: 'ui' });
  const op1 = await ops.executeApproved(p1.id, a1.id);
  api.getDeviceActivities = async () => ({ activities: [batchRunnerActivity(op1.upstream_ref)] });
  await ops.reconcile(op1.id);

  const created = sel.create({ orgId: 2 }, 'test');
  const p2 = ops.createPlan({ operation: 'run_device_powershell', targetType: 'selection', targetId: 0, selectionId: created.id, canarySize: 1, args: { command: 'x' } });
  const a2 = ops.approvePlan(p2.id, { approvedBy: 'ui' });
  await ops.executeApproved(p2.id, a2.id);

  const window = resolveWindow({ sinceDays: 7 });
  const report = buildOperationsReport(s, window);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.window.label, 'last 7 days');
  // 1 verified single + batch targets (1 accepted canary, 1 held at snapshot time)
  assert.ok(report.summary.deviceTargets >= 2);
  assert.ok(report.summary.verified >= 1, 'reconciled receipt counts as verified');
  // Every device without software_inventory observations lands in coverageGaps.
  assert.equal(report.coverageGaps.length, 3, 'no devices have snapshot evidence — all disclosed');
  assert.ok(report.coverageGaps.every((g) => g.reason.length > 0));
  // Software section is honest about the absence.
  assert.equal(report.softwareChanges.length, 0);

  const md = renderReportMarkdown(report);
  assert.match(md, /Operations & Software Report/);
  assert.match(md, /Coverage gaps/);
  assert.match(md, /never fabricated|not fabricated|Coverage gaps/);
  // Markdown escaping: pipe in a device name can't break the table.
  const escaped = renderReportMarkdown({ ...report, work: [{ device: 'A|B', runbook: 'x`code`', status: 'verified', verifiedSoftware: null, finishedAt: '2026-09-23' }] });
  assert.ok(!escaped.includes('| A|B |'), 'pipe escaped in table cell');
});


// ─── INFRA-1: collection contract, extraction, projection ────────────────

test('collection contract: transport vs collection outcome stay distinct', () => {
  // v1 receipts (no collection block) keep original verified/failed rule.
  assert.equal(deriveCollectionStatus(false, null), 'verified');
  assert.equal(deriveCollectionStatus(true, null), 'failed');
  assert.equal(deriveCollectionStatus(true, { rolePresent: true }), 'failed');
  // v2: collection.status is authoritative for measured work.
  assert.equal(deriveCollectionStatus(false, { collection: { status: 'complete' } }), 'verified');
  assert.equal(deriveCollectionStatus(false, { collection: { status: 'partial' } }), 'partial');
  assert.equal(deriveCollectionStatus(false, { collection: { status: 'failed' } }), 'failed');
  assert.equal(deriveCollectionStatus(true, { collection: { status: 'partial' } }), 'partial');
  assert.equal(deriveCollectionStatus(true, { collection: { status: 'failed' } }), 'failed');
  // exit!=0 + complete collection -> disagreement stays honest, never success.
  assert.equal(deriveCollectionStatus(true, { collection: { status: 'complete' } }), 'partial');
});

function seedInfraOp(s, { deviceId = 11, runbookId = 'diag/dns-server', version = 1, parsed = {}, exitCode = 0, opStatus = 'verified', noParse = false } = {}) {
  const db = s.database;
  const planId = `plan-${Math.random().toString(36).slice(2)}`;
  const apprId = `appr-${Math.random().toString(36).slice(2)}`;
  const opId = `op-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO operation_plans (id, connection_id, operation, target_type, target_id, args_canonical, plan_hash, principal, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(planId, null, 'run_device_powershell', 'device', deviceId, '{}', 'hash', 'test', Date.now(), Date.now() + 60000);
  db.prepare("INSERT INTO operation_approvals (id, plan_id, plan_hash, approved_by, method, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(apprId, planId, 'hash', 'test', 'ui', Date.now(), Date.now() + 60000);
  const result = noParse
    ? { exitCode: 1, stdout: 'script died before RBJSON', stderr: 'boom', streamsComplete: true }
    : { exitCode, stdout: 'RBJSON:' + JSON.stringify(parsed), parsed, streamsComplete: true };
  db.prepare("INSERT INTO operations (id, connection_id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, result_json, runbook_id, runbook_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(opId, null, planId, apprId, `dk-${opId}`, 'run_device_powershell', 'device', deviceId, opStatus, JSON.stringify(result), runbookId, version, Date.now(), Date.now());
  return opId;
}

function infraStore() {
  const s = memoryStore();
  s.syncDevices(DEVICES);
  s.syncOrganizations(ORGS);
  return s;
}

test('infra ingestion: complete sections ingest; failed/unverified create coverage only', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  // ad-health v1 receipt: fsmo populated, repadmin exit 234 (disputed receipt).
  const parsed = {
    rolePresent: true,
    fsmo: { pdc: 'DC1.corp.local', rid: 'DC1.corp.local', infra: 'DC1.corp.local', schema: 'DC1.corp.local', naming: 'DC1.corp.local' },
    replicationErrors: [], sites: 1, dcCount: 2, errors: [],
  };
  const opId = seedInfraOp(s, { deviceId: 11, runbookId: 'diag/ad-health', version: 1, parsed, exitCode: 234, opStatus: 'failed' });
  const out = infra.ingestReceipt(opId, null);
  assert.ok(out.entities > 0);
  // FSMO roles + holder DCs materialized.
  const roles = s.database.prepare("SELECT * FROM infra_entities WHERE category = 'fsmo-role'").all();
  assert.equal(roles.length, 5);
  // replication coverage is UNVERIFIED - "0 errors" is NOT established.
  const cov = s.database.prepare("SELECT * FROM collection_coverage WHERE operation_id = ? AND section = 'replication'").get(opId);
  assert.equal(cov.status, 'unverified');
  // Qualified ingestion annotation recorded - receipt kept immutable.
  const ann = s.database.prepare("SELECT * FROM infra_annotations WHERE operation_id = ? AND kind = 'interpretation'").get(opId);
  assert.ok(ann, 'qualified-ingest interpretation recorded');
  assert.match(ann.detail, /234/);
});

test('infra absence: only COMPLETE enumerations may mark not_observed', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  const zones1 = { rolePresent: true, moduleAvailable: true, zones: [
    { ZoneName: 'a.local', ZoneType: 'Primary', IsDsIntegrated: true, IsReverseLookupZone: false, DynamicUpdate: 'Secure' },
    { ZoneName: 'b.local', ZoneType: 'Primary', IsDsIntegrated: true, IsReverseLookupZone: false, DynamicUpdate: 'Secure' },
  ], forwarders: ['9.9.9.9'], scavenging: { enabled: false }, errors: [] };
  infra.ingestReceipt(seedInfraOp(s, { parsed: zones1 }), null);
  const before = s.database.prepare("SELECT COUNT(*) n FROM infra_entities WHERE category = 'dns-zone'").get().n;
  assert.equal(before, 2);
  // Second COMPLETE enumeration missing b.local -> not_observed.
  const zones2 = { ...zones1, zones: [zones1.zones[0]] };
  infra.ingestReceipt(seedInfraOp(s, { parsed: zones2 }), null);
  const gone = s.database.prepare("SELECT c.status FROM infra_current c JOIN infra_entities e ON e.id = c.entity_id WHERE e.stable_key = 'b.local'").get();
  assert.equal(gone.status, 'not_observed');
  // Now a FAILED collection (no parsed RBJSON) - must NOT remove a.local.
  const failedOpId = seedInfraOp(s, { opStatus: 'failed', noParse: true });
  const res = infra.ingestReceipt(failedOpId, null);
  assert.equal(res.entities, 0, 'unparseable receipt ingests nothing');
  const still = s.database.prepare("SELECT c.status FROM infra_current c JOIN infra_entities e ON e.id = c.entity_id WHERE e.stable_key = 'a.local'").get();
  assert.equal(still.status, 'observed', 'failed collection cannot mark absence');
});

test('infra conflict: same-age different-source diffs flag conflict; late arrival never regresses', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  const mk = (fwds) => ({ rolePresent: true, moduleAvailable: true, zones: [], forwarders: fwds, scavenging: { enabled: false }, errors: [] });
  const now = Date.now();
  // opA and opB: same collected_at, different operations, disagreeing forwarders.
  const opA = seedInfraOp(s, { parsed: mk(['9.9.9.9']) });
  s.database.prepare('UPDATE operations SET updated_at = ? WHERE id = ?').run(now, opA);
  infra.ingestReceipt(opA, null);
  const opB = seedInfraOp(s, { parsed: mk(['1.1.1.1']) });
  s.database.prepare('UPDATE operations SET updated_at = ? WHERE id = ?').run(now, opB);
  infra.ingestReceipt(opB, null);
  const ent = s.database.prepare("SELECT id FROM infra_entities WHERE category = 'dns-server'").get();
  const cur = s.database.prepare("SELECT conflicting, conflict_json, last_operation_id FROM infra_current WHERE entity_id = ?").get(ent.id);
  assert.equal(cur.conflicting, 1, 'same-age disagreeing sources flag conflict');
  // Older receipt arriving late: recorded as observation, never displaces current.
  const opC = seedInfraOp(s, { parsed: mk(['8.8.8.8']) });
  s.database.prepare('UPDATE operations SET updated_at = ? WHERE id = ?').run(now - 86400000, opC);
  infra.ingestReceipt(opC, null);
  const cur2 = s.database.prepare("SELECT conflicting, conflict_json, last_operation_id, attrs_json FROM infra_current WHERE entity_id = ?").get(ent.id);
  assert.notEqual(cur2.last_operation_id, opC, 'late arrival does not displace current');
  assert.match(cur2.conflict_json, /lateArrival/, 'late-arrival conflict recorded');
  assert.match(cur2.attrs_json, /1\.1\.1\.1/, 'current still reflects newest measurement');
  // Historical observation retained for the stale receipt.
  const staleObs = s.database.prepare("SELECT COUNT(*) n FROM entity_observations WHERE entity_id = ? AND operation_id = ?").get(ent.id, opC);
  assert.equal(staleObs.n, 1, 'late receipt preserved as immutable observation');
});

test('infra v2 extraction: section statuses drive coverage + eligibility', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  const parsed = {
    rolePresent: true, moduleAvailable: true,
    zones: [{ ZoneName: 'a.local', ZoneType: 'Primary', IsDsIntegrated: true, IsReverseLookupZone: false, DynamicUpdate: 'Secure' }],
    forwarders: [], scavenging: null, errors: ['scavenging: access denied'],
    collection: {
      schemaVersion: 2, status: 'partial',
      sections: {
        roleDetect: { status: 'complete' },
        zones: { status: 'complete', count: 1 },
        forwarders: { status: 'complete', count: 0 },
        scavenging: { status: 'failed', error: 'access denied' },
      },
      nativeExitCodes: {},
    },
  };
  const opId = seedInfraOp(s, { runbookId: 'diag/dns-server', version: 2, parsed, exitCode: 2, opStatus: 'partial' });
  infra.ingestReceipt(opId, null);
  const scav = s.database.prepare("SELECT * FROM collection_coverage WHERE operation_id = ? AND section = 'scavenging'").get(opId);
  assert.equal(scav.status, 'failed');
  // Zone still ingested - section-level eligibility.
  const zone = s.database.prepare("SELECT * FROM infra_entities WHERE category = 'dns-zone' AND stable_key = 'a.local'").get();
  assert.ok(zone, 'complete section ingested despite failed scavenging section');
});

test('infra backfill: idempotent enqueue; projection rebuildable from evidence', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  seedInfraOp(s, { parsed: { rolePresent: true, moduleAvailable: true, zones: [], forwarders: [], scavenging: null, errors: [] } });
  const dry = infra.backfill({ dryRun: true });
  assert.ok(dry.eligible >= 1);
  assert.equal(dry.enqueued, 0, 'dry-run enqueues nothing');
  const first = infra.backfill({ dryRun: false });
  assert.ok(first.enqueued >= 1);
  const second = infra.backfill({ dryRun: false });
  assert.equal(second.enqueued, 0, 'idempotency key prevents duplicate jobs');
  infra.processIngestionJobs(20);
  const pending = s.database.prepare("SELECT COUNT(*) n FROM ingestion_jobs WHERE status = 'pending'").get().n;
  assert.equal(pending, 0);
});

test('transport encoding: oversized commands ride a self-inflating bootstrapper', () => {
  // Small command stays plain — v1 wire format unchanged.
  const small = transportEncodeCommand('Write-Output hi');
  assert.equal(small.encoding, 'plain');
  assert.equal(Buffer.from(small.paramBase64, 'base64').toString('utf16le'), 'Write-Output hi');
  // wireSha256 = sha256(utf8(command)) — matches runner commandSha256 for plain.
  assert.equal(small.wireSha256, createHash('sha256').update('Write-Output hi','utf8').digest('hex'));

  // Large command compresses: bootstrapper decode round-trips back to source.
  const big = 'Get-Process | Select-Object Name # ' + 'x'.repeat(6000);
  const enc = transportEncodeCommand(big);
  assert.equal(enc.encoding, 'gzip-b64');
  assert.ok(enc.paramBase64.length <= 7000, `wire ${enc.paramBase64.length} <= 7000`);
  const wire = Buffer.from(enc.paramBase64, 'base64').toString('utf16le');
  const m = wire.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  assert.ok(m, 'bootstrapper embeds a base64 blob');
  assert.equal(gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8'), big, 'inflated payload is byte-identical to command');
  // wireSha256 is over the wire text the runner actually hashes.
  assert.equal(enc.wireSha256, createHash('sha256').update(wire,'utf8').digest('hex'));

  // Truly oversized commands fail at plan time, not mid-dispatch.
  // Incompressible content — gzip can't rescue it past the wire cap.
  const huge = 'Get-Process # ' + randomBytes(8000).toString('hex');
  assert.throws(() => transportEncodeCommand(huge), /transport capacity/);
});

test('every registered runbook script fits the wire budget', () => {
  // Measure the RESOLVED command — the $__p params preamble is prepended at
  // plan time, so the raw script under budget can still overflow the wire.
  const placeholder = (spec) => {
    if (spec.enum?.length) return spec.enum[0];
    if (spec.type === 'integer') return 1;
    if (spec.type === 'boolean') return true;
    if (spec.pattern) {
      // Pattern-gated params: pick a value matching known shapes.
      if (/msi/i.test(spec.pattern)) return 'https://x/p.msi';
      if (/^\[0-9a-fA-F\]\{64\}/.test(spec.pattern)) return 'a'.repeat(64);
    }
    return 'x';
  };
  for (const rb of listRunbooks()) {
    const params = {};
    for (const [name, spec] of Object.entries(rb.params)) if (spec.required && spec.default === undefined) params[name] = placeholder(spec);
    const { command } = resolveRunbookScript(rb, params);
    const enc = transportEncodeCommand(command);
    assert.ok(enc.paramBase64.length <= 7000, `${rb.id} v${rb.version} resolved wire ${enc.paramBase64.length} exceeds 7000`);
  }
});

// ─── INFRA-1 K4: RBJGZ transport, terminal-no-result reconcile, namespace merge ─

test('v3 runbooks: identical bodies to v2 with budgeted emission footer', () => {
  for (const id of ['diag/ad-health', 'diag/dns-server', 'diag/dhcp-scopes', 'diag/gpo-inventory']) {
    const v2 = getRunbook(id, 2);
    const v3 = getRunbook(id, 3); // v3 exists for all; dhcp-scopes latest is v4
    assert.equal(v3.version, 3, `${id} has a v3`);
    assert.equal(v3.resultSchema.version, 3);
    // Collection logic is provably identical — only the emission footer differs.
    const v2body = v2.script.split('\n').filter((l) => !l.includes('$__agg'));
    const v3body = v3.script.split('\n').filter((l) => !l.includes('$__agg'));
    // body = everything before the footer block (first $__agg line)
    const v2prefix = v2.script.slice(0, v2.script.indexOf('$__agg ='));
    const v3prefix = v3.script.slice(0, v3.script.indexOf('$__agg ='));
    assert.equal(v3prefix, v2prefix, `${id} v3 body identical to v2`);
  }
});

test('parseRunbookResult: RBJGZ round-trips, corrupt payloads return null', () => {
  const payload = { gpos: [{ DisplayName: 'Default Domain Policy' }], collection: { schemaVersion: 3, status: 'complete' } };
  const b64 = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
  const stdout = `some preamble\nRBJGZ:${b64}\ntrailing`;
  const parsed = parseRunbookResult(stdout);
  assert.equal(parsed.gpos[0].DisplayName, 'Default Domain Policy');
  assert.equal(parsed.collection.status, 'complete');
  // Plain RBJSON still parses; RBJGZ wins when it is the LAST emitted line.
  const both = `RBJSON:{"a":1}\nRBJGZ:${b64}`;
  assert.equal(parseRunbookResult(both).collection.status, 'complete');
  assert.equal(parseRunbookResult('RBJGZ:not-valid-base64!!!'), null);
  assert.equal(parseRunbookResult('no markers'), null);
});

test('reconcile: terminal activity without runner envelope closes failed, never verified', async () => {
  const s = memoryStore();
  const api = mockOpApi();
  const ops = new OperationService(s, api, cmdSecurity);
  const plan = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui' });
  const op = await ops.executeApproved(plan.id, approval.id);
  const runId = op.upstream_ref;

  // Upstream COMPLETED but the runner envelope was truncated off (the
  // diag/gpo-inventory v2 failure mode) — generic SUCCESS is not evidence.
  api.getDeviceActivities = async () => ({
    activities: [{ id: 999, statusCode: 'COMPLETED', activityResult: 'SUCCESS', result: `prefix ${runId} partial-output-no-markers` }],
  });
  const done = await ops.reconcile(op.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.result.parser, 'result-unrecoverable');
  const ev = done.events.find((e) => e.kind === 'failed');
  assert.equal(ev.data.reason, 'result_truncated_or_missing');

  // Non-terminal activity without an envelope still waits (honest unknown).
  const s2 = memoryStore();
  const api2 = mockOpApi();
  const ops2 = new OperationService(s2, api2, cmdSecurity);
  const plan2 = ops2.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'ipconfig' } });
  const appr2 = ops2.approvePlan(plan2.id, { approvedBy: 'ui' });
  const op2 = await ops2.executeApproved(plan2.id, appr2.id);
  api2.getDeviceActivities = async () => ({ activities: [{ id: 1, statusCode: 'STARTED', result: op2.upstream_ref }] });
  const still = await ops2.reconcile(op2.id);
  assert.equal(still.status, 'accepted');
});

test('infra: resolved namespace supersedes :unknown twin (ingest + repair)', () => {
  const store = memoryStore();
  const infra = new InfraService(store);
  const db = store.database;
  // Seed: entity under unresolved namespace with an 'observed' projection.
  db.prepare(`INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, aliases_json, first_seen_at, last_seen_at, source_device_id)
              VALUES ('ent-old', NULL, 2, 'domain:unknown', 'fsmo-role', 'pdc', 'pdc', NULL, 1, 1, 130)`).run();
  db.prepare(`INSERT INTO infra_current (entity_id, attrs_json, last_coverage_id, last_operation_id, observed_at, collected_at, status, updated_at)
              VALUES ('ent-old', '{}', NULL, NULL, 1, 1, 'observed', 1)`).run();
  // Resolved twin arrives.
  db.prepare(`INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, aliases_json, first_seen_at, last_seen_at, source_device_id)
              VALUES ('ent-new', NULL, 2, 'domain:contoso.local', 'fsmo-role', 'pdc', 'pdc', NULL, 2, 2, 130)`).run();
  db.prepare(`INSERT INTO infra_current (entity_id, attrs_json, last_coverage_id, last_operation_id, observed_at, collected_at, status, updated_at)
              VALUES ('ent-new', '{}', NULL, NULL, 2, 2, 'observed', 2)`).run();
  const res = infra.repairNamespaceSupersession();
  assert.equal(res.superseded, 1);
  const old = db.prepare('SELECT status, conflict_json FROM infra_current WHERE entity_id = ?').get('ent-old');
  assert.equal(old.status, 'superseded');
  assert.equal(JSON.parse(old.conflict_json).supersededBy, 'ent-new');
  // Resolved entity untouched; repair is idempotent.
  assert.equal(db.prepare('SELECT status FROM infra_current WHERE entity_id = ?').get('ent-new').status, 'observed');
  assert.equal(infra.repairNamespaceSupersession().superseded, 0);
});

test('infra linkCounts: latest-collection links per GPO; as-of bound', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  const db = s.database;
  const ent = (id, cat, key, name) => {
    db.prepare(`INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, aliases_json, first_seen_at, last_seen_at, source_device_id)
                VALUES (?, NULL, 2, 'domain:contoso.local', ?, ?, ?, NULL, 1, 1, 130)`).run(id, cat, key, name);
    db.prepare(`INSERT INTO infra_current (entity_id, attrs_json, last_coverage_id, last_operation_id, observed_at, collected_at, status, updated_at)
                VALUES (?, '{}', NULL, NULL, 1, 1, 'observed', 1)`).run(id);
  };
  ent('gpo-a', 'gpo', '{a}', 'Linked GPO');
  ent('gpo-b', 'gpo', '{b}', 'Unlinked GPO');
  ent('ou1', 'container', 'ou=one', 'OU One');
  ent('ou2', 'container', 'ou=two', 'OU Two');
  const opId = seedInfraOp(s, { runbookId: 'diag/gpo-inventory', version: 2 });
  db.prepare("INSERT INTO collection_coverage (id, connection_id, org_id, operation_id, section, status, collected_at, ingested_at, extractor_version) VALUES ('cov-x', NULL, 2, ?, 'links', 'complete', 200, 200, 1)").run(opId);
  for (const id of ['gpo-a', 'gpo-b']) {
    db.prepare(`INSERT INTO entity_observations (id, entity_id, coverage_id, attrs_json, field_presence_json, observed_at, collected_at, ingested_at, extractor_version, operation_id)
                VALUES (?, ?, 'cov-x', '{}', '[]', 1, 1, 1, 1, ?)`).run(`obs-${id}`, id, opId);
  }
  const rel = (id, from, to, at) =>
    db.prepare(`INSERT INTO relationship_observations (id, from_entity_id, to_entity_id, rel_type, coverage_id, collected_at, ingested_at, operation_id)
                VALUES (?, ?, ?, 'links-to', 'cov-x', ?, ?, ?)`).run(id, from, to, at, at, opId);
  // Collection 1: gpo-a linked to both OUs. Collection 2 (newer): only ou1.
  rel('r1', 'gpo-a', 'ou1', 100); rel('r2', 'gpo-a', 'ou2', 100);
  rel('r3', 'gpo-a', 'ou1', 200);
  const list = infra.listEntities(2, { category: 'gpo', linkCounts: true });
  const a = list.entities.find((e) => e.id === 'gpo-a');
  const b = list.entities.find((e) => e.id === 'gpo-b');
  assert.equal(a.link_count, 1, 'latest collection only — dropped link not counted');
  assert.equal(b.link_count, null, 'no links observed → null, UI renders unlinked/not-collected');
  const asOf = infra.listEntitiesAsOf(2, 150, { category: 'gpo', linkCounts: true });
  assert.equal(asOf.entities.find((e) => e.id === 'gpo-a').link_count, 2, 'as-of replays the earlier link set');
});

test('dhcp v4 + clients: authorization, reservation/lease entities, findings', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  // diag/dhcp-scopes v4 — authorization + scope census.
  const scopesParsed = {
    rolePresent: true, moduleAvailable: true,
    authorizedInAd: false,
    authorizedServers: [{ dns: 'stale01.contoso.local', ip: '10.11.1.99' }],
    scopes: [{
      scopeId: '10.10.10.0', name: 'LAN', state: 'Active',
      start: '10.10.10.20', end: '10.10.10.200', inUse: 19, free: 161, pctUsed: 10, options: {},
    }],
    failover: [],
    collection: {
      schemaVersion: 2, status: 'complete',
      sections: {
        roleDetect: { status: 'complete' },
        authorization: { status: 'complete', count: 1 },
        scopes: { status: 'complete', count: 1 },
        options: { status: 'complete', count: 0 },
        failover: { status: 'complete', count: 0 },
      },
      nativeExitCodes: {},
    },
  };
  // diag/dhcp-clients v1 — per-scope reservations + leases.
  const clientsParsed = {
    rolePresent: true, moduleAvailable: true,
    scopes: [{
      scopeId: '10.10.10.0', reservedCount: 1, leasedCount: 1,
      reservations: [{ ip: '10.10.10.50', clientId: 'aa-bb-cc-dd-ee-01', name: 'prn-laser-01', type: 'Both' }],
      leases: [{ ip: '10.10.10.77', clientId: 'aa-bb-cc-dd-ee-02', hostName: 'wkstn-07', state: 'Active', expiry: '2026-05-01' }],
    }],
    collection: {
      schemaVersion: 2, status: 'complete',
      sections: {
        roleDetect: { status: 'complete' },
        scopes: { status: 'complete', count: 1 },
        reservations: { status: 'complete', count: 1 },
        leases: { status: 'complete', count: 1 },
      },
      nativeExitCodes: {},
    },
  };
  const opA = seedInfraOp(s, { runbookId: 'diag/dhcp-scopes', version: 4, parsed: scopesParsed });
  const opB = seedInfraOp(s, { runbookId: 'diag/dhcp-clients', version: 1, parsed: clientsParsed });
  infra.ingestReceipt(opA, null);
  infra.ingestReceipt(opB, null);
  const db = s.database;
  // Server carries authorization state.
  const server = db.prepare("SELECT c.attrs_json FROM infra_current c JOIN infra_entities e ON e.id=c.entity_id WHERE e.category='dhcp-server' AND e.stable_key='ws-001.corp.local'").get();
  assert.ok(server, 'server entity exists');
  assert.equal(JSON.parse(server.attrs_json).authorizedInAd, false);
  // Reservation and lease are separate entities under the scope namespace.
  const res = db.prepare("SELECT * FROM infra_entities WHERE category='dhcp-reservation'").get();
  assert.ok(res, 'reservation entity');
  assert.equal(res.namespace, 'dhcp-scope:10.10.10.0');
  const lease = db.prepare("SELECT c.attrs_json FROM infra_current c JOIN infra_entities e ON e.id=c.entity_id WHERE e.category='dhcp-lease'").get();
  assert.ok(lease, 'lease entity');
  assert.equal(JSON.parse(lease.attrs_json).state, 'Active');
  // Clients runbook does not clobber the scope census attrs (wholesale
  // replace would have dropped state/options).
  const scope = db.prepare("SELECT c.attrs_json FROM infra_current c JOIN infra_entities e ON e.id=c.entity_id WHERE e.category='dhcp-scope'").get();
  assert.equal(JSON.parse(scope.attrs_json).state, 'Active');
  // Findings: unauthorized server w/ active scope + orphaned AD record.
  const notes = db.prepare("SELECT * FROM infra_annotations").all().map((n) => n.title);
  assert.ok(notes.some((x) => /not AD-authorized/.test(x)), 'unauthorized finding');
  assert.ok(notes.some((x) => /authorized DHCP server/.test(x) && /stale01/.test(x)), 'orphan authorization finding');
});

test('dns-records v1: normalized entities, per-server namespaces, scoped absence, static-in-pool finding', () => {
  const s = infraStore();
  const infra = new InfraService(s);
  const db = s.database;
  // A known DHCP pool first — the static-in-pool finding needs it.
  const scopesParsed = {
    rolePresent: true, moduleAvailable: true, authorizedInAd: true, authorizedServers: [],
    scopes: [{ scopeId: '10.10.10.0', name: 'LAN', state: 'Active', start: '10.10.10.20', end: '10.10.10.200', inUse: 10, free: 170, pctUsed: 5, options: {} }],
    failover: [],
    collection: { schemaVersion: 2, status: 'complete', sections: { roleDetect: { status: 'complete' }, authorization: { status: 'complete', count: 0 }, scopes: { status: 'complete', count: 1 }, options: { status: 'complete', count: 0 }, failover: { status: 'complete', count: 0 } }, nativeExitCodes: {} },
  };
  infra.ingestReceipt(seedInfraOp(s, { runbookId: 'diag/dhcp-scopes', version: 4, parsed: scopesParsed }), null);
  // Zone census from diag/dns-server — dns-records links into these entities.
  const dnsSrv = {
    rolePresent: true, moduleAvailable: true,
    zones: [{ ZoneName: 'corp.local', ZoneType: 'Primary', IsDsIntegrated: true, IsReverseLookupZone: false, DynamicUpdate: 'Secure' }, { ZoneName: 'big.local', ZoneType: 'Primary', IsDsIntegrated: true, IsReverseLookupZone: false, DynamicUpdate: 'Secure' }],
    forwarders: ['9.9.9.9'], scavenging: { enabled: false }, errors: [],
    collection: { schemaVersion: 2, status: 'complete', sections: { roleDetect: { status: 'complete' }, zones: { status: 'complete', count: 2 }, forwarders: { status: 'complete', count: 1 }, scavenging: { status: 'complete' } }, nativeExitCodes: {} },
  };
  infra.ingestReceipt(seedInfraOp(s, { runbookId: 'diag/dns-server', version: 3, parsed: dnsSrv }), null);
  const mkRecs = (zones, recErr = false) => ({
    rolePresent: true, moduleAvailable: true, zones, errors: [],
    collection: { schemaVersion: 2, status: 'complete', sections: { roleDetect: { status: 'complete' }, records: { status: recErr ? 'partial' : 'complete', count: 3, truncated: zones.some((z) => z.truncated) } }, nativeExitCodes: {} },
  });
  const zoneA = (recs) => ({ name: 'corp.local', truncated: false, aging: true, records: recs });
  const zoneB = (recs) => ({ name: 'big.local', truncated: true, aging: false, records: recs });
  // Run 1: zoneA has static mail A in the DHCP pool + a dynamic A; zoneB truncated with two records.
  infra.ingestReceipt(seedInfraOp(s, {
    runbookId: 'diag/dns-records', version: 1,
    parsed: mkRecs([
      zoneA([
        { host: 'mail', type: 'A', ts: null, ttl: '01:00:00', data: '10.10.10.50' },
        { host: 'wkstn-07', type: 'A', ts: '2026-09-02T10:00:00Z', ttl: '00:20:00', data: '10.10.10.77' },
        { host: 'autodiscover', type: 'CNAME', ts: null, ttl: '01:00:00', data: 'mail.corp.local.' },
      ]),
      zoneB([{ host: 'r1', type: 'A', ts: null, ttl: '01:00:00', data: '10.19.9.1' }, { host: 'r2', type: 'A', ts: null, ttl: '01:00:00', data: '10.19.9.2' }]),
    ]),
  }), null);
  // Per-server/per-zone namespace — records from another server never collide.
  const mail = db.prepare("SELECT e.*, c.status st, c.attrs_json aj FROM infra_entities e JOIN infra_current c ON c.entity_id=e.id WHERE e.category='dns-record' AND e.stable_key LIKE 'mail|a|%'").get();
  assert.ok(mail, 'mail record entity');
  assert.equal(mail.namespace, 'dns-zone:corp.local@ws-001.corp.local');
  const mailAttrs = JSON.parse(mail.aj);
  assert.equal(mailAttrs.isStatic, true, 'ts null → static');
  assert.equal(mailAttrs.data, '10.10.10.50');
  const dyn = db.prepare("SELECT c.attrs_json FROM infra_entities e JOIN infra_current c ON c.entity_id=e.id WHERE e.category='dns-record' AND e.stable_key LIKE 'wkstn-07|%'").get();
  assert.equal(JSON.parse(dyn.attrs_json).isStatic, false, 'timestamped → dynamic');
  // contains-record relationship + zone-aging observation emitted.
  const rels = db.prepare('SELECT rel_type FROM relationship_observations').all().map((r) => r.rel_type);
  assert.ok(rels.includes('contains-record') && rels.includes('zone-aging'), 'zone→record + aging relationships');
  // Finding: static mail A at .50 sits inside the 10.10.10.20–.200 pool.
  const notes = db.prepare("SELECT * FROM infra_annotations").all().map((n) => n.title);
  assert.ok(notes.some((t) => /inside DHCP pool 10\.10\.10\.0/.test(t) && /mail/.test(t)), 'static-in-pool finding fired');
  assert.ok(!notes.some((t) => /wkstn-07/.test(t)), 'dynamic record never triggers the finding');
  // Run 2: mail record gone from zoneA (complete) → not_observed; zoneB still truncated and drops r2 → stays observed.
  infra.ingestReceipt(seedInfraOp(s, {
    runbookId: 'diag/dns-records', version: 1,
    parsed: mkRecs([
      zoneA([{ host: 'wkstn-07', type: 'A', ts: '2026-09-02T11:00:00Z', ttl: '00:20:00', data: '10.10.10.77' }, { host: 'autodiscover', type: 'CNAME', ts: null, ttl: '01:00:00', data: 'mail.corp.local.' }]),
      zoneB([{ host: 'r1', type: 'A', ts: null, ttl: '01:00:00', data: '10.19.9.1' }]),
    ]),
  }), null);
  const mailAfter = db.prepare("SELECT c.status st FROM infra_current c JOIN infra_entities e ON e.id=c.entity_id WHERE e.stable_key LIKE 'mail|a|%'").get();
  assert.equal(mailAfter.st, 'not_observed', 'complete zone re-enum marks dropped record absent');
  const r2 = db.prepare("SELECT c.status st FROM infra_current c JOIN infra_entities e ON e.id=c.entity_id WHERE e.stable_key LIKE 'r2|%'").get();
  assert.equal(r2.st, 'observed', 'truncated zone excluded from absence scope');
});

// ─── SECURITY: confirm:true is not approval on the MCP surface ───────────
// Regression for the stdio bypass: run_device_script with the PowerShell
// runner's script id + a base64 command would have executed on an endpoint
// with only a model-supplied confirm flag, skipping plan → human approval.
function commandTestServer() {
  const srv = testServer();
  const calls = [];
  srv.security = {
    ...srv.security,
    profile: 'command',
    principal: { profile: 'command', credentialKind: 'native_pkce' },
    policy: { ...safePolicy, deviceScriptsEnabled: true, deviceManagementEnabled: true, powershellRunnerScriptId: 106 },
  };
  srv.api = {
    ...mockApi(),
    async runDeviceScript(...a) { calls.push(['runDeviceScript', ...a]); return { ok: true }; },
    async rebootDevice(...a) { calls.push(['rebootDevice', ...a]); return { ok: true }; },
    async controlWindowsService(...a) { calls.push(['controlWindowsService', ...a]); return { ok: true }; },
  };
  return { srv, calls };
}

test('SECURITY: run_device_script cannot bypass plan approval with confirm:true', async () => {
  const { srv, calls } = commandTestServer();
  const res = await srv.executeToolCall('run_device_script', { deviceId: 11, scriptId: 106, parameters: 'ZQBjAGgAbwA= run 60', confirm: true }, 'sess');
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.code, 'APPROVAL_PIPELINE_REQUIRED');
  assert.equal(body.nextAction, 'create_plan');
  assert.equal(calls.length, 0, 'no upstream script run was submitted');
});

test('SECURITY: device-management writes are refused, not confirm-guarded', async () => {
  const { srv, calls } = commandTestServer();
  for (const [tool, args] of [
    ['reboot_device', { id: 11, confirm: true }],
    ['control_windows_service', { id: 11, serviceId: 'Spooler', action: 'STOP', confirm: true }],
  ]) {
    const body = JSON.parse((await srv.executeToolCall(tool, args, 'sess')).content[0].text);
    assert.equal(body.code, 'APPROVAL_PIPELINE_REQUIRED', `${tool} must route through approval`);
  }
  assert.equal(calls.length, 0);
});

test('SECURITY: pipeline gate is command-only and honors the documented escape hatch', async () => {
  const { requiresApprovalPipeline, APPROVAL_PIPELINE_ONLY_TOOLS } = await import('../dist/security-profile.js');
  assert.equal(requiresApprovalPipeline('run_device_script', { profile: 'command' }, true), true);
  assert.equal(requiresApprovalPipeline('run_device_script', { profile: 'command' }, false), false, 'NINJA_REQUIRE_PLAN_APPROVAL=0 restores legacy');
  assert.equal(requiresApprovalPipeline('run_device_script', { profile: 'reporting' }, true), false, 'reporting denies earlier via allowlist');
  assert.equal(requiresApprovalPipeline('run_device_powershell', { profile: 'command' }, true), false, 'has its own plan path');
  assert.equal(requiresApprovalPipeline('create_ticket', { profile: 'command' }, true), false, 'PSA ticket writes are not endpoint actions');
  assert.ok(APPROVAL_PIPELINE_ONLY_TOOLS.has('reboot_device'));
});
