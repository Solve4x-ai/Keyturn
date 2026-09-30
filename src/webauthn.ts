/**
 * Human-presence approvals — WebAuthn passkeys (hardware security keys such
 * as a YubiKey, or password-manager passkeys such as Bitwarden).
 *
 * Why: the serve bearer token lives on disk, so anything running as the
 * operator's OS user — including an AI agent — can present it. A WebAuthn
 * assertion with user verification (PIN / touch / biometric) proves a human
 * performed the approval ceremony at that moment; an agent can read files
 * but cannot press a key or type its PIN.
 *
 * Model:
 *  - Once at least one approver credential is enrolled, passkey approval is
 *    ENFORCED: bearer-only approvals are refused and dispatch refuses any
 *    approval that is not method 'webauthn'. There is no API to turn it off.
 *  - The first credential can be enrolled with the bearer token (bootstrap).
 *    Every later enrollment and every revocation requires an assertion from
 *    an existing credential, so an agent cannot add its own key or remove
 *    yours. Revoking the last credential is refused (would reopen bootstrap).
 *  - Each approval challenge is single-use, short-lived, and bound to the
 *    plan id + plan hash. The assertion (authenticatorData, clientDataJSON,
 *    signature) is stored with the approval so it can be re-verified later.
 *
 * Limits (stated plainly): this is not a defense against an agent that edits
 * the SQLite file or the server code as the same OS user — that requires OS
 * account separation. It closes the supported-path hole and makes every
 * approval independently verifiable.
 *
 * No dependencies: minimal CBOR decoder + node:crypto JWK verification.
 * Algorithms: ES256 (-7), EdDSA/Ed25519 (-8), RS256 (-257).
 */
import { createHash, randomBytes, randomUUID, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { EntityStore } from './entity-store.js';

export class WebAuthnError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type Row = Record<string, unknown>;
const CHALLENGE_TTL_MS = 5 * 60_000;
const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');
const fromB64u = (s: unknown): Buffer => {
  if (typeof s !== 'string' || !s) throw new WebAuthnError('invalid_params', 'expected base64url string');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/* ── Minimal CBOR (RFC 8949) — enough for attestation objects + COSE keys ── */
export function cborDecode(buf: Buffer, offset = 0): { value: unknown; offset: number } {
  const ib = buf[offset];
  if (ib === undefined) throw new WebAuthnError('bad_cbor', 'truncated CBOR');
  const major = ib >> 5;
  const info = ib & 0x1f;
  let pos = offset + 1;
  const readLen = (): number => {
    if (info < 24) return info;
    if (info === 24) { const v = buf.readUInt8(pos); pos += 1; return v; }
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new WebAuthnError('bad_cbor', 'indefinite lengths not supported');
  };
  switch (major) {
    case 0: return { value: readLen(), offset: pos };
    case 1: return { value: -1 - readLen(), offset: pos };
    case 2: { const n = readLen(); if (pos + n > buf.length) throw new WebAuthnError('bad_cbor', 'truncated bytes'); return { value: buf.subarray(pos, pos + n), offset: pos + n }; }
    case 3: { const n = readLen(); return { value: buf.subarray(pos, pos + n).toString('utf8'), offset: pos + n }; }
    case 4: {
      const n = readLen(); const arr: unknown[] = [];
      for (let i = 0; i < n; i++) { const r = cborDecode(buf, pos); arr.push(r.value); pos = r.offset; }
      return { value: arr, offset: pos };
    }
    case 5: {
      const n = readLen(); const map = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const k = cborDecode(buf, pos); const v = cborDecode(buf, k.offset);
        map.set(k.value, v.value); pos = v.offset;
      }
      return { value: map, offset: pos };
    }
    case 6: { readLen(); return cborDecode(buf, pos); } // tag: skip the tag number, return the tagged item
    case 7:
      if (info === 20) return { value: false, offset: pos };
      if (info === 21) return { value: true, offset: pos };
      if (info === 22 || info === 23) return { value: null, offset: pos };
      throw new WebAuthnError('bad_cbor', 'unsupported simple/float value');
    default: throw new WebAuthnError('bad_cbor', 'unknown major type');
  }
}

/* ── authenticatorData ──────────────────────────────────────────────── */
export interface AuthData {
  rpIdHash: Buffer; flags: number; up: boolean; uv: boolean; be: boolean; at: boolean;
  signCount: number; aaguid?: string; credentialId?: Buffer; cose?: Map<unknown, unknown>;
}
export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new WebAuthnError('bad_auth_data', 'authenticatorData too short');
  const flags = buf[32]!;
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32), flags,
    up: !!(flags & 0x01), uv: !!(flags & 0x04), be: !!(flags & 0x08), at: !!(flags & 0x40),
    signCount: buf.readUInt32BE(33),
  };
  if (out.at) {
    const aaguid = buf.subarray(37, 53).toString('hex');
    out.aaguid = `${aaguid.slice(0, 8)}-${aaguid.slice(8, 12)}-${aaguid.slice(12, 16)}-${aaguid.slice(16, 20)}-${aaguid.slice(20)}`;
    const len = buf.readUInt16BE(53);
    out.credentialId = buf.subarray(55, 55 + len);
    const cose = cborDecode(buf, 55 + len).value;
    if (!(cose instanceof Map)) throw new WebAuthnError('bad_auth_data', 'credential public key is not a COSE map');
    out.cose = cose;
  }
  return out;
}

