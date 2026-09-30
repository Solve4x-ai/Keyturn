// WebAuthn client helpers — thin wrappers over navigator.credentials.
// Uses the native JSON codecs (PublicKeyCredential.parse*OptionsFromJSON /
// credential.toJSON, Chrome 129+) with a manual base64url fallback.
// A YubiKey and a Bitwarden passkey can both be enrolled; at approval time
// the browser offers whichever is present (security key tap or Bitwarden
// prompt) — the choice is the operator's, per ceremony.
import { api, esc } from './core.js';

const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function passkeysSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

/** WebAuthn rejects IP-address origins; ceremonies must run on the RP host. */
export function originOk(status) {
  return (status?.origins || []).includes(location.origin);
}

export function localhostLink(status) {
  const target = (status?.origins || []).find((o) => o.startsWith('http://localhost') || o.startsWith('https://')) || status?.origins?.[0];
  if (!target) return null;
  const token = localStorage.getItem('n1_token') || '';
  return `${target}/?token=${encodeURIComponent(token)}${location.hash}`;
}

function toCreateOptions(pk) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(pk);
  return {
    ...pk,
    challenge: b64uToBuf(pk.challenge),
    user: { ...pk.user, id: b64uToBuf(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}
function toGetOptions(pk) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(pk);
  return { ...pk, challenge: b64uToBuf(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
}
function serialize(cred) {
  if (typeof cred.toJSON === 'function') return cred.toJSON();
  const r = cred.response;
  const out = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, response: { clientDataJSON: bufToB64u(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = bufToB64u(r.attestationObject); out.transports = r.getTransports?.() ?? []; }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData);
    out.response.signature = bufToB64u(r.signature);
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null;
  }
  return out;
}

/** Friendly message for the ways a ceremony ends without a credential. */
export function ceremonyError(e) {
  if (e?.name === 'NotAllowedError') return 'Cancelled or timed out — no key was used.';
  if (e?.name === 'InvalidStateError') return 'That key is already enrolled.';
  if (e?.name === 'SecurityError') return 'The browser refused this origin for passkeys — open the command center on http://localhost.';
  return e?.message ? esc(e.message) : 'Passkey ceremony failed.';
}

export async function createPasskey(publicKey) {
  const cred = await navigator.credentials.create({ publicKey: toCreateOptions(publicKey) });
  const json = serialize(cred);
  // toJSON() nests transports under response; the server reads either.
  if (!json.transports && json.response?.transports) json.transports = json.response.transports;
  return json;
}

export async function getAssertion(publicKey) {
  const cred = await navigator.credentials.get({ publicKey: toGetOptions(publicKey) });
  return serialize(cred);
}

/** One-shot: fetch options for a purpose, run the ceremony, return {challengeId, assertion}. */
export async function assertFor(optionsPath, body = {}) {
  const opts = await api(optionsPath, { method: 'POST', body: JSON.stringify(body) });
  const assertion = await getAssertion(opts.publicKey);
  return { challengeId: opts.challengeId, assertion };
}
