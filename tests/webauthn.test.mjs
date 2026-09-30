// Human-presence approvals — WebAuthn passkeys.
// A software authenticator (real ES256 / Ed25519 keys, real CBOR) drives the
// full ceremonies so these tests exercise actual signature verification:
// enrollment bootstrap + step-up, plan-bound single-use challenges, UV
// required, origin/RP binding, replay, counter regression, revocation
// rules, and enforcement at approve + dispatch + device-session reuse.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { openDatabase } from '../dist/storage.js';
import { EntityStore } from '../dist/entity-store.js';
import { ApproverService, cborDecode } from '../dist/webauthn.js';
import { OperationService } from '../dist/operations.js';

const RP = { id: 'localhost', name: 'Keyturn', origins: ['http://localhost:39300'] };
const ORIGIN = RP.origins[0];
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

/* ── minimal CBOR encoder (test-only) ─────────────────────────────────── */
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

/* ── software authenticator ───────────────────────────────────────────── */
function authenticator(kind = 'es256', { aaguid = 'cb69481e8ff7403993ec0a2729a154a8' } = {}) {
  const { privateKey, publicKey } = kind === 'es256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = kind === 'es256'
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    : new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]);
  const credId = randomBytes(24);
  let counter = 0;
  const rpHash = sha256(RP.id);
  return {
    id: b64u(credId),
    create(options, { origin = ORIGIN, flags = 0x45 } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.publicKey.challenge, origin }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4), Buffer.from(aaguid, 'hex'), len, credId, cbor(cose)]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att) }, transports: ['usb'] };
    },
    get(options, { origin = ORIGIN, flags = 0x05, count, rpId = RP.id, tamper = false } = {}) {
      counter = count ?? counter + 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.publicKey.challenge, origin }));
      const c = Buffer.alloc(4); c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), c]);
      const data = Buffer.concat([authData, sha256(clientData)]);
      let signature = kind === 'es256' ? sign('sha256', data, privateKey) : sign(null, data, privateKey);
      if (tamper) signature = Buffer.from(signature.map((x, i) => (i === 8 ? x ^ 0xff : x)));
      return { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}

const cmdSecurity = {
  profile: 'command',
  principal: { profile: 'command', credentialKind: 'native_pkce' },
  policy: { allowedOrganizationIds: [2], blockedActions: [], deviceScriptsEnabled: true, powershellRunnerScriptId: 106 },
};
function setup() {
  const store = new EntityStore(openDatabase(':memory:'));
  store.syncDevices([{ id: 11, systemName: 'WS-001', displayName: 'Reception PC', organizationId: 2, nodeClass: 'WINDOWS_WORKSTATION', offline: false, lastContact: 1000 }]);
  const svc = new ApproverService(store, RP);
  const ops = new OperationService(store, { async getDevice() { return { id: 11, organizationId: 2, offline: false }; } }, cmdSecurity);
  return { store, svc, ops };
}
function enroll(svc, auth, name = 'YubiKey 5C', stepUpAuth = null) {
  let stepUp;
  if (stepUpAuth) {
    const o = svc.assertionOptions('enroll');
    stepUp = { challengeId: o.challengeId, assertion: stepUpAuth.get(o) };
  }
  const opts = svc.registrationOptions(name, stepUp);
  return svc.register(opts.challengeId, auth.create(opts));
}
const plan = (ops) => ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'Get-Service Spooler' } });

describe('WebAuthn primitives', () => {
  test('CBOR decoder round-trips maps, bytes, text, negative ints', () => {
    const buf = cbor(new Map([[1, 2], [-1, 'x'], ['k', Buffer.from([1, 2, 3])]]));
    const v = cborDecode(buf).value;
    assert.equal(v.get(1), 2);
    assert.equal(v.get(-1), 'x');
    assert.deepEqual([...v.get('k')], [1, 2, 3]);
  });
});

