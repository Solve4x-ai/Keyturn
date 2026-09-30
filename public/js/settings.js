// Settings — connector status, credentials, policy editor, MCP client
// config. Route: #/settings. Writes are passkey-gated when approver keys
// exist (same ceremony as plan approval); secrets are write-only.
import { api, esc, ago, fmtTs, toast, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader } from './components.js';
import { passkeysSupported, originOk, assertFor, ceremonyError } from './passkey.js';
import { apiMessage, originBanner } from './security.js';

const ENV_FIELDS = {
  reporting: [
    ['NINJA_CLIENT_ID', 'Client ID', 'text', 'Reporting OAuth app client id'],
    ['NINJA_CLIENT_SECRET', 'Client secret', 'password', 'Leave blank to keep the current value'],
    ['NINJA_BASE_URL', 'Base URL', 'url', 'e.g. https://us2.ninjarmm.com'],
    ['NINJA_SCOPES', 'Scopes', 'text', 'monitoring'],
  ],
  command: [
    ['NINJA_NATIVE_CLIENT_ID', 'Native client ID', 'text', 'Native PKCE app client id'],
    ['NINJA_BASE_URL', 'Base URL', 'url', 'e.g. https://us2.ninjarmm.com'],
    ['NINJA_REDIRECT_URI', 'Redirect URI', 'url', 'e.g. http://127.0.0.1'],
    ['NINJA_SCOPES', 'Scopes', 'text', 'monitoring management offline_access'],
  ],
};

const POLICY_FLAGS = [
  ['ticketWritesEnabled', 'Ticket writes', 'create/update tickets and comments'],
  ['deviceManagementEnabled', 'Device management', 'approve/reboot/service control'],
  ['administrativeWritesEnabled', 'Administrative writes', 'org/location/contact changes'],
  ['deviceScriptsEnabled', 'Device scripts', 'run scripts and PowerShell plans'],
  ['softwareDeploymentEnabled', 'Software deployment', 'install/uninstall software'],
  ['remoteControlEnabled', 'Remote control', 'remote-control sessions'],
  ['destructiveOperationsEnabled', 'Destructive operations', 'delete/remove actions'],
  ['reviewWritesEnabled', 'Review writes', 'Review Center answers/decisions (local)'],
];

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const dot = (ok) => `<span class="dot" style="color:var(--${ok ? 'ok' : 'warn'})"></span>`;

