// Operations list + Runbook library.
// Both are read-only views over local data: the operations table is the
// execution record (receipts live on the detail page), and the runbook
// library shows reviewed, digest-pinned scripts. Nothing here dispatches.
import { api, state, $, esc, ago, fmtTs, ctx } from './core.js';
import { pageHeader, statCard } from './components.js';
import { icon } from './icons.js';

export const STATUS_BADGE = {
  verified: 'badge-ok', accepted: 'badge-accent', dispatching: 'badge-accent',
  failed: 'badge-bad', cancel_requested: 'badge-warn', canceled: 'badge-muted',
  partial: 'badge-warn', canary_paused: 'badge-warn',
  held: 'badge-muted', queued: 'badge-muted', submitting: 'badge-accent',
  skipped: 'badge-muted', unknown: 'badge-bad',
};

/* ── Operations list — execution history with outcome filters ─────────── */
const OP_FILTERS = [
  ['', 'All'], ['verified', 'Verified'], ['failed', 'Failed'], ['unknown', 'Unknown'],
  ['accepted', 'In flight'], ['partial', 'Partial'], ['canceled', 'Canceled'],
];

export async function operationsListView(el) {
  const status = state.opsStatus || '';
  const [{ operations }, hud] = await Promise.all([
    api(`/api/v1/operations?limit=200${status ? `&status=${encodeURIComponent(status)}` : ''}`),
    api('/api/v1/hud').catch(() => null),
  ]);
  const q = (state.opsQ ?? '').trim().toLowerCase();
  const rows = q
    ? operations.filter((o) => `${o.device_label ?? ''} ${o.target_id} ${o.runbook_id ?? ''} ${o.operation} ${o.id}`.toLowerCase().includes(q))
    : operations;
  const d30 = hud?.operations?.d30;
  el.innerHTML = `
    <div data-view-root="operations">
    ${pageHeader({ icon: 'terminal', title: 'Operations', sub: 'Every approved plan that was dispatched — receipts, outcomes, and evidence. Outcome and verification are recorded separately; exit 0 is not proof of health.' })}
    ${d30 ? `<div class="stat-row">
      ${statCard({ icon: 'terminal', tone: 'accent', value: d30.total, label: 'Operations', sub: 'last 30 days' })}
      ${statCard({ icon: 'check', tone: 'ok', value: d30.verified, label: 'Verified', sub: 'receipt + parse confirmed' })}
      ${statCard({ icon: 'warn', tone: d30.failed ? 'bad' : 'muted', value: d30.failed, label: 'Failed / unknown', sub: 'review before any retry' })}
      ${statCard({ icon: 'bolt', tone: 'info', value: d30.successRate === null ? '—' : `${Math.round(d30.successRate * 100)}%`, label: 'Success rate', sub: 'of terminal outcomes' })}
    </div>` : ''}
    <div class="panel">
      <div class="panel-head">
        <div class="seg" role="radiogroup" aria-label="Outcome filter">
          ${OP_FILTERS.map(([k, l]) => `<button class="seg-btn" role="radio" data-status="${k}" aria-checked="${status === k}">${l}</button>`).join('')}
        </div>
        <div class="filterbar"><input type="search" id="ops-q" class="fi-search" placeholder="Filter by device, runbook, id…" value="${esc(state.opsQ ?? '')}" /></div>
      </div>
      ${rows.length ? `<table class="data"><thead><tr><th>Status</th><th>Target</th><th>Runbook / action</th><th>Started</th><th>Updated</th></tr></thead><tbody>
        ${rows.map((op) => `<tr class="clickable" tabindex="0" data-op="${esc(op.id)}">
          <td><span class="badge ${STATUS_BADGE[op.status] || 'badge-muted'}"><span class="dot"></span>${esc(op.status)}</span></td>
          <td>${op.target_type === 'selection' ? `${icon('layers')} batch` : `<span class="mono-val">${esc(op.device_label || `device ${op.target_id}`)}</span>`}</td>
          <td>${esc(op.runbook_id || op.operation)}${op.runbook_version ? ` <span class="sub">v${op.runbook_version}</span>` : ''}${op.session_id ? ' <span class="badge badge-muted" title="ran inside an approved device session">session</span>' : ''}</td>
          <td class="sub" title="${esc(fmtTs(op.created_at))}">${ago(op.created_at)}</td>
          <td class="sub" title="${esc(fmtTs(op.updated_at))}">${ago(op.updated_at)}</td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="empty">${status || q ? 'No operations match these filters.' : 'No operations yet — plans appear here once approved and dispatched.'}</div>`}
    </div>
    <div class="sub">${rows.length} shown${operations.length === 200 ? ' · newest 200' : ''}</div>
    </div>`;
  el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.opsStatus = b.dataset.status || null; ctx.nav(); }));
  let deb;
  $('#ops-q').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(deb);
    deb = setTimeout(() => { state.opsQ = v; ctx.render().then(() => { const s = $('#ops-q'); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 200);
  });
  el.querySelectorAll('tr[data-op]').forEach((tr) => {
    const go = () => { state.view = 'operation'; state.opId = tr.dataset.op; ctx.nav(); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/* ── Runbook library — reviewed, versioned, digest-pinned scripts ─────── */
const CLASS_BADGE = { read: 'badge-ok', modify: 'badge-warn' };
const CAT_ICON = { diagnostic: 'pulse', maintenance: 'refresh', administration: 'shield' };
const CATS = ['diagnostic', 'maintenance', 'administration'];

function runbookDetail(d) {
  const params = Object.entries(d.params || {});
  return `<aside class="rb-detail glass">
    <div class="rb-detail-head"><div><div class="rb-title" style="font-size:var(--fs-lg)">${esc(d.title)}</div><div class="rb-id">${esc(d.id)} · v${d.version}</div></div>
      <button class="btn-icon" id="rb-close" aria-label="Close">${icon('x')}</button></div>
    <p class="rb-purpose rb-full">${esc(d.purpose)}</p>
    <dl class="kv">
      <dt>Classification</dt><dd><span class="badge ${CLASS_BADGE[d.classification] || 'badge-muted'}">${esc(d.classification)}</span></dd>
      <dt>Affected scope</dt><dd>${esc(d.affectedScope)}</dd>
      <dt>Side effects</dt><dd>${esc(d.sideEffects)}</dd>
      <dt>Disruption</dt><dd>${esc(d.disruption)}</dd>
      <dt>Runs as</dt><dd>${esc(d.applicability?.runAs)} · PowerShell ${esc(d.applicability?.powershell)}</dd>
      <dt>Applies to</dt><dd>${esc((d.applicability?.os || []).join(', '))}${d.applicability?.roles?.length ? ` · roles: ${esc(d.applicability.roles.join(', '))}` : ''}</dd>
      <dt>Limits</dt><dd>${d.timeoutSeconds}s timeout · ${d.outputLimits?.maxRows ?? '?'} rows · ${d.outputLimits?.maxChars ?? '?'} chars</dd>
      <dt>Retry</dt><dd>${esc(d.retry)}</dd>
      <dt>Review</dt><dd>${d.review ? `${esc(d.review.status)} by ${esc(d.review.reviewedBy)} · ${esc(d.review.reviewedAt)}` : '—'}</dd>
      <dt>Digest</dt><dd class="mono-val">${esc(d.digest)}</dd>
    </dl>
    ${params.length ? `<div class="section-title">Parameters</div>
      <table class="data"><tbody>${params.map(([k, p]) => `<tr><td class="mono-val">${esc(k)}${p.required ? ' <span class="badge badge-warn">required</span>' : ''}</td>
        <td class="wrap">${esc(p.type)}${p.enum ? ` · ${esc(p.enum.join(' | '))}` : ''}${p.default !== undefined ? ` · default ${esc(JSON.stringify(p.default))}` : ''}<div class="sub">${esc(p.description)}</div></td></tr>`).join('')}</tbody></table>` : ''}
    <details class="identity-details"><summary>Script (${d.script.length.toLocaleString()} chars)</summary><pre class="term" style="max-height:420px">${esc(d.script)}</pre></details>
    <div class="sub">To run this, ask your AI client to plan it for a device — the plan lands in Approvals for your review. Nothing runs from this page.</div>
  </aside>`;
}

export async function runbooksView(el) {
  const { runbooks } = await api('/api/v1/runbooks');
  // Newest version of each id in the grid; the detail shows the pinned digest.
  const latest = new Map();
  for (const r of runbooks) if (!latest.has(r.id) || latest.get(r.id).version < r.version) latest.set(r.id, r);
  const all = [...latest.values()];
  const cat = state.rbCat || '';
  const q = (state.rbQ ?? '').trim().toLowerCase();
  const list = all
    .filter((r) => !cat || r.category === cat)
    .filter((r) => !q || `${r.id} ${r.title} ${r.purpose}`.toLowerCase().includes(q))
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  let detail = null;
  if (state.runbookId) {
    try { detail = (await api(`/api/v1/runbooks/${encodeURIComponent(state.runbookId)}`)).runbook; } catch { detail = null; }
  }
  el.innerHTML = `
    <div data-view-root="runbooks">
    ${pageHeader({ icon: 'book', title: 'Runbooks', sub: 'Reviewed, versioned PowerShell with typed parameters. Every plan pins a runbook version and script digest — approval binds exactly what will run.' })}
    <div class="stat-row">
      ${statCard({ icon: 'book', tone: 'accent', value: latest.size, label: 'Runbooks', sub: `${runbooks.length} published versions` })}
      ${CATS.map((c) => statCard({ icon: CAT_ICON[c], tone: c === 'diagnostic' ? 'ok' : c === 'maintenance' ? 'info' : 'warn', value: all.filter((r) => r.category === c).length, label: c[0].toUpperCase() + c.slice(1), go: true, data: `cat:${c}`, active: cat === c })).join('')}
    </div>
    <div class="rb-layout${detail ? ' has-detail' : ''}">
      <div>
        <div class="toolbar">
          <input type="search" id="rb-q" placeholder="Search runbooks…" value="${esc(state.rbQ ?? '')}" style="min-width:260px" />
          ${cat ? `<span class="badge badge-accent">${esc(cat)}</span><button class="btn-mini" id="rb-clear">Clear</button>` : ''}
        </div>
        <div class="rb-grid">
          ${list.map((r) => `<button class="rb-card glass${detail?.id === r.id ? ' is-active' : ''}" data-rb="${esc(r.id)}">
            <div class="rb-head"><span class="icon-tile tile-${r.classification === 'read' ? 'ok' : 'warn'}">${icon(CAT_ICON[r.category] ?? 'book')}</span>
              <div style="min-width:0"><div class="rb-title">${esc(r.title)}</div><div class="rb-id">${esc(r.id)} · v${r.version}</div></div></div>
            <div class="rb-purpose">${esc(r.purpose)}</div>
            <div class="rb-tags"><span class="badge ${CLASS_BADGE[r.classification] || 'badge-muted'}">${esc(r.classification)}</span><span class="badge badge-muted">${esc(r.category)}</span><span class="badge badge-muted">${r.timeoutSeconds}s</span>${r.paramNames.length ? `<span class="badge badge-muted">${r.paramNames.length} param${r.paramNames.length === 1 ? '' : 's'}</span>` : ''}</div>
          </button>`).join('') || '<div class="empty">No runbooks match.</div>'}
        </div>
      </div>
      ${detail ? runbookDetail(detail) : ''}
    </div>
    </div>`;
  el.querySelectorAll('[data-rb]').forEach((b) => b.addEventListener('click', () => { state.runbookId = state.runbookId === b.dataset.rb ? null : b.dataset.rb; ctx.nav(); }));
  el.querySelectorAll('.stat-card[data-go]').forEach((c) => {
    const go = () => { const v = c.dataset.go.slice(4); state.rbCat = state.rbCat === v ? '' : v; ctx.render(); };
    c.addEventListener('click', go);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  $('#rb-clear')?.addEventListener('click', () => { state.rbCat = ''; ctx.render(); });
  $('#rb-close')?.addEventListener('click', () => { state.runbookId = null; ctx.nav(); });
  let deb;
  $('#rb-q').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(deb);
    deb = setTimeout(() => { state.rbQ = v; ctx.render().then(() => { const s = $('#rb-q'); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 150);
  });
}