/* ── COSE_Key → JWK ─────────────────────────────────────────────────── */
export function coseToJwk(cose: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1); const alg = Number(cose.get(3));
  const bytes = (k: number) => { const v = cose.get(k); if (!Buffer.isBuffer(v)) throw new WebAuthnError('bad_key', `COSE key missing ${k}`); return b64u(v); };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } };
  throw new WebAuthnError('unsupported_alg', `unsupported credential key (kty ${String(kty)}, alg ${alg}) — use ES256, EdDSA, or RS256`);
}

function verifySig(alg: number, jwk: JsonWebKey, data: Buffer, sig: Buffer): boolean {
  const key = { key: jwk, format: 'jwk' as const };
  if (alg === -7) return cryptoVerify('sha256', data, { ...key, dsaEncoding: 'der' }, sig);
  if (alg === -8) return cryptoVerify(null, data, key, sig);
  if (alg === -257) return cryptoVerify('sha256', data, key, sig);
  return false;
}

/** Well-known authenticator models (AAGUID → label) for display only — with
    'none' attestation an AAGUID is self-reported, never proof of hardware. */
const AAGUID_LABELS: Record<string, string> = {
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5 series',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5 series',
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5 series (NFC)',
  '2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey 5 series (NFC)',
  'c5ef55ff-ad9a-4b9f-b580-adebafe026d0': 'YubiKey 5Ci',
  '73bb0cd4-e502-49b8-9c6f-b59445bf720b': 'YubiKey 5 FIPS',
  'd8522d9f-575b-4866-88a9-ba99fa02f35b': 'YubiKey Bio',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
};
export const aaguidLabel = (a: unknown) => (typeof a === 'string' ? AAGUID_LABELS[a] ?? null : null);

export interface ClientCredential {
  id: string; rawId?: string; type?: string;
  response: { clientDataJSON: string; attestationObject?: string; authenticatorData?: string; signature?: string; userHandle?: string | null };
  transports?: string[];
}

export class ApproverService {
  constructor(private readonly store: EntityStore, private readonly rp: { id: string; name: string; origins: string[] }) {}
  private get db() { return this.store.database; }

  /** Active (non-revoked) approver credentials. */
  credentials(): Row[] {
    return this.db.prepare('SELECT id, name, alg, sign_count, transports, aaguid, backup_eligible, created_at, last_used_at FROM approver_credentials WHERE revoked_at IS NULL ORDER BY created_at').all() as Row[];
  }
  /** Passkey approval is enforced as soon as one credential exists. */
  enforced(): boolean {
    return !!this.db.prepare('SELECT 1 FROM approver_credentials WHERE revoked_at IS NULL LIMIT 1').get();
  }

  status() {
    const creds = this.credentials();
    return {
      enforced: creds.length > 0,
      rpId: this.rp.id,
      origins: this.rp.origins,
      credentials: creds.map((c) => ({
        id: String(c.id), shortId: String(c.id).slice(0, 10), name: c.name, alg: c.alg,
        authenticator: aaguidLabel(c.aaguid), aaguid: c.aaguid,
        transports: c.transports ? JSON.parse(String(c.transports)) : [],
        synced: c.backup_eligible === 1, createdAt: c.created_at, lastUsedAt: c.last_used_at,
      })),
    };
  }

