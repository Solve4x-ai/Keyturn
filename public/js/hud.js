// Mission Control — the live HUD landing page.
// Route: #/hud. Everything shown comes from GET /api/v1/hud (local store,
// read-only). Status is always "as of the last device sync" — freshness is
// rendered next to the fleet numbers, never hidden behind them.
import { api, state, $, esc, ago, toast, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader } from './components.js';
import { ring, sparkBars, stackedBars, hBars, countUp } from './charts.js';
import { scopeOrg, setScope, orgName } from './scope.js';

const REFRESH_MS = 30_000;
let timer = null;
let lastKey = null;

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const STREAM_IC = { operation: 'terminal', review: 'sparkle', change: 'history' };
const ATT_IC = { approval: 'key', server_offline: 'server', op_failed: 'terminal', risk: 'warn', stale_sync: 'refresh', risks_high: 'warn', questions: 'help' };

function scopeParam() {
  const o = scopeOrg();
  return o != null ? `?orgId=${o}` : '';
}

export function attentionItem(a) {
  return `<a class="att-item" href="${esc(a.href)}" data-sev="${esc(a.severity)}">
    <span class="att-ic">${icon(ATT_IC[a.kind] ?? 'bell')}</span>
    <span style="min-width:0"><span class="att-title">${esc(a.title)}</span><span class="att-sub">${esc(a.sub)}</span></span>
    <span class="att-meta">${a.at ? ago(a.at) : `<span class="badge badge-${a.severity === 'critical' ? 'bad' : a.severity === 'high' ? 'warn' : a.severity === 'medium' ? 'info' : 'muted'}">${esc(a.severity)}</span>`}</span>
  </a>`;
}

