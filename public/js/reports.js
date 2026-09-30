// Reporting & Analytics — windowed, evidence-backed org reports.
// Route: #/reports/<orgId>. Renders the same report JSON the MCP
// generate_report tool produces; Print hands the page to the browser's
// print-to-PDF path. Numbers are projections over retained evidence —
// disclosures are part of the report, never hidden (plan §14).
import { api, state, $, esc, ago, fmtTs, toast, ctx } from './core.js';
import { pageHeader } from './components.js';
import { requireOrg } from './scope.js';

const WINDOWS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['91', 'Last quarter'],
  ['180', 'Last 6 months'],
  ['365', 'Last year'],
];

const DISP_LABEL = {
  investigate: 'investigate', monitor: 'monitor', accept_risk: 'accepted risk',
  pursue_improvement: 'pursue improvement', defer: 'deferred', dismiss: 'dismissed',
  duplicate: 'duplicate', superseded: 'superseded', verified_resolved: 'verified resolved',
  unverified_closure: 'closed (unverified)',
};

async function orgOptions(selected) {
  const { organizations } = await api('/api/v1/organizations');
  return (organizations || [])
    .map((o) => `<option value="${o.org_id}" ${Number(o.org_id) === Number(selected) ? 'selected' : ''}>${esc(o.name ?? o.display_name ?? `Org ${o.org_id}`)}</option>`)
    .join('');
}

const gapBadge = (s) => `<span class="badge ${s === 'verified' ? 'badge-ok' : s === 'failed' ? 'badge-bad' : s === 'unknown' ? 'badge-warn' : 'badge-muted'}">${esc(s)}</span>`;

