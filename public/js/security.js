// Approval security — enroll / revoke approver passkeys, see what protects
// the approval boundary, and what does not. Route: #/security.
import { api, state, $, esc, ago, fmtTs, toast, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader } from './components.js';
import { passkeysSupported, originOk, localhostLink, createPasskey, assertFor, ceremonyError } from './passkey.js';

/** api() throws "400 {json}" — surface the server's message, not the transport. */
export const apiMessage = (e) => {
  const m = String(e?.message ?? e);
  try { const j = JSON.parse(m.replace(/^\d{3}\s+/, '')); return j.error || m; } catch { return m; }
};

const TRANSPORT_LABEL = { usb: 'USB', nfc: 'NFC', ble: 'Bluetooth', internal: 'Built-in', hybrid: 'Phone', 'smart-card': 'Smart card' };

export function originBanner(status) {
  if (originOk(status)) return '';
  const link = localhostLink(status);
  return `<div class="sec-banner warn">${icon('lock')}<div><strong>Passkeys need the localhost address.</strong>
    Browsers refuse WebAuthn on IP-address origins like <code>${esc(location.host)}</code>. Same server, same data — just a different hostname.
    ${link ? `<div style="margin-top:8px"><a class="btn" href="${esc(link)}">${icon('arrow-ur')} Open on ${esc(new URL(link).host)}</a></div>` : ''}</div></div>`;
}