describe('Approver enrollment', () => {
  test('bootstrap: first key enrolls with bearer, then enforcement turns on', () => {
    const { svc, ops } = setup();
    assert.equal(svc.enforced(), false);
    assert.equal(ops.passkeyEnforced(), false);
    const r = enroll(svc, authenticator('es256'));
    assert.equal(r.authenticator, 'YubiKey 5 series', 'AAGUID label for display');
    assert.equal(svc.enforced(), true);
    assert.equal(ops.passkeyEnforced(), true);
  });

  test('second key requires step-up from an existing key (an agent cannot add its own)', () => {
    const { svc } = setup();
    const yubi = authenticator('es256');
    enroll(svc, yubi);
    assert.throws(() => svc.registrationOptions('Rogue key'), (e) => e.code === 'step_up_required');
    const bw = authenticator('ed25519', { aaguid: 'd548826e79b4db40a3d811116f7e8349' });
    const r = enroll(svc, bw, 'Bitwarden', yubi);
    assert.equal(r.authenticator, 'Bitwarden');
    assert.equal(svc.status().credentials.length, 2);
  });

  test('registration without user verification is rejected', () => {
    const { svc } = setup();
    const a = authenticator('es256');
    const opts = svc.registrationOptions('No PIN');
    assert.throws(() => svc.register(opts.challengeId, a.create(opts, { flags: 0x41 })), (e) => e.code === 'user_not_verified');
    assert.equal(svc.enforced(), false);
  });

  test('registration from a foreign origin is rejected', () => {
    const { svc } = setup();
    const a = authenticator('es256');
    const opts = svc.registrationOptions('Phish');
    assert.throws(() => svc.register(opts.challengeId, a.create(opts, { origin: 'http://evil.example' })), (e) => e.code === 'origin_mismatch');
  });
});

