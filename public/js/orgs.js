// Organizations — a tenant directory and a full per-organization command
// page. Routes: #/organizations (directory) and #/org/<id> (org page).
// Opening an org page also scopes the whole app to that org (top-bar
// switch follows), so every other page you visit next is about it too.
// Everything is local, read-only data — nothing here executes.
import { api, state, $, esc, ago, fmtTs, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader } from './components.js';
import { ring, hBars, countUp } from './charts.js';
import { attentionItem, serverTile, streamRow } from './hud.js';
import { setScope, scopeOrg } from './scope.js';

const initials = (name) => String(name ?? '?').split(/[\s,&]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const health = (o) => (o.offline && o.servers && o.risks.critical ? 'bad' : o.risks.critical || o.risks.high ? 'warn' : 'ok');

/* ── Directory ────────────────────────────────────────────────────────── */
export async function organizationsView(el) {
  const [hud, meta] = await Promise.all([
    api('/api/v1/hud'),
    api('/api/v1/organizations').catch(() => ({ organizations: [] })),
  ]);
  const desc = new Map((meta.organizations || []).map((o) => [Number(o.org_id), o.description]));
  const sc = scopeOrg();
  el.innerHTML = `
    <div class="orgs rise" data-view-root="organizations">
      ${pageHeader({ icon: 'building', title: 'Organizations', sub: 'Every tenant this command center manages. Open one for its full picture — opening it also scopes the rest of the app to that organization.' })}
      <div class="org-cards">
        ${hud.orgs.map((o) => {
          const on = o.devices - o.offline;
          const p = pct(on, o.devices);
          return `<a class="org-card glass${o.orgId === sc ? ' is-current' : ''}" href="#/org/${o.orgId}" data-health="${health(o)}">
            <div class="oc-top">
              <span class="org-avatar">${esc(initials(o.name))}</span>
              <div class="oc-ident"><div class="oc-title">${esc(o.name)}</div><div class="oc-desc">${esc(desc.get(o.orgId) || `Organization ${o.orgId}`)}</div></div>
              <div class="oc-ring">${ring({ value: on, total: o.devices, size: 64, stroke: 6, title: `${on} of ${o.devices} online` })}<span>${p}%</span></div>
            </div>
            <div class="oc-stats">
              <div><b>${on}</b><span>/${o.devices} online</span></div>
              <div><b>${o.servers}</b><span>servers</span></div>
              <div class="${o.offline ? 'bad' : ''}"><b>${o.offline}</b><span>offline</span></div>
              <div class="${o.risks.critical ? 'bad' : o.risks.high ? 'warn' : ''}"><b>${o.risks.open}</b><span>open risks</span></div>
            </div>
            <div class="oc-foot">${o.risks.high || o.risks.critical ? `<span class="badge badge-warn">${o.risks.critical ? `${o.risks.critical} critical · ` : ''}${o.risks.high} high</span>` : '<span class="badge badge-ok">no high risks</span>'}
              ${o.orgId === sc ? '<span class="badge badge-accent">current scope</span>' : ''}<span class="oc-go">Open ${icon('arrow-ur')}</span></div>
          </a>`;
        }).join('') || '<div class="empty">No organizations yet — sync the inventory from Overview.</div>'}
      </div>
    </div>`;
  countUp(el);
}

/* ── Org page ─────────────────────────────────────────────────────────── */
function infraSnapshot(t, orgId) {
  if (!t || t.empty) {
    return `<div class="hc-empty">No infrastructure evidence collected yet. Plan the diagnostic runbooks (AD health, DNS, DHCP, GPO) on a domain controller to populate this.</div>`;
  }
  const d = t.directory;
  const zones = t.dns.servers[0]?.zones ?? [];
  const insecure = zones.filter((z) => z.insecureUpdates).length;
  const scopes = t.dhcp.servers.flatMap((s) => s.scopes.map((z) => ({ ...z, server: s.name, authorized: s.authorized })));
  const deadAuth = t.dhcp.authorizations.filter((a) => !a.agent).length;
  const g = t.gpo.counts;
  return `
    <div class="snap-domain">
      <span class="icon-tile tile-obs">${icon('building')}</span>
      <div><div class="sd-name">${esc(d.domains[0]?.dnsRoot ?? d.forest?.name ?? 'Domain')}</div>
        <div class="sub">${esc(d.domains[0]?.netbios ?? '')}${d.forest?.mode ? ` · ${esc(d.forest.mode.replace(/Windows(\d+)(R2)?(Forest|Domain)/, 'Windows $1 $2 level').replace(/\s+/g, ' '))}` : ''} · ${plural(d.sites.length, 'site')}</div></div>
    </div>
    <div class="snap-dcs">${d.dcs.map((dc) => `
      <a class="snap-dc" href="${dc.agent ? `#/device/${dc.agent.deviceId}/overview` : `#/infrastructure/${orgId}/directory`}">
        <span class="led ${dc.agent?.offline ? 'is-off' : ''}"></span>
        <span class="mono-val">${esc(dc.host.split('.')[0])}</span><span class="sub">${esc(dc.ip ?? '')}</span>
        ${dc.fsmo.length ? `<span class="badge badge-obs" title="FSMO: ${esc(dc.fsmo.join(', '))}">${dc.fsmo.length === 5 ? 'all 5 FSMO' : `${dc.fsmo.length} FSMO`}</span>` : ''}${dc.gc ? '<span class="badge badge-muted">GC</span>' : ''}
      </a>`).join('') || '<div class="sub">no domain controllers observed</div>'}</div>
    <div class="snap-tiles">
      <a class="snap-tile" href="#/infrastructure/${orgId}/dns"><span class="st-k">${icon('network')} DNS</span><span class="st-v">${zones.length}</span><span class="st-s">zones${insecure ? ` · <b class="warn">${insecure} nonsecure updates</b>` : ''}</span></a>
      <a class="snap-tile" href="#/infrastructure/${orgId}/dhcp"><span class="st-k">${icon('wifi')} DHCP</span><span class="st-v">${scopes.length}</span><span class="st-s">scopes${deadAuth ? ` · <b class="warn">${deadAuth} stale authorizations</b>` : ''}</span></a>
      <a class="snap-tile" href="#/infrastructure/${orgId}/gpo"><span class="st-k">${icon('layers')} GPO</span><span class="st-v">${g.total}</span><span class="st-s">${g.enabled} enabled${g.unlinked ? ` · <b class="warn">${g.unlinked} unlinked</b>` : ''}</span></a>
    </div>
    ${scopes.length ? `<div class="snap-scopes">${scopes.map((s) => {
      const p = s.pctUsed;
      const tone = p === null ? 'muted' : p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok';
      return `<div class="snap-scope"><div class="ss-head"><span>${esc(s.label)} <span class="sub">${esc(s.scopeId ?? '')} · ${esc(s.server.split('.')[0])}</span></span><span class="ss-pct tone-${tone}">${p === null ? (s.state === 'Inactive' ? 'inactive' : '—') : `${p}%`}</span></div>
        <div class="util-bar"><span class="tone-${tone}" style="width:${p ?? 0}%"></span></div></div>`;
    }).join('')}</div>` : ''}
    <div class="hc-note">Collected ${t.lastCollected ? ago(t.lastCollected) : 'never'} from diagnostic runbooks.</div>`;
}

export async function orgPageView(el) {
  const id = Number(state.orgPageId ?? scopeOrg());
  if (!id) { location.hash = '#/organizations'; return; }
  const [hud, detail, topo, offline] = await Promise.all([
    api(`/api/v1/hud?orgId=${id}`),
    api(`/api/v1/organizations/${id}`).catch(() => null),
    api(`/api/v1/orgs/${id}/infrastructure/topology`).catch(() => null),
    api(`/api/v1/devices?orgId=${id}&offline=1&pageSize=8&sort=last_contact&dir=desc`).catch(() => ({ rows: [], total: 0 })),
  ]);
  const org = detail?.org ?? hud.orgs.find((o) => o.orgId === id) ?? { name: `Org ${id}` };
  const tile = hud.orgs.find((o) => o.orgId === id);
  const f = hud.fleet;
  const on = f.online;
  const ops = hud.operations.d30;
  const covDone = topo ? topo.coverage.filter((c) => c.status === 'complete').length : 0;
  const covAll = topo ? topo.coverage.length : 0;
  const quick = [
    ['devices', 'Devices', `#/devices?org=${id}`], ['infrastructure', 'Infrastructure', `#/infrastructure/${id}/overview`],
    ['review', 'Review Center', `#/review/${id}/inbox`], ['analytics', 'Analytics', `#/analytics?org=${id}`], ['reports', 'Reports', `#/reports/${id}`],
  ];
  el.innerHTML = `
    <div class="orgpage rise" data-view-root="org">
      <a class="back-link" href="#/organizations">${icon('chev-r')} Organizations</a>
      <section class="org-hero glass" data-health="${tile ? health(tile) : 'ok'}">
        <span class="org-avatar xl">${esc(initials(org.name))}</span>
        <div class="oh-body">
          <div class="ph-kicker">Organization · #${id}</div>
          <h1 class="ph-title">${esc(org.name)}</h1>
          <div class="ph-sub">${esc(org.description || 'No description in NinjaOne.')} · <span class="${hud.freshness.stale ? 'warn-text' : ''}">status as of ${hud.freshness.deviceSyncAt ? ago(hud.freshness.deviceSyncAt) : 'never'}</span></div>
          <div class="oh-links">${quick.map(([ic, l, href]) => `<a class="btn-mini" href="${href}">${icon(ic === 'review' ? 'review' : ic === 'reports' ? 'reports' : ic === 'analytics' ? 'analytics' : ic)} ${l}</a>`).join('')}</div>
        </div>
        <div class="oh-ring">${ring({ value: on, total: f.total, size: 132, stroke: 10, title: `${on} of ${f.total} online`, segments: [
          { value: f.servers.online, color: 'var(--chart-2)' }, { value: f.workstations.online, color: 'var(--accent)' }, { value: f.offline, color: 'color-mix(in oklch, var(--bad) 70%, transparent)' },
        ] })}<div class="ring-center"><div class="ring-value" style="font-size:30px"><span data-count="${pct(on, f.total)}">${pct(on, f.total)}</span><span class="ring-pct" style="font-size:14px">%</span></div><div class="ring-label" style="font-size:9.5px">online</div></div></div>
      </section>

      <div class="org-kpis">
        ${[
          ['devices', 'Endpoints', `${on}<small>/${f.total}</small>`, `${f.offline} offline`, f.offline ? 'warn' : 'ok', `#/devices?org=${id}`],
          ['server', 'Servers up', `${f.servers.online}<small>/${f.servers.total}</small>`, `${hud.servers.filter((s) => s.roles.length).length} with infra roles`, f.servers.online < f.servers.total ? 'bad' : 'ok', `#/devices?org=${id}&kind=server`],
          ['warn', 'Open risks', `${hud.review.risks}`, `${hud.review.bySeverity.critical} critical · ${hud.review.bySeverity.high} high`, hud.review.bySeverity.critical ? 'bad' : hud.review.bySeverity.high ? 'warn' : 'ok', `#/review/${id}/risks`],
          ['key', 'Approvals', `${hud.approvals.pending}`, hud.approvals.pending ? 'waiting on you' : 'queue clear', hud.approvals.pending ? 'warn' : 'muted', '#/approvals'],
          ['bolt', 'Ops · 30d', ops.successRate === null ? '—' : `${Math.round(ops.successRate * 100)}<small>%</small>`, `${ops.total} runs · ${ops.failed} failed`, ops.successRate === null ? 'muted' : ops.successRate >= 0.9 ? 'ok' : 'warn', '#/operations'],
          ['check', 'Evidence', covAll ? `${covDone}<small>/${covAll}</small>` : '—', 'collection sections complete', covAll && covDone < covAll ? 'warn' : 'ok', `#/infrastructure/${id}/coverage`],
        ].map(([ic, k, v, s, tone, href]) => `<a class="org-kpi glass tone-${tone}" href="${href}"><span class="icon-tile tile-${tone}">${icon(ic)}</span><div><div class="an-k">${k}</div><div class="ok-v">${v}</div><div class="an-s">${s}</div></div></a>`).join('')}
      </div>

      <div class="orgp-layout">
        <section class="hud-card glass og-att">
          <div class="hc-head"><h2 class="hc-title">${icon('bell')} Needs attention</h2><span class="hc-meta">${hud.attentionTotal ? plural(hud.attentionTotal, 'item') : ''}</span></div>
          ${hud.attention.length ? `<div class="att-list">${hud.attention.slice(0, 7).map(attentionItem).join('')}</div>` : `<div class="all-clear">${icon('shield')}<div><strong>All clear</strong><div class="sub">Nothing needs you in this organization.</div></div></div>`}
        </section>

        <section class="hud-card glass og-infra">
          <div class="hc-head"><h2 class="hc-title">${icon('infrastructure')} Infrastructure</h2><a class="hc-link" href="#/infrastructure/${id}/overview">Open ${icon('arrow-ur')}</a></div>
          ${infraSnapshot(topo, id)}
        </section>

        <section class="hud-card glass og-srv">
          <div class="hc-head"><h2 class="hc-title">${icon('server')} Servers</h2><span class="hc-meta">${hud.servers.filter((s) => !s.offline).length} of ${plural(hud.servers.length, 'server')} reporting</span></div>
          ${hud.servers.length ? `<div class="srv-grid">${hud.servers.map(serverTile).join('')}</div>` : '<div class="hc-empty">No servers in this organization.</div>'}
        </section>

        <section class="hud-card glass og-risk">
          <div class="hc-head"><h2 class="hc-title">${icon('sparkle')} AI findings</h2><a class="hc-link" href="#/review/${id}/inbox">Review ${icon('arrow-ur')}</a></div>
          <div class="sev-strip">${['critical', 'high', 'medium', 'low'].map((s) => `<div class="sev sev-${s}"><span class="sev-v">${hud.review.bySeverity[s] ?? 0}</span><span class="sev-k">${s}</span></div>`).join('')}</div>
          ${hud.review.topRisks.length ? `<div class="risk-list">${hud.review.topRisks.slice(0, 6).map((r) => `<a class="risk-row" href="#/review/${id}/item?i=${esc(r.id)}"><span class="badge ${r.severity === 'critical' ? 'badge-bad' : 'badge-warn'}">${esc(r.severity)}</span><span class="rr-title">${esc(r.title)}</span><span class="sub">${esc(r.category ?? '')}</span></a>`).join('')}</div>`
            : hud.review.byCategory.length ? hBars(hud.review.byCategory.slice(0, 5).map((c, i) => ({ label: c.category, value: c.open, color: `var(--chart-${(i % 6) + 1})` }))) : '<div class="hc-empty">No open findings.</div>'}
        </section>

        <section class="hud-card glass og-off">
          <div class="hc-head"><h2 class="hc-title">${icon('warn')} Offline devices</h2><a class="hc-link" href="#/devices?org=${id}&offline=1">All ${offline.total ?? ''} ${icon('arrow-ur')}</a></div>
          ${offline.rows?.length ? `<div class="off-list">${offline.rows.map((d) => `<a class="off-row" href="#/device/${d.device_id}/overview"><span class="led is-off"></span><span class="mono-val">${esc(d.system_name)}</span><span class="sub">${esc(d.display_name ?? '')}</span><span class="off-age" title="${esc(fmtTs(d.last_contact))}">${ago(d.last_contact)}</span></a>`).join('')}</div>`
            : '<div class="all-clear">' + icon('check') + '<div><strong>Everything is online</strong><div class="sub">As of the last sync.</div></div></div>'}
        </section>

        <section class="hud-card glass og-act">
          <div class="hc-head"><h2 class="hc-title"><span class="dot live" style="color:var(--ok)"></span> Recent activity</h2></div>
          ${hud.stream.length ? `<div class="timeline">${hud.stream.slice(0, 8).map(streamRow).join('')}</div>` : '<div class="hc-empty">No recorded activity.</div>'}
        </section>
      </div>
    </div>`;
  countUp(el);
  if (scopeOrg() !== id) setScope(id, { render: false });
}