export async function securityView(el) {
  const s = await api('/api/v1/approver/status');
  const isCommand = s.profile === 'command';
  const canCeremony = passkeysSupported() && originOk(s);
  const sp = s.sessionPolicy;
  el.innerHTML = `
    <div class="security rise" data-view-root="security">
      ${pageHeader({ icon: 'shield', title: 'Approval security', sub: 'Who can approve endpoint work, and how that is proven. Approvals are the only door to execution — this page shows how that door is locked.' })}

      <section class="sec-hero glass ${s.enforced ? 'is-locked' : 'is-open'}">
        <div class="sec-hero-ic">${icon(s.enforced ? 'fingerprint' : 'key')}</div>
        <div class="sec-hero-body">
          <div class="sec-hero-title">${s.enforced ? 'Passkey approvals enforced' : 'Approvals are not human-verified yet'}</div>
          <div class="sec-hero-sub">${s.enforced
            ? `Every approval requires one of your ${s.credentials.length} enrolled key${s.credentials.length === 1 ? '' : 's'} with PIN or biometric verification. Bearer-token approvals are refused, and dispatch rejects any approval that was not passkey-verified.`
            : 'Right now any process that can read the serve token — including an AI agent running as your Windows user — can approve and dispatch plans. Enroll a YubiKey or a Bitwarden passkey to require a human for every approval.'}</div>
        </div>
        <span class="badge ${s.enforced ? 'badge-ok' : 'badge-warn'}"><span class="dot ${s.enforced ? '' : 'live'}"></span>${s.enforced ? 'locked' : 'bearer only'}</span>
      </section>

      ${originBanner(s)}
      ${!isCommand ? `<div class="sec-banner">${icon('eye')}<div>This is the <strong>${esc(s.profile)}</strong> profile server — read-only. Approver keys are managed on the command-profile server.</div></div>` : ''}

      <div class="sec-grid">
        <section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('key')} Approver keys</h2><span class="hc-meta">${s.credentials.length} enrolled</span></div>
          ${s.credentials.length ? `<div class="key-list">${s.credentials.map((c) => `
            <div class="key-card">
              <span class="key-ic">${icon(c.synced ? 'refresh' : 'key')}</span>
              <div class="key-body">
                <div class="key-name">${esc(c.name)}${c.authenticator ? ` <span class="sub">· ${esc(c.authenticator)}</span>` : ''}</div>
                <div class="key-meta">
                  ${(c.transports || []).map((t) => `<span class="badge badge-muted">${esc(TRANSPORT_LABEL[t] ?? t)}</span>`).join('')}
                  ${c.synced ? '<span class="badge badge-info" title="Backup-eligible passkey — may sync across devices via your password manager">synced passkey</span>' : '<span class="badge badge-ok" title="Device-bound credential">device-bound</span>'}
                  <span class="sub">added ${ago(c.createdAt)} · ${c.lastUsedAt ? `last used ${ago(c.lastUsedAt)}` : 'never used'}</span>
                </div>
                <div class="key-id mono-val" title="credential id">${esc(c.shortId)}…</div>
              </div>
              ${isCommand ? `<button class="btn-mini" data-revoke="${esc(c.id)}" data-name="${esc(c.name)}" ${s.credentials.length <= 1 ? 'disabled title="Enroll a replacement before revoking the last key"' : ''}>Revoke</button>` : ''}
            </div>`).join('')}</div>`
            : `<div class="hc-empty">No approver keys yet.</div>`}

          ${isCommand ? `<div class="enroll glass-inset">
            <div class="enroll-title">${icon('fingerprint')} ${s.credentials.length ? 'Add another key' : 'Enroll your first key'}</div>
            <div class="sub">${s.credentials.length
              ? 'Adding a key requires approving with an existing key first — so nothing else can quietly add its own.'
              : 'Insert your YubiKey, or let Bitwarden answer the prompt. Enroll both and you can choose either at approval time.'}</div>
            <div class="enroll-row">
              <input type="text" id="key-name" placeholder="Name this key — e.g. YubiKey 5C, Bitwarden" maxlength="64" />
              <button class="btn" id="key-add" ${canCeremony ? '' : 'disabled'}>${icon('key')} ${s.credentials.length ? 'Add key' : 'Enroll key'}</button>
            </div>
            <div id="key-msg" class="sub" role="status"></div>
          </div>` : ''}
        </section>

        <section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('shield')} What guards execution</h2></div>
          <ul class="guard-list">
            <li class="ok">${icon('check')}<div><strong>Plan → approve → dispatch</strong><span>Every endpoint action is an immutable, hashed plan. Approval binds the exact script, target, and parameters; any change needs a new approval.</span></div></li>
            <li class="ok">${icon('check')}<div><strong>No confirm-flag shortcuts</strong><span>On the MCP surface, endpoint tools without a plan path (run_device_script, reboot, service control, patching, remote control) are refused — <code>confirm:true</code> is not approval.</span></div></li>
            <li class="${s.enforced ? 'ok' : 'warn'}">${icon(s.enforced ? 'check' : 'warn')}<div><strong>Human presence</strong><span>${s.enforced ? 'Approvals require a passkey with user verification; each challenge is single-use and bound to one plan hash. The signed assertion is stored with the approval.' : 'Not yet — enroll a key to require one.'}</span></div></li>
            ${sp ? `<li class="${sp.enabled ? 'warn' : 'ok'}">${icon(sp.enabled ? 'warn' : 'check')}<div><strong>Device sessions</strong><span>${sp.enabled
              ? `Approving a PowerShell plan opens a ${Math.round(sp.ttlSeconds / 60)}-minute session on that device that accepts up to ${sp.maxCommands} further commands <em>without</em> another approval. Set <code>"powershellSessionMaxCommands": 0</code> in <code>config/policy.json</code> to require approval for every command.`
              : 'Disabled — every command needs its own approval.'}</span></div></li>` : ''}
            <li class="info">${icon('eye')}<div><strong>Honest limit</strong><span>Passkeys stop approvals through the supported paths. They cannot stop software that edits the database or server code as your Windows user — that needs a separate OS account for the command center.</span></div></li>
          </ul>
        </section>
      </div>
    </div>`;

  const msg = (t, tone = '') => { const m = $('#key-msg'); if (m) { m.className = `sub ${tone}`; m.innerHTML = t; } };
  $('#key-add')?.addEventListener('click', async () => {
    const name = $('#key-name').value.trim();
    if (!name) { msg('Give the key a name first.', 'warn-text'); $('#key-name').focus(); return; }
    const btn = $('#key-add'); btn.disabled = true;
    try {
      let stepUp;
      if (s.enforced) { msg('Approve with an existing key to authorize adding a new one…'); stepUp = await assertFor('/api/v1/approver/assert/options', { purpose: 'enroll' }); }
      msg(`Touch or unlock <strong>${esc(name)}</strong> now…`);
      const opts = await api('/api/v1/approver/register/options', { method: 'POST', body: JSON.stringify({ name, stepUp }) });
      const credential = await createPasskey(opts.publicKey);
      const r = await api('/api/v1/approver/register', { method: 'POST', body: JSON.stringify({ challengeId: opts.challengeId, credential }) });
      toast(`Enrolled ${r.name}${r.authenticator ? ` (${r.authenticator})` : ''} — approvals now require a passkey`);
      ctx.refreshShell?.();
      ctx.render();
    } catch (e) {
      btn.disabled = false;
      msg(e?.name ? ceremonyError(e) : esc(apiMessage(e)), 'bad-text');
    }
  });
  el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Revoke "${b.dataset.name}"? It will no longer be able to approve anything.`)) return;
    try {
      const { challengeId, assertion } = await assertFor('/api/v1/approver/assert/options', { purpose: 'revoke', subject: b.dataset.revoke });
      await api(`/api/v1/approver/credentials/${encodeURIComponent(b.dataset.revoke)}/revoke`, { method: 'POST', body: JSON.stringify({ challengeId, assertion }) });
      toast(`Revoked ${b.dataset.name}`);
      ctx.render();
    } catch (e) {
      toast(e?.name ? ceremonyError(e).replace(/<[^>]+>/g, '') : apiMessage(e));
    }
  }));
}
