// Mission Control + Analytics aggregates — honesty semantics.
// Roles come only from infra evidence; freshness is always reported; an
// offline server and pending approvals rank at the top of attention; org
// scope filters every section; empty windows stay empty (no invented data).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../dist/storage.js';
import { EntityStore } from '../dist/entity-store.js';
import { buildHud } from '../dist/hud.js';
import { buildAnalytics } from '../dist/analytics.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const DAY = 86_400_000;

function seed({ syncAgeMs = 60_000 } = {}) {
  const store = new EntityStore(openDatabase(':memory:'));
  const db = store.database;
  const org = db.prepare('INSERT INTO entities_org (org_id, name, updated_at, seen_at) VALUES (?, ?, ?, ?)');
  org.run(1, 'Clinic', NOW, NOW);
  org.run(2, 'Other Co', NOW, NOW);
  const dev = db.prepare('INSERT INTO entities_device (device_id, system_name, display_name, dns_name, org_id, node_class, offline, last_contact, updated_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  dev.run(10, 'CLINICDC1', 'DC 1', 'clinicdc1.clinic.local', 1, 'WINDOWS_SERVER', 0, (NOW - 60_000) / 1000, NOW, NOW);
  dev.run(11, 'CLINICSQL', 'SQL box', 'clinicsql.clinic.local', 1, 'WINDOWS_SERVER', 1, (NOW - 3 * DAY) / 1000, NOW, NOW);
  dev.run(12, 'RECEPTION', 'Reception', null, 1, 'WINDOWS_WORKSTATION', 0, (NOW - 120_000) / 1000, NOW, NOW);
  dev.run(20, 'OTHERWS', 'Other WS', null, 2, 'WINDOWS_WORKSTATION', 1, (NOW - 10 * DAY) / 1000, NOW, NOW);
  db.prepare('INSERT INTO sync_state (entity_type, last_sync_at, item_count) VALUES (?, ?, ?)').run('devices', NOW - syncAgeMs, 4);
  const inf = db.prepare('INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, first_seen_at, last_seen_at, source_device_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
  inf.run('i1', null, 1, 'domain:clinic.local', 'domain-controller', 'clinicdc1', 'CLINICDC1', NOW, NOW, 10);
  inf.run('i2', null, 1, 'ad', 'dhcp-server', 'clinicdc1.clinic.local', 'clinicdc1.clinic.local', NOW, NOW, 10);
  // A dead server listed in AD — must not attach a role to any live device.
  inf.run('i3', null, 1, 'ad', 'dhcp-server', 'oldsbs', 'oldsbs.clinic.local', NOW, NOW, 10);
  return store;
}

function seedOp(store, { id, status, targetId = 10, createdAt = NOW - 3_600_000, durationMs = null }) {
  const db = store.database;
  db.prepare('INSERT INTO operation_plans (id, operation, target_type, target_id, args_canonical, plan_hash, principal, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`p-${id}`, 'run_device_powershell', 'device', targetId, '{}', 'h', 'test', createdAt, createdAt + 900_000);
  db.prepare('INSERT INTO operation_approvals (id, plan_id, plan_hash, approved_by, method, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(`a-${id}`, `p-${id}`, 'h', 'test', 'ui', createdAt, createdAt + 900_000);
  db.prepare('INSERT INTO operations (id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, result_json, runbook_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, `p-${id}`, `a-${id}`, `d-${id}`, 'run_device_powershell', 'device', targetId, status, durationMs ? JSON.stringify({ durationMs }) : null, 'diag/ad-health', createdAt, createdAt);
}

describe('HUD aggregate', () => {
  test('fleet counts, freshness, and evidence-only server roles', () => {
    const h = buildHud(seed(), { now: NOW });
    assert.equal(h.fleet.total, 4);
    assert.equal(h.fleet.online, 2);
    assert.deepEqual(h.fleet.servers, { total: 2, online: 1 });
    assert.equal(h.freshness.stale, false);
    const dc = h.servers.find((s) => s.name === 'CLINICDC1');
    assert.deepEqual(dc.roles, ['DC', 'DHCP']);
    const sql = h.servers.find((s) => s.name === 'CLINICSQL');
    assert.deepEqual(sql.roles, [], 'no role inferred from the hostname "SQL"');
    assert.equal(h.servers[0].name, 'CLINICSQL', 'offline servers sort first');
    assert.equal(h.networkEdge.status, 'not_connected');
  });

  test('attention: offline server is critical, approvals high, stale sync flagged', () => {
    const store = seed({ syncAgeMs: 3 * DAY });
    const h = buildHud(store, { now: NOW, pendingPlans: [{ id: 'plan-1', operation: 'run_device_powershell', target_type: 'device', target_id: 12, principal: 'mcp:command', created_at: NOW - 1000 }] });
    assert.equal(h.attention[0].kind, 'server_offline');
    assert.equal(h.attention[0].severity, 'critical');
    assert.ok(h.attention.some((a) => a.kind === 'approval' && a.href === '#/plan/plan-1'));
    assert.ok(h.attention.some((a) => a.kind === 'stale_sync'));
    assert.equal(h.freshness.stale, true);
    assert.equal(h.approvals.pending, 1);
    for (const a of h.attention) assert.match(a.href, /^#\//, 'every attention item links to a real route');
  });

  test('org scope filters fleet, servers, and plans', () => {
    const h = buildHud(seed(), { now: NOW, orgId: 2, pendingPlans: [{ id: 'x', target_type: 'device', target_id: 12, created_at: NOW }] });
    assert.equal(h.fleet.total, 1);
    assert.equal(h.servers.length, 0);
    assert.equal(h.approvals.pending, 0, 'a plan targeting org 1 is not counted in org 2 scope');
    assert.equal(h.fleet.offlineAging.gt7d, 1);
  });

  test('operations: success rate from terminal outcomes; failed op in 24h raises attention', () => {
    const store = seed();
    seedOp(store, { id: 'o1', status: 'verified' });
    seedOp(store, { id: 'o2', status: 'verified' });
    seedOp(store, { id: 'o3', status: 'failed' });
    seedOp(store, { id: 'o4', status: 'accepted' });
    const h = buildHud(store, { now: NOW });
    assert.equal(h.operations.d7.total, 4);
    assert.equal(h.operations.d7.inFlight, 1);
    assert.equal(h.operations.d7.successRate, 2 / 3, 'in-flight work is excluded from the rate');
    assert.ok(h.attention.some((a) => a.kind === 'op_failed' && a.href === '#/operation/o3'));
  });

  test('empty store: no division by zero, no invented values', () => {
    const store = new EntityStore(openDatabase(':memory:'));
    const h = buildHud(store, { now: NOW });
    assert.equal(h.fleet.total, 0);
    assert.equal(h.operations.d30.successRate, null);
    assert.equal(h.freshness.deviceSyncAt, null);
    assert.ok(h.attention.some((a) => a.kind === 'stale_sync' && /never/i.test(a.title)));
  });
});

describe('Analytics aggregate', () => {
  test('windowed series length, durations only from recorded receipts', () => {
    const store = seed();
    seedOp(store, { id: 'a1', status: 'verified', durationMs: 2000 });
    seedOp(store, { id: 'a2', status: 'verified', durationMs: 4000 });
    seedOp(store, { id: 'a3', status: 'failed' });
    seedOp(store, { id: 'old', status: 'verified', createdAt: NOW - 60 * DAY, durationMs: 99_000 });
    const a = buildAnalytics(store, { days: 30, now: NOW });
    assert.equal(a.operations.daily.length, 30);
    assert.equal(a.operations.total, 3, 'operations outside the window are excluded');
    assert.equal(a.operations.durationMs.samples, 2, 'receipts without a duration are not imputed');
    assert.equal(a.operations.durationMs.p50, 3000);
    assert.equal(a.operations.byRunbook[0].runbook, 'diag/ad-health');
    assert.equal(a.fleet.contact.lt1h, 2);
  });

  test('window is clamped and org scope applies', () => {
    const a = buildAnalytics(seed(), { days: 9999, orgId: 2, now: NOW });
    assert.equal(a.window.days, 400);
    assert.equal(a.fleet.total, 1);
  });
});