function renderReport(el, r) {
  const s = r.summary || {};
  const w = r.window || {};
  const infra = r.infrastructure;
  const rev = r.review;

  const summaryCards = [
    ['Device targets', s.deviceTargets ?? 0, 'rpt-work'],
    ['Verified', s.verified ?? 0, 'rpt-work'],
    ['Failed', s.failed ?? 0, 'rpt-work'],
    ['Coverage gaps', s.softwareObserved?.coverageGaps ?? 0, 'rpt-sw'],
  ].map(([l, v, to]) => `<div class="card clickable" data-scroll="${to}" role="button" tabindex="0" title="Jump to section"><div class="card-value">${v}</div><div class="card-label">${l}</div></div>`).join('');

  const workRows = (r.work || []).map((t) =>
    `<tr><td>${esc(t.device)}</td><td class="sub">${esc(t.runbook)}</td><td>${gapBadge(t.status)}</td><td class="sub">${esc(t.verifiedSoftware ?? '—')}</td><td class="sub">${esc(String(t.finishedAt ?? '').slice(0, 16))}</td></tr>`).join('');

  const swRows = (r.softwareChanges || []).filter((c) => c.removedCount > 0 || c.addedCount > 0).map((c) =>
    `<tr><td>${esc(c.device)}</td><td class="sub">-${c.removedCount} / +${c.addedCount}</td><td class="sub">${esc(String(c.baselineAt ?? '').slice(0, 10))} → ${esc(String(c.comparedAt ?? '').slice(0, 10))}${c.baselineInsideWindow ? ' <span class="badge badge-warn" title="no earlier baseline exists">partial</span>' : ''}</td></tr>`).join('');

  const infraRows = infra ? Object.entries(infra.entityCounts || {}).map(([cat, st]) =>
    `<tr><td>${esc(cat)}</td><td class="sub">${Object.entries(st).map(([s, n]) => `${n} ${esc(s)}`).join(', ')}</td></tr>`).join('') : '';
  const covRows = infra ? (infra.coverage || []).map((c) =>
    `<tr><td class="sub">${esc(c.section)}</td><td><span class="badge ${c.status === 'complete' ? 'badge-ok' : c.status === 'partial' ? 'badge-warn' : 'badge-muted'}">${esc(c.status)}</span></td><td class="sub">${esc(String(c.lastCollected ?? '').slice(0, 10))}</td></tr>`).join('') : '';

  const dec = rev?.decisionsInWindow ?? {};
  const openByType = rev?.openItemsByType ?? {};
  const decRows = Object.entries(dec).map(([d, n]) => `<tr><td>${esc(DISP_LABEL[d] ?? d)}</td><td class="sub">${n}</td></tr>`).join('');

  el.innerHTML = `
    <div class="report-doc">
      <div class="section-title">Summary — ${esc(r.scope?.orgName ?? 'org')} · ${esc(String(w.sinceIso ?? '').slice(0, 10))} → ${esc(String(w.untilIso ?? '').slice(0, 10))} (${esc(w.label ?? '')})</div>
      <div class="card-grid">${summaryCards}</div>

      <div class="section-title" id="rpt-work">Work performed</div>
      <table class="data"><thead><tr><th>Device</th><th>Action</th><th>Status</th><th>Verified</th><th>Finished</th></tr></thead><tbody>${workRows || '<tr><td colspan="5" class="sub">no operations in window</td></tr>'}</tbody></table>

      <div class="section-title" id="rpt-sw">Software changes observed</div>
      <table class="data"><tbody>${swRows || '<tr><td class="sub">no changes on devices with comparable evidence</td></tr>'}</tbody></table>
      ${(r.coverageGaps || []).length ? `<div class="sub">Coverage gaps: ${r.coverageGaps.map((g) => esc(g.device)).join(', ')}</div>` : ''}

      ${infra ? `<div class="section-title">Infrastructure — current evidence</div>
      <table class="data"><tbody>${infraRows || '<tr><td class="sub">none collected</td></tr>'}</tbody></table>
      <div class="section-title">Collection coverage</div>
      <table class="data"><thead><tr><th>Section</th><th>Status</th><th>Last collected</th></tr></thead><tbody>${covRows || '<tr><td colspan="3" class="sub">none</td></tr>'}</tbody></table>` : ''}

      ${rev ? `<div class="section-title">Review outcomes</div>
      <div class="toolbar" style="gap:16px;margin:6px 0">
        <span class="sub">open questions: <b>${rev.openQuestionsNow ?? 0}</b></span>
        <span class="sub">reassessments flagged: <b>${rev.reassessmentsInWindow ?? 0}</b></span>
        <span class="sub">active suppressions: <b>${rev.activeSuppressions ?? 0}</b></span>
        <span class="sub">open items: ${Object.keys(openByType).length ? Object.entries(openByType).map(([t, n]) => `${n} ${t}`).join(', ') : 'none'}</span>
      </div>
      <table class="data"><thead><tr><th>Decision</th><th>Count</th></tr></thead><tbody>${decRows || '<tr><td colspan="2" class="sub">no decisions in window</td></tr>'}</tbody></table>` : ''}

      <div class="section-title">Method notes</div>
      <ul class="sub" style="padding-left:18px;margin:4px 0">${(r.disclosures || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      <div class="sub">generated ${ago(new Date(r.generatedAt).getTime())} · report schema v${esc(r.schemaVersion ?? '?')}</div>
    </div>`;
  el.querySelectorAll('.card[data-scroll]').forEach((c) => {
    const go = () => document.getElementById(c.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    c.addEventListener('click', go);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

export async function reportsView(el) {
  const org = requireOrg(el, { title: 'Reports', icon: 'reports', sub: 'Management reports cover one organization — choose which one.' });
  if (org == null) return;
  if (state.reportOrg !== org) state._lastReport = null;
  state.reportOrg = org;
  const days = state.reportDays || '91';
  el.innerHTML = `
    ${pageHeader({ icon: 'reports', title: 'Reports', sub: 'Windowed, evidence-backed reports — every number traceable to retained observations' })}
    <div class="toolbar no-print">
      <select id="rep-window">${WINDOWS.map(([d, l]) => `<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" id="rep-run">Run report</button>
      <button class="btn secondary" id="rep-print" ${state._lastReport ? '' : 'disabled'}>Print / Save PDF</button>
    </div>
    <div id="rep-body"><div class="sub">${state._lastReport ? '' : 'choose a window and run — the report renders here and prints to PDF'}</div></div>`;
  $('#rep-org')?.addEventListener('change', (e) => { state.reportOrg = Number(e.target.value); state._lastReport = null; ctx.nav(); });
  $('#rep-window').addEventListener('change', (e) => { state.reportDays = e.target.value; });
  $('#rep-print').addEventListener('click', () => window.print());
  $('#rep-run').addEventListener('click', () => runReport());
  if (state._lastReport) renderReport($('#rep-body'), state._lastReport);

  async function runReport() {
    if (!state.reportOrg) { toast('Pick an organization'); return; }
    $('#rep-body').innerHTML = '<div class="sub">building report…</div>';
    try {
      const r = await api(`/api/v1/orgs/${state.reportOrg}/report?sinceDays=${state.reportDays || 91}`);
      state._lastReport = r;
      renderReport($('#rep-body'), r);
      $('#rep-print').disabled = false;
    } catch (e) {
      $('#rep-body').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }
}