  private challenge(purpose: string, extra: { planId?: string | undefined; planHash?: string | undefined; subject?: string | undefined } = {}) {
    const id = randomUUID();
    const challenge = b64u(randomBytes(32));
    const now = Date.now();
    this.db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(now - 3_600_000);
    this.db.prepare('INSERT INTO webauthn_challenges (id, purpose, challenge, plan_id, plan_hash, subject, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, purpose, challenge, extra.planId ?? null, extra.planHash ?? null, extra.subject ?? null, now, now + CHALLENGE_TTL_MS);
    return { id, challenge };
  }

  private consumeChallenge(id: unknown, purpose: string): Row {
    const row = this.db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(String(id ?? '')) as Row | undefined;
    if (!row || row.purpose !== purpose) throw new WebAuthnError('challenge_invalid', 'unknown challenge — start the ceremony again');
    if (row.used_at) throw new WebAuthnError('challenge_used', 'challenge already used');
    if (Number(row.expires_at) < Date.now()) throw new WebAuthnError('challenge_expired', 'challenge expired — start again');
    // Single use, atomically: a replayed assertion finds used_at set.
    const r = this.db.prepare('UPDATE webauthn_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(Date.now(), row.id as string);
    if (Number(r.changes) !== 1) throw new WebAuthnError('challenge_used', 'challenge already used');
    return row;
  }

  private checkClientData(json: Buffer, type: string, challenge: string) {
    let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
    try { cd = JSON.parse(json.toString('utf8')); } catch { throw new WebAuthnError('bad_client_data', 'clientDataJSON is not JSON'); }
    if (cd.type !== type) throw new WebAuthnError('bad_client_data', `expected ${type}`);
    if (cd.challenge !== challenge) throw new WebAuthnError('challenge_mismatch', 'challenge mismatch');
    if (!cd.origin || !this.rp.origins.includes(cd.origin)) throw new WebAuthnError('origin_mismatch', `origin ${cd.origin} is not an allowed approval origin`);
    if (cd.crossOrigin) throw new WebAuthnError('origin_mismatch', 'cross-origin ceremonies are not allowed');
  }

  private checkFlags(ad: AuthData) {
    if (!ad.rpIdHash.equals(sha256(this.rp.id))) throw new WebAuthnError('rp_mismatch', 'authenticator data is for a different relying party');
    if (!ad.up) throw new WebAuthnError('user_not_present', 'user presence not asserted');
    if (!ad.uv) throw new WebAuthnError('user_not_verified', 'user verification (PIN / biometric) is required');
  }

  /* ── Enrollment ─────────────────────────────────────────────────────── */
  registrationOptions(name: string, stepUp?: { challengeId: string; assertion: ClientCredential }) {
    const label = String(name ?? '').trim().slice(0, 64);
    if (!label) throw new WebAuthnError('invalid_params', 'name the key (e.g. "YubiKey 5C" or "Bitwarden")');
    // After bootstrap, adding a key requires an existing key's assertion.
    if (this.enforced()) {
      if (!stepUp) throw new WebAuthnError('step_up_required', 'adding another approver key requires approval with an existing key');
      this.verifyAssertion('enroll', stepUp.challengeId, stepUp.assertion);
    }
    const { id, challenge } = this.challenge('register', { subject: label });
    return {
      challengeId: id,
      publicKey: {
        challenge,
        rp: { id: this.rp.id, name: this.rp.name },
        user: { id: b64u(sha256(`approver:${this.store.connId ?? 'local'}`)), name: 'command-center-approver', displayName: 'Command Center approver' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        timeout: CHALLENGE_TTL_MS,
        attestation: 'none',
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: this.credentials().map((c) => ({ type: 'public-key', id: String(c.id) })),
      },
    };
  }

  register(challengeId: string, cred: ClientCredential) {
    const ch = this.consumeChallenge(challengeId, 'register');
    const clientData = fromB64u(cred?.response?.clientDataJSON);
    this.checkClientData(clientData, 'webauthn.create', String(ch.challenge));
    const att = cborDecode(fromB64u(cred.response.attestationObject)).value;
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnError('bad_attestation', 'attestationObject missing authData');
    const ad = parseAuthData(att.get('authData') as Buffer);
    this.checkFlags(ad);
    if (!ad.at || !ad.credentialId || !ad.cose) throw new WebAuthnError('bad_attestation', 'no attested credential data');
    const { jwk, alg } = coseToJwk(ad.cose);
    const id = b64u(ad.credentialId);
    if (this.db.prepare('SELECT 1 FROM approver_credentials WHERE id = ?').get(id)) throw new WebAuthnError('duplicate', 'this key is already enrolled');
    const transports = Array.isArray(cred.transports) ? cred.transports.filter((t) => typeof t === 'string').slice(0, 6) : [];
    this.db.prepare('INSERT INTO approver_credentials (id, name, public_key_jwk, alg, sign_count, transports, aaguid, backup_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, String(ch.subject ?? 'approver key'), JSON.stringify(jwk), alg, ad.signCount, JSON.stringify(transports), ad.aaguid ?? null, ad.be ? 1 : 0, Date.now());
    return { id, name: ch.subject, authenticator: aaguidLabel(ad.aaguid), alg };
  }

  /* ── Assertions (approve / enroll step-up / revoke) ─────────────────── */
  assertionOptions(purpose: 'approve' | 'enroll' | 'revoke', bind: { planId?: string | undefined; planHash?: string | undefined; subject?: string | undefined } = {}) {
    const creds = this.credentials();
    if (!creds.length) throw new WebAuthnError('no_credentials', 'no approver keys enrolled');
    const { id, challenge } = this.challenge(purpose, bind);
    return {
      challengeId: id,
      publicKey: {
        challenge, rpId: this.rp.id, timeout: CHALLENGE_TTL_MS, userVerification: 'required',
        allowCredentials: creds.map((c) => ({ type: 'public-key', id: String(c.id), transports: c.transports ? JSON.parse(String(c.transports)) : undefined })),
      },
    };
  }

  /** Verify an assertion for `purpose`; returns the credential + challenge binding. */
  verifyAssertion(purpose: string, challengeId: string, cred: ClientCredential) {
    const ch = this.consumeChallenge(challengeId, purpose);
    const row = this.db.prepare('SELECT * FROM approver_credentials WHERE id = ? AND revoked_at IS NULL').get(String(cred?.id ?? '')) as Row | undefined;
    if (!row) throw new WebAuthnError('unknown_credential', 'this key is not an enrolled approver key');
    const clientData = fromB64u(cred.response?.clientDataJSON);
    this.checkClientData(clientData, 'webauthn.get', String(ch.challenge));
    const authData = fromB64u(cred.response?.authenticatorData);
    const ad = parseAuthData(authData);
    this.checkFlags(ad);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    if (!verifySig(Number(row.alg), JSON.parse(String(row.public_key_jwk)), signed, fromB64u(cred.response?.signature))) {
      throw new WebAuthnError('bad_signature', 'signature does not verify against the enrolled key');
    }
    // Counter regression suggests a cloned authenticator. Synced passkeys
    // report 0 forever; only a nonzero counter that moves backward fails.
    const prev = Number(row.sign_count ?? 0);
    if (ad.signCount !== 0 && ad.signCount <= prev) throw new WebAuthnError('counter_regression', 'signature counter did not advance — possible cloned key');
    this.db.prepare('UPDATE approver_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?').run(Math.max(prev, ad.signCount), Date.now(), row.id as string);
    return {
      credentialId: String(row.id), name: String(row.name), challenge: ch,
      evidence: { authenticatorData: cred.response.authenticatorData, clientDataJSON: cred.response.clientDataJSON, signature: cred.response.signature, uv: ad.uv, signCount: ad.signCount },
    };
  }

  /** Approve a plan: the challenge must have been issued for exactly this plan hash. */
  verifyApproval(planId: string, planHash: string, challengeId: string, cred: ClientCredential) {
    const v = this.verifyAssertion('approve', challengeId, cred);
    if (v.challenge.plan_id !== planId || v.challenge.plan_hash !== planHash) {
      throw new WebAuthnError('challenge_mismatch', 'this challenge was issued for a different plan or plan revision');
    }
    return v;
  }

  revoke(targetId: string, challengeId: string, cred: ClientCredential) {
    const v = this.verifyAssertion('revoke', challengeId, cred);
    if (v.challenge.subject !== targetId) throw new WebAuthnError('challenge_mismatch', 'challenge was issued to revoke a different key');
    const active = this.credentials();
    if (!active.some((c) => c.id === targetId)) throw new WebAuthnError('unknown_credential', 'key not found');
    if (active.length <= 1) throw new WebAuthnError('last_credential', 'cannot revoke the last approver key — enroll a replacement first');
    this.db.prepare('UPDATE approver_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), targetId);
    return { revoked: targetId, by: v.name };
  }
}