function kpi({ icon: ic, tone, label, value, valueSuffix = '', sub, href, spark = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="hud-kpi glass tone-${tone}"${href ? ` href="${href}"` : ''}>
    <div class="kpi-top"><span class="icon-tile tile-${tone}">${icon(ic)}</span><span class="kpi-label">${esc(label)}</span>${href ? `<span class="kpi-go">${icon('arrow-ur')}</span>` : ''}</div>
    <div class="kpi-value">${value}${valueSuffix ? `<span class="kpi-suffix">${valueSuffix}</span>` : ''}</div>
    <div class="kpi-foot"><span class="kpi-sub">${sub}</span>${spark}</div>
  </${tag}>`;
}

export function serverTile(s) {
  const stateName = s.offline ? 'offline' : 'online';
  return `<a class="srv-tile" href="#/device/${s.deviceId}/overview" data-state="${stateName}" title="${esc(s.displayName || s.name)}">
    <div class="st-head"><span class="led" aria-hidden="true"></span><span class="st-name">${esc(s.name)}</span>${s.openItems ? `<span class="st-find" title="open review findings">${s.openItems}</span>` : ''}</div>
    <div class="st-roles">${s.roles.length ? s.roles.map((r) => `<span class="role role-${r.toLowerCase()}">${esc(r)}</span>`).join('') : '<span class="role role-none">server</span>'}</div>
    <div class="st-meta"><span class="st-status">${stateName}</span> · seen ${s.lastContact ? ago(s.lastContact) : 'never'}</div>
  </a>`;
}

export function streamRow(e) {
  const inner = `<span class="tl-dot tl-${esc(e.source)}">${icon(STREAM_IC[e.source] ?? 'pulse')}</span>
    <span class="tl-body"><span class="tl-title">${esc(e.title)}</span><span class="tl-sub">${esc(e.source)} · ${esc(String(e.kind).replace(/_/g, ' '))}</span></span>
    <span class="tl-time">${ago(e.at)}</span>`;
  return e.href ? `<a class="tl-row" href="${esc(e.href)}">${inner}</a>` : `<div class="tl-row">${inner}</div>`;
}

export async function hudView(el) {
  clearTimeout(timer);
  const scope = scopeParam();
  const h = await api(`/api/v1/hud${scope}`);
  const firstPaint = lastKey !== `hud${scope}`;
  lastKey = `hud${scope}`;
  const f = h.fleet;
  const onlinePct = pct(f.online, f.total);
  const ops30 = h.operations.d30;
  const isCommand = state.meta?.principal?.profile === 'command';
  const sc = scopeOrg();
  const scopeName = sc != null ? (h.orgs.find((o) => o.orgId === sc)?.name ?? orgName(sc)) : 'All organizations';
  const riskOrg = sc ?? h.orgs.find((o) => o.risks.open)?.orgId ?? h.orgs[0]?.orgId ?? '';
  const fresh = h.freshness;
  const series = h.operations.series;

  el.innerHTML = `
    <div class="hud${firstPaint ? ' rise' : ''}" data-view-root="hud">
      ${pageHeader({
        icon: 'hud', title: 'Mission Control',
        subHtml: `Live fleet posture, infrastructure, and AI findings for <strong>${esc(scopeName)}</strong>. Read-only — nothing on this page executes.`,
        actions: sc != null
          ? `<a class="btn secondary" href="#/org/${sc}">${icon('building')} Open organization</a><button class="btn ghost" id="hud-all">${icon('layers')} Show all orgs</button>`
          : '',
      })}

      <div class="hud-grid">
        <section class="hud-card glass hud-fleet" aria-labelledby="hf-t">
          <div class="hc-head"><h2 id="hf-t" class="hc-title">${icon('devices')} Fleet status</h2>
            <span class="freshness-chip ${fresh.stale ? 'is-stale' : ''}" title="Online/offline reflects NinjaOne agent check-ins as of the last device sync">
              ${icon(fresh.stale ? 'warn' : 'check')} ${fresh.deviceSyncAt ? `as of ${ago(fresh.deviceSyncAt)}` : 'never synced'}</span></div>
          <div class="fleet-body">
            <div class="ring-wrap">
              ${ring({ value: f.online, total: f.total, size: 216, stroke: 13, title: `${f.online} of ${f.total} devices online`, segments: [
                { value: f.servers.online, color: 'var(--chart-2)' },
                { value: f.workstations.online, color: 'var(--accent)' },
                { value: f.offline, color: 'color-mix(in oklch, var(--bad) 70%, transparent)' },
              ] })}
              <div class="ring-center"><div class="ring-value"><span data-count="${onlinePct}">${onlinePct}</span><span class="ring-pct">%</span></div><div class="ring-label">online</div><div class="ring-of">${f.online} / ${f.total} devices</div></div>
              <div class="ring-sweep" aria-hidden="true"></div>
            </div>
            <ul class="fleet-legend">
              <li><span class="lg-sw" style="background:var(--chart-2)"></span><span class="lg-k">Servers</span><span class="lg-v">${f.servers.online}<small>/${f.servers.total}</small></span></li>
              <li><span class="lg-sw" style="background:var(--accent)"></span><span class="lg-k">Workstations</span><span class="lg-v">${f.workstations.online}<small>/${f.workstations.total}</small></span></li>
              <li><span class="lg-sw" style="background:var(--bad)"></span><span class="lg-k">Offline</span><span class="lg-v">${f.offline}</span></li>
            </ul>
            ${f.offline ? `<div class="aging" title="Offline devices by time since last check-in">
              <div class="aging-k">Offline for</div>
              <div class="aging-bar">${[['lt1h', '<1h'], ['lt24h', '<24h'], ['lt7d', '<7d'], ['gt7d', '7d+']].map(([k, l]) => f.offlineAging[k] ? `<span class="ag ag-${k}" style="flex:${f.offlineAging[k]}" title="${l}: ${f.offlineAging[k]}">${f.offlineAging[k]}</span>` : '').join('')}</div>
              <div class="aging-legend"><span>&lt;1h</span><span>&lt;24h</span><span>&lt;7d</span><span>7d+</span></div>
            </div>` : ''}
            <div class="fleet-actions">
              <a class="btn-mini" href="#/devices?offline=1">${icon('devices')} Offline devices</a>
              <button class="btn-mini" id="hud-sync" title="Refresh the local inventory from NinjaOne (read-only API fetch — runs nothing on endpoints)">${icon('refresh')} Sync inventory</button>
            </div>
          </div>
        </section>

        <div class="hud-kpis">
          ${kpi({ icon: 'server', tone: h.fleet.servers.online < h.fleet.servers.total ? 'bad' : 'ok', label: 'Servers online', value: `<span data-count="${f.servers.online}">${f.servers.online}</span>`, valueSuffix: `/${f.servers.total}`, sub: `${h.servers.filter((s) => s.roles.length).length} infrastructure role hosts`, href: '#/devices' })}
          ${kpi({ icon: 'key', tone: h.approvals.pending ? 'warn' : 'muted', label: 'Approvals', value: `<span data-count="${h.approvals.pending}">${h.approvals.pending}</span>`, sub: h.approvals.pending ? 'plans waiting on you' : 'queue clear', href: '#/approvals' })}
          ${kpi({ icon: 'warn', tone: h.review.bySeverity.critical ? 'bad' : h.review.bySeverity.high ? 'warn' : 'info', label: 'Open risks', value: `<span data-count="${h.review.risks}">${h.review.risks}</span>`, sub: `${h.review.bySeverity.critical} critical · ${h.review.bySeverity.high} high`, href: `#/review/${riskOrg}/risks` })}
          ${kpi({ icon: 'bolt', tone: ops30.successRate === null ? 'muted' : ops30.successRate >= 0.9 ? 'ok' : ops30.successRate >= 0.7 ? 'warn' : 'bad', label: 'Op success · 30d', value: ops30.successRate === null ? '—' : `<span data-count="${Math.round(ops30.successRate * 100)}">${Math.round(ops30.successRate * 100)}</span>`, valueSuffix: ops30.successRate === null ? '' : '%', sub: ops30.total ? `${ops30.verified} verified · ${ops30.failed} failed` : 'no operations yet', href: '#/operations', spark: sparkBars(series.map((d) => d.verified + d.failed + d.other), { w: 86, h: 26, title: 'operations per day, last 14 days' }) })}
        </div>

        <section class="hud-card glass hud-servers" aria-labelledby="hs-t">
          <div class="hc-head"><h2 id="hs-t" class="hc-title">${icon('server')} Server constellation</h2>
            <span class="hc-meta">${h.servers.length ? `${h.servers.filter((s) => !s.offline).length} of ${plural(h.servers.length, 'server')} reporting` : ''}</span></div>
          ${h.servers.length ? `<div class="srv-grid">${h.servers.map(serverTile).join('')}</div>`
            : '<div class="hc-empty">No servers in this scope.</div>'}
          <div class="hc-note">Roles (DC · DNS · DHCP) come from collected infrastructure evidence only — never guessed from hostnames.</div>
        </section>

        <section class="hud-card glass hud-attention" aria-labelledby="ha-t">
          <div class="hc-head"><h2 id="ha-t" class="hc-title">${icon('bell')} Needs attention</h2><span class="hc-meta">${h.attentionTotal ? plural(h.attentionTotal, 'item') : ''}</span></div>
          ${h.attention.length ? `<div class="att-list">${h.attention.slice(0, 8).map(attentionItem).join('')}</div>`
            : `<div class="all-clear">${icon('shield')}<div><strong>All clear</strong><div class="sub">No approvals, offline servers, failed operations, or critical findings.</div></div></div>`}
        </section>

        <section class="hud-card glass hud-ops" aria-labelledby="ho-t">
          <div class="hc-head"><h2 id="ho-t" class="hc-title">${icon('terminal')} Operations · 14 days</h2><a class="hc-link" href="#/operations">All ${icon('arrow-ur')}</a></div>
          <div class="ops-stats">
            <div><span class="os-v">${h.operations.d7.total}</span><span class="os-k">last 7d</span></div>
            <div><span class="os-v ok">${h.operations.d7.verified}</span><span class="os-k">verified</span></div>
            <div><span class="os-v bad">${h.operations.d7.failed}</span><span class="os-k">failed</span></div>
            <div><span class="os-v">${h.operations.d1.inFlight}</span><span class="os-k">in flight</span></div>
          </div>
          <div class="chart-box">${stackedBars(series, [
            { key: 'verified', label: 'verified', color: 'var(--ok)' },
            { key: 'failed', label: 'failed/unknown', color: 'var(--bad)' },
            { key: 'other', label: 'other', color: 'var(--chart-2)' },
          ], { w: 460, h: 150, title: 'operations per day by outcome, last 14 days' })}</div>
          <div class="chart-legend"><span><i style="background:var(--ok)"></i>verified</span><span><i style="background:var(--bad)"></i>failed / unknown</span><span><i style="background:var(--chart-2)"></i>other</span></div>
        </section>

        <section class="hud-card glass hud-intel" aria-labelledby="hi-t">
          <div class="hc-head"><h2 id="hi-t" class="hc-title">${icon('sparkle')} AI findings</h2><span class="hc-meta">${h.review.open} open</span></div>
          <div class="sev-strip">
            ${['critical', 'high', 'medium', 'low'].map((s) => `<div class="sev sev-${s}"><span class="sev-v">${h.review.bySeverity[s] ?? 0}</span><span class="sev-k">${s}</span></div>`).join('')}
          </div>
          ${h.review.byCategory.length ? hBars(h.review.byCategory.slice(0, 6).map((c, i) => ({ key: c.category, label: c.category, value: c.open, color: `var(--chart-${(i % 6) + 1})` })), { onKey: true }) : '<div class="hc-empty">No open findings.</div>'}
          <div class="hc-note">${h.review.openQuestions ? `${plural(h.review.openQuestions, 'open question')} — answers sharpen findings. ` : ''}Proposals only; nothing executes without your approval.</div>
        </section>

        <section class="hud-card glass hud-stream" aria-labelledby="hl-t">
          <div class="hc-head"><h2 id="hl-t" class="hc-title"><span class="dot live" style="color:var(--ok)"></span> Activity stream</h2><a class="hc-link" href="#/activity">Journal ${icon('arrow-ur')}</a></div>
          ${h.stream.length ? `<div class="timeline">${h.stream.slice(0, 8).map(streamRow).join('')}</div>` : '<div class="hc-empty">No recorded activity yet.</div>'}
        </section>

        <section class="hud-card glass hud-orgs" aria-labelledby="hg-t">
          <div class="hc-head"><h2 id="hg-t" class="hc-title">${icon('building')} Organizations</h2><span class="hc-meta">${plural(h.orgs.length, 'tenant')}</span></div>
          <div class="org-grid">${h.orgs.map((o) => {
            const on = o.devices - o.offline;
            return `<button class="org-tile${o.orgId === sc ? ' is-current' : ''}" data-org="${o.orgId}" title="Open ${esc(o.name)}">
              <div class="ot-name">${esc(o.name)}</div>
              <div class="ot-bar"><span style="width:${pct(on, o.devices)}%"></span></div>
              <div class="ot-stats"><span><b>${on}</b>/${o.devices} online</span><span><b>${o.servers}</b> servers</span><span class="${o.risks.high || o.risks.critical ? 'warn' : ''}"><b>${o.risks.open}</b> risks</span></div>
            </button>`;
          }).join('')}</div>
        </section>

        <section class="hud-card glass hud-edge" aria-labelledby="he-t">
          <div class="hc-head"><h2 id="he-t" class="hc-title">${icon('network')} Network edge</h2><span class="badge badge-muted">not connected</span></div>
          <div class="edge-icons" aria-hidden="true">${['network', 'firewall', 'wifi', 'printer'].map((i) => `<span>${icon(i)}</span>`).join('')}</div>
          <div class="sub">Switches, firewalls, access points, and printers will appear here once the <strong>SNMPv3 edge agent</strong> is deployed on a site network. Nothing is inferred until then.</div>
        </section>
      </div>
    </div>`;

  if (firstPaint) countUp(el);
  $('#hud-all')?.addEventListener('click', () => setScope(null));
  el.querySelectorAll('.org-tile[data-org]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/org/${b.dataset.org}`; }));
  el.querySelectorAll('.hbar[data-key]').forEach((b) => {
    const go = () => {
      state.reviewRiskCat = b.dataset.key;
      location.hash = `#/review/${riskOrg}/risks`;
    };
    b.addEventListener('click', go);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  $('#hud-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.lastChild.textContent = ' Syncing…';
    try {
      await api('/tools/sync_entities', { method: 'POST', body: '{}' });
      toast('Inventory synced from NinjaOne');
      ctx.refreshShell?.();
      ctx.render();
    } catch (err) {
      toast(`Sync failed: ${err.message}`);
      btn.disabled = false; btn.lastChild.textContent = ' Sync inventory';
    }
  });
  if (!isCommand) { /* reporting profile: sync still allowed — it is a read */ }

  timer = setTimeout(() => { if (state.view === 'hud' && !document.hidden) ctx.render(); }, REFRESH_MS);
}

export function leaveHud() { clearTimeout(timer); lastKey = null; }
