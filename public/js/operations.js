// Operation surfaces: approval queue, plan review, operation detail.
// Externally-created plans (MCP harnesses) land here for the human — the
// approval boundary is this page. With approver passkeys enrolled, approval
// is a WebAuthn ceremony bound to the plan hash; nothing an agent can do
// with the bearer token alone will pass it.
import { api, state, $, esc, ago, fmtTs, toast, ctx } from './core.js';
import { pageHeader, statCard } from './components.js';
import { icon } from './icons.js';
import { STATUS_BADGE } from './library.js';
import { passkeysSupported, originOk, assertFor, ceremonyError } from './passkey.js';
import { apiMessage, originBanner } from './security.js';

const left = (ts) => {
  const s = Math.max(0, Math.round((Number(ts) - Date.now()) / 1000));
  return s <= 0 ? 'expired' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/* Live countdowns for any [data-expires] on the page — self-stopping. */
function tickExpiries(root) {
  const t = setInterval(() => {
    const els = root.querySelectorAll('[data-expires]');
    if (!els.length || !document.body.contains(root)) return clearInterval(t);
    els.forEach((e) => {
      const txt = left(e.dataset.expires);
      e.textContent = txt;
      e.closest('.plan-card, .plan-hero')?.classList.toggle('is-expired', txt === 'expired');
    });
  }, 1000);
}

function wireOpRows(el) {
  el.querySelectorAll('tr[data-op]').forEach((tr) => {
    const go = () => { state.view = 'operation'; state.opId = tr.dataset.op; ctx.nav(); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

function approvalModeBanner(status) {
  if (!status) return '';
  if (status.enforced) {
    return `<div class="sec-banner ok">${icon('fingerprint')}<div><strong>Passkey approvals enforced.</strong> Approving requires one of your enrolled keys with PIN or biometric — an AI agent holding the serve token cannot approve.</div><a class="btn-mini" href="#/security">Keys ${icon('arrow-ur')}</a></div>`;
  }
  return `<div class="sec-banner warn">${icon('warn')}<div><strong>Approvals are not human-verified.</strong> Any process that can read the serve token can approve and dispatch these plans. Enroll a YubiKey or Bitwarden passkey to lock this down.</div><a class="btn" href="#/security">${icon('key')} Enroll a key</a></div>`;
}

/** Global queue: every unconsumed live plan, regardless of source. */
export async function approvalsView(el) {
  const [{ plans }, { operations }, status] = await Promise.all([
    api('/api/v1/plans'),
    api('/api/v1/operations?limit=12'),
    api('/api/v1/approver/status').catch(() => null),
  ]);
  const pending = plans.filter((p) => !p.approval_id);
  const approved = plans.filter((p) => p.approval_id);
  const day = operations.filter((o) => Date.now() - Number(o.created_at) < 86_400_000);
  el.innerHTML = `
    <div data-view-root="approvals">
    ${pageHeader({ icon: 'approvals', title: 'Approvals', sub: 'Plans proposed by your AI clients wait here for a human decision. Approval binds the exact script, target, and parameters — nothing runs until you approve.' })}
    ${approvalModeBanner(status)}
    <div class="stat-row">
      ${statCard({ icon: 'key', tone: pending.length ? 'warn' : 'muted', value: pending.length, label: 'Awaiting you', sub: pending.length ? 'review before they expire' : 'queue clear' })}
      ${statCard({ icon: 'check', tone: approved.length ? 'info' : 'muted', value: approved.length, label: 'Approved, not dispatched', sub: 'approval still live' })}
      ${statCard({ icon: 'terminal', tone: 'accent', value: day.length, label: 'Dispatched · 24h', sub: `${day.filter((o) => o.status === 'verified').length} verified`, go: true, data: 'ops' })}
      ${statCard({ icon: status?.enforced ? 'fingerprint' : 'shield', tone: status?.enforced ? 'ok' : 'warn', value: status?.enforced ? 'Passkey' : 'Bearer', label: 'Approval mode', sub: status?.enforced ? `${status.credentials.length} key(s) enrolled` : 'not human-verified', go: true, data: 'sec' })}
    </div>

    <div class="section-title">${icon('key')} Awaiting approval</div>
    ${pending.length ? `<div class="plan-grid">${pending.map((p) => {
      const rb = p.args?.runbook; const sel = p.args?.selection;
      return `<button class="plan-card glass" data-review-plan="${esc(p.id)}">
        <div class="pc-top"><span class="icon-tile tile-warn">${icon(rb ? 'book' : 'terminal')}</span>
          <div style="min-width:0"><div class="pc-title">${esc(rb ? rb.id : p.operation)}${rb ? ` <span class="sub">v${rb.version}</span>` : ''}</div>
          <div class="pc-target">${sel ? `${icon('layers')} batch · ${(sel.memberIds || []).length} devices` : `${icon('devices')} ${esc(p.device_label || `device ${p.target_id}`)}`}</div></div></div>
        <div class="pc-cmd mono-val">${esc(String(p.args?.command ?? '').split('\n').find((l) => l.trim()) ?? '').slice(0, 110)}</div>
        <div class="pc-foot"><span class="sub">from <strong>${esc(p.principal || 'unknown')}</strong> · ${ago(p.created_at)}</span><span class="pc-exp">${icon('clock')} <span data-expires="${p.expires_at}">${left(p.expires_at)}</span></span></div>
      </button>`;
    }).join('')}</div>` : `<div class="all-clear glass-inset">${icon('shield')}<div><strong>Nothing awaiting approval</strong><div class="sub">When an AI client proposes endpoint work, the plan appears here with the exact script to review.</div></div></div>`}

    <div class="section-title" style="margin-top:var(--sp-5)">${icon('terminal')} Recent operations <a class="hc-link" href="#/operations">All operations ${icon('arrow-ur')}</a></div>
    ${operations.length ? `<div class="panel"><table class="data"><thead><tr><th>Status</th><th>Target</th><th>Operation</th><th>Started</th></tr></thead><tbody>
      ${operations.map((op) => `<tr class="clickable" tabindex="0" data-op="${esc(op.id)}">
        <td><span class="badge ${STATUS_BADGE[op.status] || 'badge-muted'}"><span class="dot"></span>${esc(op.status)}</span></td>
        <td class="mono-val">${esc(op.target_type === 'selection' ? 'batch' : (op.device_label || `device ${op.target_id}`))}</td>
        <td>${esc(op.runbook_id || op.operation)}${op.runbook_version ? ` <span class="sub">v${op.runbook_version}</span>` : ''}</td>
        <td class="sub">${ago(op.created_at)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No operations yet</div>'}
    </div>`;
  el.querySelectorAll('[data-review-plan]').forEach((btn) =>
    btn.addEventListener('click', () => { state.view = 'plan'; state.planId = btn.dataset.reviewPlan; ctx.nav(); }));
  el.querySelectorAll('.stat-card[data-go]').forEach((c) => c.addEventListener('click', () => { location.hash = c.dataset.go === 'ops' ? '#/operations' : '#/security'; }));
  wireOpRows(el);
  tickExpiries(el);
}

/** Plan review — the page a harness's reviewUrl lands on. */
export async function planView(el) {
  const p = await api(`/api/v1/plans/${state.planId}`);
  const rbRef = p.args?.runbook;
  const sel = p.args?.selection;
  const isCommand = state.meta?.principal?.profile === 'command';
  const [status, rb, selDetail] = await Promise.all([
    api('/api/v1/approver/status').catch(() => null),
    rbRef ? api(`/api/v1/runbooks/${encodeURIComponent(rbRef.id)}`).then((r) => r.runbook).catch(() => null) : null,
    sel?.selectionId ? api(`/api/v1/selections/${sel.selectionId}`).catch(() => null) : null,
  ]);
  const liveApproval = (p.approvals || []).find((a) => !a.consumed_by && a.expires_at > Date.now() && (!status?.enforced || a.method === 'webauthn'));
  const memberIds = sel?.memberIds || [];
  const enforced = !!status?.enforced;
  const ceremonyReady = enforced && passkeysSupported() && originOk(status);
  const sp = status?.sessionPolicy;
  const opensSession = !sel && sp?.enabled;
  const script = String(p.args?.command ?? '');
  const lines = script.split('\n');
  const classification = rb?.classification ?? (rbRef ? null : 'custom');
  const canAct = isCommand && !p.expired && !p.operation;

  el.innerHTML = `
    <div data-view-root="plan">
    <a class="back-link" href="#/approvals">${icon('chev-r')} Approvals</a>
    <section class="plan-hero glass ${p.expired ? 'is-expired' : ''}">
      <span class="icon-tile tile-${p.expired ? 'muted' : 'warn'}">${icon(rbRef ? 'book' : 'terminal')}</span>
      <div class="ph-body">
        <div class="ph-kicker">Plan review${sel ? ' · batch' : ''}</div>
        <h1 class="ph-title">${esc(rb?.title ?? (rbRef ? rbRef.id : 'Custom PowerShell'))}</h1>
        <div class="ph-sub">${sel ? `${memberIds.length} devices${selDetail?.orgName ? ` in ${esc(selDetail.orgName)}` : ''}` : `on <a href="#/device/${p.target_id}/overview">${esc(p.device_label || `device ${p.target_id}`)}</a>`} · proposed by <strong>${esc(p.principal || 'unknown')}</strong> ${ago(p.created_at)}</div>
      </div>
      <div class="ph-exp">${p.operation ? `<span class="badge ${STATUS_BADGE[p.operation.status] || 'badge-muted'}">dispatched · ${esc(p.operation.status)}</span>`
        : p.expired ? '<span class="badge badge-bad">expired</span>'
        : `<div class="ph-exp-k">expires in</div><div class="ph-exp-v" data-expires="${p.expires_at}">${left(p.expires_at)}</div>`}</div>
    </section>

    <div class="plan-layout">
      <div class="plan-main">
        <section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('terminal')} Exact script to execute</h2><span class="hc-meta">${lines.length} line${lines.length === 1 ? '' : 's'} · runs as SYSTEM</span>
            <button class="btn-mini" id="copy-script" style="margin-left:8px">Copy</button></div>
          <pre class="term code-lines">${lines.map((l, i) => `<span class="cl"><span class="ln">${i + 1}</span><span class="lc">${esc(l) || ' '}</span></span>`).join('')}</pre>
          <div class="hc-note">This is the complete text bound into the plan hash. Approving authorizes exactly this — a changed character means a new plan and a new approval.</div>
        </section>
        ${p.args?.params && Object.keys(p.args.params).length ? `<section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('layers')} Parameters</h2><span class="hc-meta">validated server-side, passed as data</span></div>
          <dl class="kv">${Object.entries(p.args.params).map(([k, v]) => `<dt class="mono-val">${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd>`).join('')}</dl>
        </section>` : ''}
        ${sel ? `<section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('layers')} Frozen target set</h2><span class="hc-meta">evaluated ${fmtTs(sel.evaluatedAt)}</span></div>
          <div class="sub">Membership is sealed into the plan hash — approval binds exactly these ${memberIds.length} devices, never a re-evaluated filter.</div>
          ${p.args?.canarySize ? `<div class="sec-banner warn" style="margin:8px 0 0">${icon('bolt')}<div><strong>Canary: ${p.args.canarySize} first.</strong> The rest hold until all canaries verify, or you release them manually.</div></div>` : ''}
          <details class="identity-details"><summary>Members (${memberIds.length})${selDetail?.exclusions?.length ? ` — ${selDetail.exclusions.length} excluded` : ''}</summary>
            <div class="member-chips">${memberIds.map((id, i) => `<span class="badge ${i < (p.args?.canarySize ?? 0) ? 'badge-warn' : 'badge-muted'}">${esc(id)}</span>`).join('')}</div>
            ${selDetail?.exclusions?.length ? `<div class="sub" style="margin-top:6px">Excluded: ${selDetail.exclusions.map((x) => esc(x.deviceId ? `${x.deviceId} (${x.reason})` : x.reason)).join('; ')}</div>` : ''}
          </details>
        </section>` : ''}
      </div>

      <aside class="plan-side">
        <section class="hud-card glass">
          <div class="hc-head"><h2 class="hc-title">${icon('warn')} Impact</h2></div>
          <div class="impact-rows">
            <div><span class="ik">Classification</span><span class="badge ${classification === 'read' ? 'badge-ok' : classification === 'modify' ? 'badge-warn' : 'badge-bad'}">${esc(classification ?? 'unknown')}</span></div>
            ${rb ? `<div><span class="ik">Disruption</span><span>${esc(rb.disruption)}</span></div>
              <div><span class="ik">Affected scope</span><span>${esc(rb.affectedScope)}</span></div>
              <div><span class="ik">Side effects</span><span>${esc(rb.sideEffects)}</span></div>
              <div><span class="ik">Review</span><span>${rb.review ? `${esc(rb.review.status)} · ${esc(rb.review.reviewedBy)}` : '—'}</span></div>`
              : '<div class="sub">Custom script — not a reviewed runbook. Read every line above; the command center cannot tell you whether it is safe.</div>'}
            ${opensSession ? `<div class="session-warn">${icon('clock')}<span>Approving also opens a <strong>${Math.round(sp.ttlSeconds / 60)}-minute session</strong> on this device: up to <strong>${sp.maxCommands} more commands</strong> from your AI client can run there <em>without</em> another approval.</span></div>` : ''}
          </div>
        </section>

        <section class="hud-card glass approve-card">
          <div class="hc-head"><h2 class="hc-title">${icon(enforced ? 'fingerprint' : 'key')} Decision</h2></div>
          ${p.operation ? `<div class="sub">Dispatched as <a href="#/operation/${esc(p.operation.id)}">operation ${esc(p.operation.id.slice(0, 8))}…</a></div>`
            : !isCommand ? '<div class="sub">Reporting profile — read-only. Approvals happen on the command-profile server.</div>'
            : p.expired ? '<div class="sub">This plan expired. Ask your AI client to re-plan if the work is still needed.</div>'
            : `${liveApproval ? `<div class="sec-banner ok" style="margin:0 0 10px">${icon('check')}<div>Approved ${ago(liveApproval.created_at)} by <strong>${esc(liveApproval.approved_by)}</strong> — ready to dispatch.</div></div>` : ''}
              ${enforced && !originOk(status) ? originBanner(status) : ''}
              ${!enforced ? `<div class="sec-banner warn" style="margin:0 0 10px">${icon('warn')}<div>No approver key enrolled — this approval will be recorded as <code>ui-session</code>, indistinguishable from any process holding the token. <a href="#/security">Enroll a key</a>.</div></div>` : ''}
              <button class="btn approve-btn" id="plan-approve" ${enforced && !ceremonyReady && !liveApproval ? 'disabled' : ''}>
                ${icon(liveApproval ? 'bolt' : enforced ? 'fingerprint' : 'check')} ${liveApproval ? 'Dispatch now' : enforced ? 'Approve with passkey & dispatch' : 'Approve & dispatch'}</button>
              <div class="sub" style="margin-top:8px">${enforced ? 'Your browser will ask for your YubiKey or Bitwarden passkey. The signed assertion is stored with the approval.' : 'Dispatch runs through the operation pipeline; the receipt appears on the operation page.'}</div>`}
          <div id="plan-msg" role="status"></div>
        </section>

        <details class="hud-card glass"><summary class="hc-title" style="cursor:pointer">${icon('history')} Provenance</summary>
          <dl class="kv" style="margin-top:10px">
            <dt>Plan id</dt><dd class="mono-val">${esc(p.id)}</dd>
            <dt>Plan hash</dt><dd class="mono-val">${esc(p.plan_hash)}</dd>
            ${rb ? `<dt>Script digest</dt><dd class="mono-val">${esc(rbRef.digest ?? rb.digest)}</dd>` : ''}
            <dt>Created</dt><dd>${fmtTs(p.created_at)}</dd>
            ${(p.approvals || []).map((a) => `<dt>Approval</dt><dd>${esc(a.approved_by)} · <span class="badge ${a.method === 'webauthn' ? 'badge-ok' : 'badge-warn'}">${esc(a.method === 'webauthn' ? 'passkey' : a.method)}</span> · ${ago(a.created_at)}${a.consumed_by ? ' · consumed' : ''}</dd>`).join('')}
          </dl>
        </details>
      </aside>
    </div>
    </div>`;

  $('#copy-script')?.addEventListener('click', () => navigator.clipboard.writeText(script).then(() => toast('Script copied')));
  $('#plan-approve')?.addEventListener('click', async () => {
    const btn = $('#plan-approve');
    const msg = (h) => { $('#plan-msg').innerHTML = h; };
    btn.disabled = true;
    try {
      let ap = liveApproval;
      if (!ap) {
        if (enforced) {
          btn.innerHTML = `${icon('fingerprint')} Waiting for your key…`;
          const { challengeId, assertion } = await assertFor(`/api/v1/plans/${encodeURIComponent(p.id)}/approve/options`);
          ap = await api(`/api/v1/plans/${encodeURIComponent(p.id)}/approve`, { method: 'POST', body: JSON.stringify({ challengeId, assertion }) });
        } else {
          ap = await api(`/api/v1/plans/${encodeURIComponent(p.id)}/approve`, { method: 'POST', body: '{}' });
        }
      }
      btn.innerHTML = `${icon('bolt')} Dispatching…`;
      const op = await api(`/api/v1/plans/${encodeURIComponent(p.id)}/execute`, { method: 'POST', body: JSON.stringify({ approvalId: ap.id }) });
      toast('Approved and dispatched');
      state.view = 'operation'; state.opId = op.id;
      ctx.nav();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = `${icon(enforced ? 'fingerprint' : 'check')} Try again`;
      msg(`<div class="error-box">${e?.name ? ceremonyError(e) : esc(apiMessage(e))}</div>`);
    }
  });
  tickExpiries(el);
}

/** Operation detail — receipt, evidence, timeline. Polls while non-terminal. */
export async function operationView(el) {
  const op = await api(`/api/v1/operations/${state.opId}`);
  const r = op.result || {};
  const isBatch = op.target_type === 'selection';
  const terminal = ['verified', 'failed', 'canceled', 'partial'].includes(op.status);
  const isCommand = state.meta?.principal?.profile === 'command';
  let targets = null;
  if (isBatch) {
    try { targets = await api(`/api/v1/operations/${op.id}/targets?limit=200`); } catch { targets = null; }
  }
  const counts = op.targets?.counts || {};
  el.innerHTML = `
    <div data-view-root="operation">
    <a class="back-link" href="#/operations">${icon('chev-r')} Operations</a>
    <section class="plan-hero glass">
      <span class="icon-tile tile-${op.status === 'verified' ? 'ok' : ['failed', 'unknown'].includes(op.status) ? 'bad' : 'info'}">${icon(op.status === 'verified' ? 'check' : 'terminal')}</span>
      <div class="ph-body">
        <div class="ph-kicker">Operation${isBatch ? ' · batch' : ''}</div>
        <h1 class="ph-title">${esc(op.runbook_id || op.operation)}${op.runbook_version ? ` <span class="sub">v${op.runbook_version}</span>` : ''}</h1>
        <div class="ph-sub">${isBatch ? `${op.targets?.total ?? '?'} devices (frozen set)` : `on <a href="#/device/${op.target_id}/overview">${esc(op.device_label || `device ${op.target_id}`)}</a>`} · started ${fmtTs(op.created_at)} · <a href="#/plan/${esc(op.plan_id)}">plan ${esc(String(op.plan_id).slice(0, 8))}…</a></div>
      </div>
      <div class="ph-exp"><span class="badge ${STATUS_BADGE[op.status] || 'badge-muted'}"><span class="dot ${terminal ? '' : 'live'}"></span>${esc(op.status)}</span>${!terminal ? '<div class="sub" style="margin-top:6px">refreshing while in flight…</div>' : ''}</div>
    </section>
    <div class="op-facts">
      ${r.exitCode !== undefined && r.exitCode !== null ? `<div class="glass"><span class="ik">Exit code</span><span class="iv ${r.exitCode === 0 ? 'ok' : 'bad'}">${r.exitCode}</span></div>` : ''}
      ${r.durationMs ? `<div class="glass"><span class="ik">Duration</span><span class="iv">${(r.durationMs / 1000).toFixed(1)}s</span></div>` : ''}
      ${isBatch ? Object.entries(counts).map(([k, v]) => `<div class="glass"><span class="ik">${esc(k)}</span><span class="iv">${v}</span></div>`).join('') : ''}
      ${r.parsed === null && op.runbook_id && !isBatch ? '<div class="glass"><span class="ik">Parse</span><span class="iv warn">raw output only</span></div>' : ''}
    </div>
    ${op.status === 'canary_paused' ? `<div class="sec-banner warn">${icon('bolt')}<div>Canary gate: one or more canary targets failed or went unknown — the remaining ${counts.held ?? 0} target(s) are held. Review the canary results before releasing.</div>
      ${isCommand ? '<button class="btn" id="op-release">Release remainder</button>' : ''}</div>` : ''}
    ${isBatch && targets ? `
      <div class="section-title">Per-target results <span class="sub">(${targets.targets.length} shown)</span></div>
      <div class="panel"><table class="data"><thead><tr><th>#</th><th>Device</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        ${targets.targets.map((t) => `<tr>
          <td class="sub">${t.seq}</td>
          <td><a href="#/device/${t.deviceId}/overview">${esc(t.deviceLabel || `device ${t.deviceId}`)}</a></td>
          <td><span class="badge ${STATUS_BADGE[t.status] || 'badge-muted'}">${esc(t.status)}</span>${t.canary ? ' <span class="badge badge-warn">canary</span>' : ''}</td>
          <td class="sub">${esc(t.error || (t.result ? `exit ${t.result.exitCode ?? '?'}${t.result.parser ? ` · ${t.result.parser}` : ''}` : '—'))}</td>
        </tr>`).join('')}
      </tbody></table></div>` : ''}
    ${r.parsed ? `<div class="section-title">Structured result</div><pre class="term" style="max-height:420px">${esc(JSON.stringify(r.parsed, null, 2))}</pre>` : ''}
    ${r.stdout ? `<details class="identity-details" ${r.parsed ? '' : 'open'}><summary>stdout${r.streamsComplete === false ? ' (partial)' : ''}</summary><pre class="term" style="max-height:420px">${esc(r.stdout)}</pre></details>` : ''}
    ${r.stderr ? `<details class="identity-details"><summary>stderr</summary><pre class="term">${esc(r.stderr)}</pre></details>` : ''}
    <div class="section-title">Timeline</div>
    <div class="timeline op-timeline">${(op.events || []).map((e) => `<div class="tl-row"><span class="tl-dot tl-operation">${icon(/fail|error/.test(e.kind) ? 'warn' : /accept|verif|complete/.test(e.kind) ? 'check' : 'pulse')}</span>
      <span class="tl-body"><span class="tl-title">${esc(String(e.kind).replace(/_/g, ' '))}</span><span class="tl-sub">${esc(e.data ? JSON.stringify(e.data).slice(0, 180) : '')}</span></span><span class="tl-time" title="${esc(fmtTs(e.at))}">${ago(e.at)}</span></div>`).join('')}</div>
    <div id="op-msg"></div>
    </div>`;
  $('#op-release')?.addEventListener('click', async () => {
    const btn = $('#op-release');
    try {
      btn.disabled = true;
      await api(`/api/v1/operations/${op.id}/release`, { method: 'POST', body: '{}' });
      ctx.render();
    } catch (e) {
      btn.disabled = false;
      $('#op-msg').innerHTML = `<div class="error-box">${esc(apiMessage(e))}</div>`;
    }
  });
  if (!terminal && state.view === 'operation' && state.opId === op.id) {
    setTimeout(() => { if (state.view === 'operation' && state.opId === op.id) ctx.render(); }, 8000);
  }
}
