// Knowledge base reads + set_health_status write-back.
// The write is a plan like any other: bound by hash, approved by a human
// (passkey when enrolled), org-boundary preflighted against live data, and
// `verified` only when NinjaOne's read-back shows the approved status.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../dist/storage.js';
import { EntityStore } from '../dist/entity-store.js';
import { OperationService } from '../dist/operations.js';
import { isToolAllowed, parsePolicy } from '../dist/security-profile.js';

const security = (policy = {}) => ({
  profile: 'command',
  principal: { profile: 'command', credentialKind: 'native_pkce' },
  policy: { ...parsePolicy({ allowedOrganizationIds: [2], healthWritebackEnabled: true }), ...policy },
});
const reporting = { profile: 'reporting', principal: { profile: 'reporting' }, policy: parsePolicy({}) };

function api({ stored = (v) => v, writeError = null } = {}) {
  const fields = {};
  return {
    writes: [],
    async getDevice(id) { return { id, organizationId: id === 99 ? 7 : 2, offline: false }; },
    async runDeviceScript() { throw new Error('must not run scripts'); },
    async getDeviceActivities() { throw new Error('must not poll activities'); },
    async updateDeviceCustomFields(id, body) { if (writeError) throw new Error(writeError); this.writes.push({ kind: 'device', id, body }); Object.assign(fields, body); },
    async updateOrganizationCustomFields(id, body) { this.writes.push({ kind: 'org', id, body }); Object.assign(fields, body); },
    async getDeviceCustomFields() { return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, stored(v)])); },
    async getOrganizationCustomFields() { return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, stored(v)])); },
  };
}

const setup = (opts = {}, policy = {}) => {
  const store = new EntityStore(openDatabase(':memory:'));
  const a = api(opts);
  return { store, a, ops: new OperationService(store, a, security(policy)) };
};
const plan = (ops, over = {}) => ops.createPlan({
  operation: 'set_health_status', targetType: 'device', targetId: 11,
  args: { field: 'keyturnHealth', status: 'needs_attention', description: 'DHCP scope 93% used' }, ...over,
});

describe('tool exposure', () => {
  test('KB and system custom-field reads are available to both profiles', () => {
    for (const t of ['list_kb_articles', 'get_kb_article', 'get_system_custom_fields']) {
      assert.equal(isToolAllowed(t, reporting), true, `${t} on reporting`);
      assert.equal(isToolAllowed(t, security()), true, `${t} on command`);
    }
  });
  test('propose_health_status needs the command profile AND healthWritebackEnabled', () => {
    assert.equal(isToolAllowed('propose_health_status', reporting), false);
    assert.equal(isToolAllowed('propose_health_status', security({ healthWritebackEnabled: false })), false);
    assert.equal(isToolAllowed('propose_health_status', security()), true);
    assert.equal(parsePolicy({}).healthWritebackEnabled, false, 'off by default');
  });
});

describe('set_health_status plans', () => {
  test('validates target, field name, status, and description length', () => {
    const { ops } = setup();
    assert.throws(() => plan(ops, { targetType: 'selection' }), /device or an organization/);
    assert.throws(() => plan(ops, { args: { field: 'bad name!', status: 'HEALTHY' } }), /API name/);
    assert.throws(() => plan(ops, { args: { field: 'f', status: 'GREAT' } }), /status must be one of/);
    assert.throws(() => plan(ops, { args: { field: 'f', status: 'HEALTHY', description: 'x'.repeat(2001) } }), /2000/);
    const p = plan(ops);
    assert.equal(p.args.status, 'NEEDS_ATTENTION', 'status normalized before hashing');
    assert.ok(p.planHash);
  });

  test('approve → execute writes once, reads back, and verifies', async () => {
    const { ops, a } = setup();
    const p = plan(ops);
    const ap = ops.approvePlan(p.id, { approvedBy: 'ui' });
    const op = await ops.executeApproved(p.id, ap.id);
    assert.equal(op.status, 'verified');
    assert.deepEqual(a.writes, [{ kind: 'device', id: 11, body: { keyturnHealth: { status: 'NEEDS_ATTENTION', description: 'DHCP scope 93% used' } } }]);
    assert.deepEqual(op.events.map((e) => e.kind), ['preflight_ok', 'intent_persisted', 'write_accepted', 'verified']);
    const again = await ops.executeApproved(p.id, ap.id);
    assert.equal(again.id, op.id);
    assert.equal(a.writes.length, 1, 'idempotent retry — no second write');
    assert.equal((await ops.reconcile(op.id)).status, 'verified', 'reconcile never polls runner activity');
  });

  test('read-back stored as a bare string still verifies', async () => {
    const { ops } = setup({ stored: (v) => v.status });
    const p = plan(ops);
    const op = await ops.executeApproved(p.id, ops.approvePlan(p.id, { approvedBy: 'ui' }).id);
    assert.equal(op.status, 'verified');
  });

  test('read-back mismatch is reported as unknown, with what NinjaOne stored', async () => {
    const { ops } = setup({ stored: () => null });
    const p = plan(ops);
    const op = await ops.executeApproved(p.id, ops.approvePlan(p.id, { approvedBy: 'ui' }).id);
    assert.equal(op.status, 'unknown');
    assert.equal(op.result.readBack, null);
    assert.ok(op.events.some((e) => e.kind === 'readback_mismatch'));
  });

  test('organization targets write org custom fields', async () => {
    const { ops, a } = setup();
    const p = plan(ops, { targetType: 'organization', targetId: 2 });
    const op = await ops.executeApproved(p.id, ops.approvePlan(p.id, { approvedBy: 'ui' }).id);
    assert.equal(op.status, 'verified');
    assert.equal(a.writes[0].kind, 'org');
  });

  test('refused when the policy grant is off, or the target is outside the allowed orgs', async () => {
    const off = setup({}, { healthWritebackEnabled: false });
    const p1 = plan(off.ops);
    await assert.rejects(() => off.ops.executeApproved(p1.id, off.ops.approvePlan(p1.id, { approvedBy: 'ui' }).id), /healthWritebackEnabled/);
    const { ops, a } = setup();
    const p2 = plan(ops, { targetId: 99 });
    await assert.rejects(() => ops.executeApproved(p2.id, ops.approvePlan(p2.id, { approvedBy: 'ui' }).id), /outside the allowed set/);
    assert.equal(a.writes.length, 0, 'nothing written');
  });

  test('passkey enforcement applies once a key is enrolled', async () => {
    const { ops, store, a } = setup();
    store.database.prepare("INSERT INTO approver_credentials (id, name, public_key_jwk, alg, sign_count, created_at) VALUES ('k', 'key', '{}', -7, 0, 1)").run();
    const p = plan(ops);
    assert.throws(() => ops.approvePlan(p.id, { approvedBy: 'ui' }), /passkey/, 'non-passkey approval refused up front');
    assert.equal(a.writes.length, 0);
  });

  test('a failed write is persisted as failed — no silent retry', async () => {
    const { ops } = setup({ writeError: 'upstream 400' });
    const p = plan(ops);
    const ap = ops.approvePlan(p.id, { approvedBy: 'ui' });
    await assert.rejects(() => ops.executeApproved(p.id, ap.id), /Write failed/);
    const again = await ops.executeApproved(p.id, ap.id);
    assert.equal(again.status, 'failed');
  });
});