export async function settingsView(el) {
  const [s, approverStatus, orgs] = await Promise.all([
    api('/api/v1/settings'),
    api('/api/v1/approver/status').catch(() => null),
    api('/api/v1/organizations').catch(() => ({ organizations: [] })),
  ]);
  const enforced = !!approverStatus?.enforced;
  const isCommand = s.profile === 'command';
  const pol = s.policy?.value ?? {};
  const orgList = orgs.organizations ?? [];
  const canCeremony = passkeysSupported() && (!approverStatus || originOk(approverStatus));
  const ro = !isCommand; // settings writes run on the command-profile server only
  const lock = ro ? 'disabled title="Settings changes run on the command-profile server"' : '';
  // One ceremony for every gated write; undefined in bootstrap posture (no keys enrolled).
  const stepUpFor = async (subject) => {
    if (!enforced) return undefined;
    if (!canCeremony) throw new Error('Passkey ceremony unavailable — open this page via http://localhost');
    return assertFor('/api/v1/approver/assert/options', { purpose: 'settings', subject });
  };
  const failText = (err) => (err?.name && err.name !== 'Error' ? ceremonyError(err).replace(/<[^>]+>/g, '') : apiMessage(err));

  const profileRow = (p) => {
    const f = ENV_FIELDS[p.profile];
    const token = p.token;
    return `
    <div class="conn-row">
      <div class="conn-head">
        ${dot(p.configured)}
        <div class="conn-title">${p.profile === 'reporting' ? 'Reporting' : 'Command'} <span class="sub">${p.profile === 'reporting' ? 'client credentials · read API' : 'native PKCE · write API'}</span></div>
        <span class="badge ${p.configured ? 'badge-ok' : 'badge-warn'}">${p.configured ? 'configured' : 'missing: ' + esc(p.missing.join(', '))}</span>
      </div>
      <div class="conn-meta">
        ${p.clientId ? `<span class="mono-val" title="client id">${esc(p.clientId)}</span>` : ''}
        ${p.baseUrl ? `<span class="sub">${esc(p.baseUrl)}</span>` : ''}
        ${token ? `<span class="sub">token saved ${token.savedAt ? ago(token.savedAt) : '—'}${token.scope ? ` · <code>${esc(token.scope)}</code>` : ''}</span>` : p.profile === 'command' ? '<span class="sub warn-text">no token — reconnect to authorize</span>' : ''}
      </div>
      <div class="conn-actions">
        <button class="btn-mini" data-test="${p.profile}" ${p.profile === 'command' ? lock : ''}>${icon('pulse')} Test credentials</button>
        ${p.profile === 'command' && isCommand ? `<button class="btn-mini" id="reconnect-btn">${icon('refresh')} Reconnect via browser</button>` : ''}
        <button class="btn-mini btn-ghost" data-envtoggle="${p.profile}">${icon('settings')} Edit credentials</button>
      </div>
      <div class="conn-test" id="test-${p.profile}" role="status"></div>
      ${p.profile === 'command' ? '<div class="conn-test" id="reconnect-status" role="status"></div>' : ''}
      <form class="env-form" id="env-${p.profile}" hidden>
        ${f.map(([key, label, type, hint]) => `
          <label class="env-field"><span class="env-label">${esc(label)}</span>
            <input type="${type}" name="${key}" ${type === 'url' ? 'list="ninja-regions"' : ''} placeholder="${esc(hint)}" autocomplete="off" spellcheck="false" />
          </label>`).join('')}
        <div class="env-foot">
          <button type="submit" class="btn-mini" ${lock}>${icon('check')} Save ${p.profile} credentials</button>
          <span class="sub">writes <code>config/${p.profile}.env</code> · takes effect on restart${enforced ? ' · passkey required' : ''}</span>
        </div>
      </form>
    </div>`;
  };

  el.innerHTML = `
    <datalist id="ninja-regions">
      <option value="https://app.ninjarmm.com">us</option><option value="https://us2.ninjarmm.com">us2</option>
      <option value="https://eu.ninjarmm.com">eu</option><option value="https://ca.ninjarmm.com">ca</option>
      <option value="https://oc.ninjarmm.com">oc</option>
    </datalist>
    <div class="security rise" data-view-root="settings">
      ${pageHeader({ icon: 'settings', title: 'Settings', sub: 'Connector credentials, the safety policy, and MCP client wiring. Writes here change the boundaries agents operate under — passkey-protected when a key is enrolled.' })}
      ${approverStatus ? originBanner(approverStatus) : ''}
      ${ro ? `<div class="sec-banner info">${icon('lock')}<div><strong>Read-only here.</strong> This server runs the <code>${esc(s.profile)}</code> profile — credential, policy, and client-config changes are made from the command-profile server.</div></div>` : ''}
      ${!enforced ? `<div class="sec-banner warn">${icon('warn')}<div><strong>No approver key enrolled.</strong> Settings writes are not human-verified — any local process holding the serve token could change them. <a href="#/security" data-nav="security">Enroll a passkey</a> to require one.</div></div>` : ''}

      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('network')} Connector — NinjaOne</h2><span class="hc-meta">first connector · RMM-agnostic design</span></div>
        ${s.profiles.map(profileRow).join('')}
      </section>

      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('shield')} Safety policy</h2>
          <span class="hc-meta">${s.policy?.present ? `<code>${esc(s.policy.path)}</code>${s.policy.hash ? ` · ${esc(s.policy.hash)}` : ''}` : 'no policy file — safe defaults'}</span></div>
        ${s.policy?.error ? `<div class="sec-banner warn">${icon('warn')}<div>Policy file failed to parse: ${esc(s.policy.error)}</div></div>` : ''}
        <form id="policy-form">
          <div class="pol-grid">
            <div>
              <div class="env-label" style="margin-bottom:8px">Allowed organizations</div>
              ${orgList.length ? orgList.map((o) => `
                <label class="pol-check"><input type="checkbox" name="org" value="${o.org_id}" ${(pol.allowedOrganizationIds ?? []).includes(o.org_id) ? 'checked' : ''} /> ${esc(o.name)} <span class="sub">#${o.org_id}</span></label>`).join('')
                : '<div class="sub">No organizations in the local store yet — sync first, or edit the file directly.</div>'}
              <label class="env-field" style="margin-top:10px"><span class="env-label">Default organization</span>
                <select name="defaultOrg"><option value="">—</option>
                  ${orgList.map((o) => `<option value="${o.org_id}" ${pol.defaultOrganizationId === o.org_id ? 'selected' : ''}>${esc(o.name)} #${o.org_id}</option>`).join('')}
                </select></label>
            </div>
            <div>
              <div class="env-label" style="margin-bottom:8px">Write categories</div>
              ${POLICY_FLAGS.map(([key, label, hint]) => `
                <label class="pol-check" title="${esc(hint)}"><input type="checkbox" name="flag" value="${key}" ${pol[key] ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}
            </div>
            <div>
              <label class="env-field"><span class="env-label">PowerShell runner script ID</span>
                <input type="number" name="runnerId" min="1" value="${pol.powershellRunnerScriptId ?? ''}" placeholder="saved script id" /></label>
              <label class="env-field"><span class="env-label">Session TTL (seconds)</span>
                <input type="number" name="sessionTtl" min="1" value="${pol.powershellSessionTtlSeconds ?? ''}" placeholder="default" /></label>
              <label class="env-field"><span class="env-label">Session max commands (0 = every command needs approval)</span>
                <input type="number" name="sessionMax" min="0" value="${pol.powershellSessionMaxCommands ?? ''}" placeholder="default" /></label>
              <label class="env-field"><span class="env-label">Blocked tools (comma-separated)</span>
                <input type="text" name="blocked" value="${esc((pol.blockedActions ?? []).join(', '))}" spellcheck="false" /></label>
            </div>
          </div>
          <div class="env-foot">
            <button type="submit" class="btn" ${lock}>${icon('check')} Save policy</button>
            <span class="sub">applies to this server instantly · restart MCP clients to pick it up${enforced ? ' · passkey required' : ''}</span>
          </div>
          <div id="policy-msg" class="sub" role="status"></div>
        </form>
      </section>

      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('terminal')} MCP clients</h2><span class="hc-meta">restart the client after merging</span></div>
        ${s.clients.map((c) => `
          <div class="conn-row">
            <div class="conn-head">
              ${dot(c.detected)}
              <div class="conn-title">${esc(c.name)} <span class="sub">${c.format.toUpperCase()}</span></div>
              <span class="badge ${c.detected ? 'badge-ok' : 'badge-muted'}">${c.detected ? 'config found' : 'not found'}</span>
            </div>
            <div class="conn-meta"><code>${esc(c.path)}</code></div>
            <div class="conn-actions">
              <button class="btn-mini" data-merge="${c.id}" ${lock}>${icon('check')} Merge into config</button>
              <button class="btn-mini btn-ghost" data-copy="${c.id}">${icon('eye')} Copy block</button>
            </div>
          </div>`).join('')}
        <div class="sub" style="margin-top:10px">Both register <code>ninjaone-command</code> and <code>ninjaone-reporting</code> stdio servers pointing at this install. Merge keeps your other servers and writes a <code>.bak</code> first.</div>
      </section>

      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('cpu')} Runtime</h2></div>
        <div class="glance-strip">
          <div class="glance-cell"><div class="glance-k">Profile</div><div class="glance-v">${esc(s.profile)}</div></div>
          <div class="glance-cell"><div class="glance-k">Uptime</div><div class="glance-v">${ago(Date.now() - s.runtime.uptimeSec * 1000)}</div></div>
          <div class="glance-cell"><div class="glance-k">Install root</div><div class="glance-v"><code>${esc(s.runtime.root)}</code></div></div>
          <div class="glance-cell"><div class="glance-k">Serve token</div><div class="glance-v"><code>${esc(s.runtime.serveTokenPath)}</code></div></div>
        </div>
      </section>
    </div>`;

  /* ── Credential tests ── */
  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const out = el.querySelector(`#test-${b.dataset.test}`);
    b.disabled = true; out.innerHTML = '<span class="sub">testing…</span>';
    try {
      const r = await api('/api/v1/settings/test', { method: 'POST', body: JSON.stringify({ profile: b.dataset.test }) });
      out.innerHTML = `<span class="${r.ok ? 'ok-text' : 'bad-text'}">${r.ok ? icon('check') : icon('warn')} ${esc(r.detail)}</span>`;
    } catch (e) { out.innerHTML = `<span class="bad-text">${esc(apiMessage(e))}</span>`; }
    b.disabled = false;
  }));

  /* ── Env edit forms ── */
  el.querySelectorAll('[data-envtoggle]').forEach((b) => b.addEventListener('click', () => {
    const form = el.querySelector(`#env-${b.dataset.envtoggle}`);
    if (form) form.hidden = !form.hidden;
  }));
  el.querySelectorAll('.env-form').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const profile = form.id.replace('env-', '');
    const values = {};
    for (const [key] of ENV_FIELDS[profile]) {
      const v = form.elements[key]?.value?.trim();
      if (v) values[key] = v;
    }
    if (!Object.keys(values).length) { toast('Nothing to save — all fields blank'); return; }
    try {
      const stepUp = await stepUpFor(`env:${profile}:${await sha256hex(JSON.stringify(values))}`);
      const r = await api('/api/v1/settings/env', { method: 'POST', body: JSON.stringify({ profile, values, stepUp }) });
      toast(`Saved ${r.updated.length} key(s) — restart the server to apply`);
      form.reset(); form.hidden = true;
    } catch (err) {
      toast(failText(err));
    }
  }));

  /* ── In-app PKCE reconnect ── */
  const rcBtn = el.querySelector('#reconnect-btn');
  const rcOut = el.querySelector('#reconnect-status');
  if (rcBtn) {
    let polling = null;
    const startPolling = () => {
      clearInterval(polling);
      polling = setInterval(() => (document.body.contains(el) ? poll() : clearInterval(polling)), 1500);
    };
    const poll = () => api('/api/v1/settings/reconnect/status').then((r) => {
      if (r.state === 'done') { clearInterval(polling); rcOut.innerHTML = `<span class="ok-text">${icon('check')} Authorized — token saved. No restart needed.</span>`; rcBtn.disabled = false; toast('Command token refreshed'); }
      else if (r.state === 'error') { clearInterval(polling); rcOut.innerHTML = `<span class="bad-text">${icon('warn')} ${esc(r.error || 'failed')}</span>`; rcBtn.disabled = false; }
      else if (r.state === 'exchanging') rcOut.innerHTML = '<span class="sub">consent received — exchanging token…</span>';
    }).catch(() => { clearInterval(polling); rcBtn.disabled = false; });
    rcBtn.addEventListener('click', async () => {
      rcBtn.disabled = true;
      try {
        const stepUp = await stepUpFor('reconnect:command');
        const r = await api('/api/v1/settings/reconnect/start', { method: 'POST', body: JSON.stringify({ stepUp }) });
        if (r.state === 'error') { rcOut.innerHTML = `<span class="bad-text">${esc(r.error)}</span>`; rcBtn.disabled = false; return; }
        rcOut.innerHTML = `<span class="sub">waiting for consent — approve in the browser tab that just opened${r.authorizationUrl ? ` · <a href="${esc(r.authorizationUrl)}" target="_blank" rel="noopener">open manually</a>` : ''}</span>`;
        startPolling();
      } catch (e) { rcOut.innerHTML = `<span class="bad-text">${esc(failText(e))}</span>`; rcBtn.disabled = false; }
    });
    // Resume an attempt already in flight (page reload / navigation back).
    api('/api/v1/settings/reconnect/status').then((r) => {
      if (r.state !== 'waiting' && r.state !== 'exchanging') return;
      rcBtn.disabled = true;
      rcOut.innerHTML = '<span class="sub">waiting for consent in the browser…</span>';
      startPolling();
    }).catch(() => {});
  }

  /* ── Policy save ── */
  el.querySelector('#policy-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const policy = {
      allowedOrganizationIds: [...form.querySelectorAll('input[name=org]:checked')].map((i) => Number(i.value)),
      blockedActions: (form.elements.blocked.value || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    const defOrg = Number(form.elements.defaultOrg.value);
    if (defOrg > 0) policy.defaultOrganizationId = defOrg;
    for (const [key] of POLICY_FLAGS) policy[key] = [...form.querySelectorAll('input[name=flag]:checked')].some((i) => i.value === key);
    const runner = Number(form.elements.runnerId.value);
    if (runner > 0) policy.powershellRunnerScriptId = runner;
    const ttl = Number(form.elements.sessionTtl.value);
    if (ttl > 0) policy.powershellSessionTtlSeconds = ttl;
    const max = form.elements.sessionMax.value;
    if (max !== '') policy.powershellSessionMaxCommands = Number(max);
    const msg = el.querySelector('#policy-msg');
    try {
      if (enforced) msg.innerHTML = '<span class="sub">approve this change with your passkey…</span>';
      const stepUp = await stepUpFor(`policy:${await sha256hex(JSON.stringify(policy))}`);
      const r = await api('/api/v1/settings/policy', { method: 'POST', body: JSON.stringify({ policy, stepUp }) });
      msg.innerHTML = r.applied
        ? `<span class="ok-text">${icon('check')} Saved ${esc(r.hash.slice(0, 16))} — live on this server now. Restart MCP clients to apply there.</span>`
        : `<span class="warn-text">${icon('warn')} Saved, but this server was started without <code>NINJA_POLICY_PATH</code> and is running built-in safe defaults — set it in the profile's env file and restart to apply.</span>`;
      toast(`Policy updated by ${r.actor}`);
    } catch (err) {
      msg.innerHTML = `<span class="bad-text">${esc(failText(err))}</span>`;
    }
  });

  /* ── MCP client merge / copy ── */
  el.querySelectorAll('[data-merge]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const stepUp = await stepUpFor(`mcp:${b.dataset.merge}`);
      const r = await api('/api/v1/settings/mcp-config/merge', { method: 'POST', body: JSON.stringify({ client: b.dataset.merge, stepUp }) });
      toast(`Merged into ${r.path}${r.backup ? ' (backup saved)' : ''} — restart the client`);
    } catch (e) { toast(failText(e)); }
    b.disabled = false;
  }));
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/v1/settings/mcp-config?client=${encodeURIComponent(b.dataset.copy)}`);
      await navigator.clipboard.writeText(r.client.format === 'json' ? `{ ${r.block} }` : r.block);
      toast(`${r.client.name} config block copied`);
    } catch (e) { toast(apiMessage(e)); }
  }));
}