describe('Passkey approvals', () => {
  test('bearer approval refused once enforced; passkey approval binds credential + evidence', () => {
    const { svc, ops, store } = setup();
    const yubi = authenticator('es256');
    enroll(svc, yubi);
    const p = plan(ops);
    assert.throws(() => ops.approvePlan(p.id, { approvedBy: 'ui-session', method: 'ui' }), (e) => e.code === 'passkey_required');
    const o = svc.assertionOptions('approve', { planId: p.id, planHash: p.planHash });
    const v = svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o));
    const ap = ops.approvePlan(p.id, { approvedBy: `passkey:${v.name}`, method: 'webauthn', credentialId: v.credentialId, assertion: v.evidence });
    assert.equal(ap.method, 'webauthn');
    const row = store.database.prepare('SELECT * FROM operation_approvals WHERE id = ?').get(ap.id);
    assert.equal(row.approved_by, 'passkey:YubiKey 5C');
    assert.equal(row.credential_id, yubi.id);
    const ev = JSON.parse(row.assertion_json);
    assert.ok(ev.signature && ev.authenticatorData && ev.clientDataJSON, 'assertion stored for later re-verification');
    assert.equal(ev.uv, true);
  });

  test('challenge is single-use (replay rejected)', () => {
    const { svc, ops } = setup();
    const yubi = authenticator('es256');
    enroll(svc, yubi);
    const p = plan(ops);
    const o = svc.assertionOptions('approve', { planId: p.id, planHash: p.planHash });
    const assertion = yubi.get(o);
    svc.verifyApproval(p.id, p.planHash, o.challengeId, assertion);
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, assertion), (e) => e.code === 'challenge_used');
  });

  test('challenge is bound to one plan hash', () => {
    const { svc, ops } = setup();
    const yubi = authenticator('es256');
    enroll(svc, yubi);
    const a = plan(ops);
    const b = ops.createPlan({ operation: 'run_device_powershell', targetType: 'device', targetId: 11, args: { command: 'Restart-Service Spooler' } });
    const o = svc.assertionOptions('approve', { planId: a.id, planHash: a.planHash });
    assert.throws(() => svc.verifyApproval(b.id, b.planHash, o.challengeId, yubi.get(o)), (e) => e.code === 'challenge_mismatch');
  });

  test('UV flag, RP id, signature, and counter are all enforced', () => {
    const { svc, ops } = setup();
    const yubi = authenticator('es256');
    enroll(svc, yubi);
    const p = plan(ops);
    const opt = () => svc.assertionOptions('approve', { planId: p.id, planHash: p.planHash });
    let o = opt();
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o, { flags: 0x01 })), (e) => e.code === 'user_not_verified');
    o = opt();
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o, { rpId: 'evil.example' })), (e) => e.code === 'rp_mismatch');
    o = opt();
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o, { tamper: true })), (e) => e.code === 'bad_signature');
    o = opt();
    svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o, { count: 50 }));
    o = opt();
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, yubi.get(o, { count: 10 })), (e) => e.code === 'counter_regression');
  });

  test('synced passkeys that always report counter 0 still verify', () => {
    const { svc, ops } = setup();
    const bw = authenticator('ed25519');
    enroll(svc, bw, 'Bitwarden');
    const p = plan(ops);
    for (let i = 0; i < 2; i++) {
      const o = svc.assertionOptions('approve', { planId: p.id, planHash: p.planHash });
      svc.verifyApproval(p.id, p.planHash, o.challengeId, bw.get(o, { count: 0 }));
    }
  });

  test('an unenrolled key cannot approve', () => {
    const { svc, ops } = setup();
    enroll(svc, authenticator('es256'));
    const p = plan(ops);
    const o = svc.assertionOptions('approve', { planId: p.id, planHash: p.planHash });
    assert.throws(() => svc.verifyApproval(p.id, p.planHash, o.challengeId, authenticator('es256').get(o)), (e) => e.code === 'unknown_credential');
  });

  test('dispatch refuses a pre-enrollment bearer approval', async () => {
    const { svc, ops } = setup();
    const p = plan(ops);
    const bearer = ops.approvePlan(p.id, { approvedBy: 'ui-session', method: 'ui' });
    enroll(svc, authenticator('es256'));
    await assert.rejects(() => ops.executeApproved(p.id, bearer.id), (e) => e.code === 'passkey_approval_required');
  });

  test('device sessions opened by a bearer approval stop counting once enforced', () => {
    const { svc, ops, store } = setup();
    const p = plan(ops);
    const bearer = ops.approvePlan(p.id, { approvedBy: 'ui-session', method: 'ui' });
    store.database.prepare("INSERT INTO device_sessions (id, connection_id, device_id, plan_id, approval_id, status, max_commands, commands_used, created_at, expires_at) VALUES ('s1', NULL, 11, ?, ?, 'open', 5, 0, ?, ?)")
      .run(p.id, bearer.id, Date.now(), Date.now() + 600_000);
    assert.ok(ops.findOpenSession(11), 'legacy mode: session usable');
    enroll(svc, authenticator('es256'));
    assert.equal(ops.findOpenSession(11), null, 'enforced: bearer-backed session no longer usable');
  });
});

describe('Revocation', () => {
  test('revocation needs a passkey and the last key cannot be revoked', () => {
    const { svc } = setup();
    const yubi = authenticator('es256');
    const bw = authenticator('ed25519');
    enroll(svc, yubi);
    enroll(svc, bw, 'Bitwarden', yubi);
    let o = svc.assertionOptions('revoke', { subject: bw.id });
    assert.deepEqual(svc.revoke(bw.id, o.challengeId, yubi.get(o)), { revoked: bw.id, by: 'YubiKey 5C' });
    o = svc.assertionOptions('revoke', { subject: yubi.id });
    assert.throws(() => svc.revoke(yubi.id, o.challengeId, yubi.get(o)), (e) => e.code === 'last_credential');
    assert.equal(svc.enforced(), true, 'enforcement cannot be switched off by revoking everything');
  });

  test('a revoke challenge cannot be redirected to a different key', () => {
    const { svc } = setup();
    const yubi = authenticator('es256');
    const bw = authenticator('ed25519');
    enroll(svc, yubi);
    enroll(svc, bw, 'Bitwarden', yubi);
    const o = svc.assertionOptions('revoke', { subject: bw.id });
    assert.throws(() => svc.revoke(yubi.id, o.challengeId, yubi.get(o)), (e) => e.code === 'challenge_mismatch');
  });
});
