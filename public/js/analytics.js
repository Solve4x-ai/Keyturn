// Analytics — windowed trends over retained local records.
// Route: #/analytics. Data: GET /api/v1/analytics?days=&orgId=. Every chart
// has its numbers beside it as text; empty windows say so instead of
// drawing flat lines that look like "zero problems".
import { api, state, esc, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader } from './components.js';
import { ring, stackedBars, hBars, areaLine, countUp } from './charts.js';
import { scopeOrg, orgName } from './scope.js';

const WINDOWS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']];
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const FIELD_LABEL = (f) => f.replace('__appeared__', 'first seen').replace('.', ' · ').replace(/_/g, ' ');

function tile(label, value, sub, tone = '') {
  return `<div class="an-kpi glass ${tone}"><div class="an-k">${esc(label)}</div><div class="an-v">${value}</div><div class="an-s">${sub}</div></div>`;
}

export async function analyticsView(el) {
  const days = state.anDays || 30;
  const org = scopeOrg();
  const a = await api(`/api/v1/analytics?days=${days}${org != null ? `&orgId=${org}` : ''}`);
  const o = a.operations;
  const r = a.review;
  const hasOps = o.total > 0;
  const flowTotals = r.available ? r.flow.reduce((s, d) => ({ opened: s.opened + d.opened, closed: s.closed + d.closed }), { opened: 0, closed: 0 }) : null;

  el.innerHTML = `
    <div class="analytics rise" data-view-root="analytics">
      ${pageHeader({
        icon: 'analytics', title: 'Analytics',
        subHtml: `Trends for <strong>${esc(orgName(org))}</strong> — operations, observed change, AI findings, and fleet contact over the last ${days} days. Retained local records only; nothing is estimated.`,
        actions: `<div class="seg" role="radiogroup" aria-label="Window">${WINDOWS.map(([d, l]) => `<button class="seg-btn" role="radio" data-days="${d}" aria-checked="${days === d}">${l}</button>`).join('')}</div>`,
      })}

      <div class="an-kpis">
        ${tile('Operations', `<span data-count="${o.total}">${o.total}</span>`, `${o.verified} verified · ${o.failed} failed`)}
        ${tile('Success rate', pct(o.successRate), 'of terminal outcomes', o.successRate === null ? '' : o.successRate >= 0.9 ? 'is-ok' : o.successRate >= 0.7 ? 'is-warn' : 'is-bad')}
        ${tile('Time to receipt · p50', fmtMs(o.durationMs.p50), `${o.durationMs.samples} timed receipts`)}
        ${tile('Time to receipt · p95', fmtMs(o.durationMs.p95), 'slowest 5% of runs')}
        ${tile('Observed changes', `<span data-count="${a.changes.total}">${a.changes.total}</span>`, 'field-level diffs, excl. check-ins')}
        ${r.available ? tile('Findings flow', `${flowTotals.opened}<span class="an-sep">/</span>${flowTotals.closed}`, 'opened / closed in window') : ''}
      </div>

      <div class="an-grid">
        <section class="hud-card glass an-wide">
          <div class="hc-head"><h2 class="hc-title">${icon('terminal')} Operations throughput</h2><span class="hc-meta">${o.total} in window</span></div>
          ${hasOps ? `<div class="chart-box" style="height:200px">${stackedBars(o.daily, [
            { key: 'verified', label: 'verified', color: 'var(--ok)' },
            { key: 'failed', label: 'failed/unknown', color: 'var(--bad)' },
            { key: 'other', label: 'other', color: 'var(--chart-2)' },
          ], { w: 760, h: 200, title: `operations per day, last ${days} days` })}</div>
          <div class="chart-legend"><span><i style="background:var(--ok)"></i>verified</span><span><i style="background:var(--bad)"></i>failed / unknown</span><span><i style="background:var(--chart-2)"></i>other</span></div>`
            : '<div class="hc-empty">No operations in this window.</div>'}
        </section>

        <section class="hud-card glass an-narrow an-center">
          <div class="hc-head"><h2 class="hc-title">${icon('bolt')} Outcome mix</h2></div>
          ${hasOps ? `<div class="ring-wrap sm">${ring({ value: o.verified, total: o.total, size: 170, stroke: 12, title: `${o.verified} of ${o.total} verified`, segments: [
            { value: o.verified, color: 'var(--ok)' }, { value: o.failed, color: 'var(--bad)' }, { value: o.total - o.verified - o.failed, color: 'var(--chart-2)' },
          ] })}<div class="ring-center"><div class="ring-value" style="font-size:34px">${pct(o.successRate)}</div><div class="ring-label">verified</div></div></div>` : '<div class="hc-empty">—</div>'}
        </section>

        <section class="hud-card glass an-wide">
          <div class="hc-head"><h2 class="hc-title">${icon('book')} Runbook reliability</h2><span class="hc-meta">success rate · median time to receipt</span></div>
          ${o.byRunbook.length ? `<table class="data an-table"><thead><tr><th>Runbook</th><th>Runs</th><th style="width:38%">Success</th><th>p50</th></tr></thead><tbody>
            ${o.byRunbook.map((b) => `<tr><td class="mono-val">${esc(b.runbook)}</td><td>${b.total}</td>
              <td><div class="rel-bar"><span class="rel-ok" style="width:${(b.verified / b.total) * 100}%"></span><span class="rel-bad" style="width:${(b.failed / b.total) * 100}%"></span></div><span class="rel-pct ${b.successRate < 0.7 ? 'bad' : b.successRate < 0.9 ? 'warn' : 'ok'}">${pct(b.successRate)}</span></td>
              <td class="sub">${fmtMs(b.p50Ms)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="hc-empty">No runbook runs in this window.</div>'}
        </section>

        <section class="hud-card glass an-narrow">
          <div class="hc-head"><h2 class="hc-title">${icon('server')} Most-worked devices</h2></div>
          ${o.topTargets.length ? hBars(o.topTargets.map((t) => ({ label: t.label, value: t.total, color: t.failed ? 'var(--warn)' : 'var(--chart-1)' })))
            : '<div class="hc-empty">—</div>'}
          <div class="hc-note">Amber bars include at least one failed run.</div>
        </section>

        <section class="hud-card glass an-half">
          <div class="hc-head"><h2 class="hc-title">${icon('history')} Observed change volume</h2><span class="hc-meta">${a.changes.total} changes</span></div>
          ${a.changes.total ? `<div class="chart-box" style="height:120px">${areaLine(a.changes.daily.map((d) => d.changes), { w: 600, h: 120, color: 'var(--chart-4)', title: 'observed changes per day' })}</div>
            ${hBars(a.changes.byField.slice(0, 6).map((f, i) => ({ label: FIELD_LABEL(f.field), value: f.count, color: `var(--chart-${(i % 6) + 1})` })))}`
            : '<div class="hc-empty">No field changes observed in this window. That can mean a stable fleet or no syncs — check freshness on Mission Control.</div>'}
        </section>

        ${r.available ? `<section class="hud-card glass an-half">
          <div class="hc-head"><h2 class="hc-title">${icon('sparkle')} AI findings</h2><span class="hc-meta">${r.open} open · ${r.closed} closed</span></div>
          <div class="chart-box" style="height:120px">${stackedBars(r.flow, [
            { key: 'opened', label: 'opened', color: 'var(--chart-2)' }, { key: 'closed', label: 'closed', color: 'var(--ok)' },
          ], { w: 600, h: 120, title: 'findings opened and closed per day' })}</div>
          <div class="an-split">
            <div><div class="an-mini-k">Open by severity</div>${hBars(['critical', 'high', 'medium', 'low'].map((s) => ({ label: s, value: r.openBySeverity[s] ?? 0, color: s === 'critical' ? 'var(--bad)' : s === 'high' ? 'var(--warn)' : s === 'medium' ? 'var(--info)' : 'var(--text-faint)' })))}</div>
            <div><div class="an-mini-k">Open by type</div>${hBars(Object.entries(r.openByType).map(([t, n]) => ({ label: t, value: n, color: t === 'risk' ? 'var(--bad)' : t === 'improvement' ? 'var(--accent)' : 'var(--obs)' })))}</div>
          </div>
          ${r.decisions.length ? `<div class="an-decisions">${r.decisions.map((d) => `<span class="badge badge-muted">${esc(String(d.disposition).replace(/_/g, ' '))} · ${d.count}</span>`).join('')}</div>` : ''}
        </section>` : ''}

        <section class="hud-card glass an-third">
          <div class="hc-head"><h2 class="hc-title">${icon('pulse')} Last check-in</h2><span class="hc-meta">${a.fleet.total} devices</span></div>
          ${hBars([['lt1h', '< 1 hour'], ['lt24h', '< 24 hours'], ['lt7d', '< 7 days'], ['lt30d', '< 30 days'], ['gt30d', '30+ days'], ['never', 'never']]
            .map(([k, l], i) => ({ label: l, value: a.fleet.contact[k], color: i < 2 ? 'var(--ok)' : i < 3 ? 'var(--chart-1)' : i < 4 ? 'var(--warn)' : 'var(--bad)' })))}
          <div class="hc-note">As of the last device sync — a stale sync shifts everything right.</div>
        </section>

        <section class="hud-card glass an-third">
          <div class="hc-head"><h2 class="hc-title">${icon('infrastructure')} Infrastructure knowledge</h2></div>
          ${a.infrastructure.byCategory.length ? hBars(a.infrastructure.byCategory.slice(0, 8).map((c, i) => ({ label: c.category.replace(/-/g, ' '), value: c.count, color: `var(--chart-${(i % 6) + 1})` }))) : '<div class="hc-empty">Nothing collected yet.</div>'}
          ${a.infrastructure.coverage.length ? `<div class="an-decisions">${a.infrastructure.coverage.map((c) => `<span class="badge ${c.status === 'complete' ? 'badge-ok' : c.status === 'failed' ? 'badge-bad' : 'badge-warn'}">${esc(c.status)} · ${c.count}</span>`).join('')}</div>` : ''}
        </section>

        <section class="hud-card glass an-third">
          <div class="hc-head"><h2 class="hc-title">${icon('activity')} Tool usage</h2><span class="hc-meta">journaled calls</span></div>
          ${a.tools.length ? hBars(a.tools.map((t) => ({ label: t.tool.replace(/_/g, ' '), value: t.total, color: t.error ? 'var(--warn)' : 'var(--chart-1)' }))) : '<div class="hc-empty">No journaled tool calls in this window.</div>'}
        </section>
      </div>
    </div>`;
  countUp(el);
  el.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { state.anDays = Number(b.dataset.days); ctx.render(); }));
}
