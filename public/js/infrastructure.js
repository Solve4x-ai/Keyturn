// INFRA-2 — Organization Infrastructure, visual edition.
// Route: #/infrastructure/<orgId>/<tab>, tabs: overview | directory | dns |
// dhcp | gpo | coverage. Draws from GET /api/v1/orgs/:id/infrastructure/topology
// (one structured model) instead of long entity lists. Details open in the
// right-hand inspector; every node still links to its evidence history.
// "Health signals" are derived only from collected evidence and say so.
// An as-of date switches to the historical list renderer (infra-history.js).
import { api, state, $, esc, ago, fmtTs, ctx } from './core.js';
import { pageHeader } from './components.js';
import { icon } from './icons.js';
import { ring } from './charts.js';
import { requireOrg, orgName } from './scope.js';
import { openDrawer } from './device-drawer.js';
import { renderHistorical, expandEntity, refreshButton, wireRefresh } from './infra-history.js';

const TABS = [
  ['overview', 'Overview', 'overview'],
  ['directory', 'Directory', 'building'],
  ['dns', 'DNS', 'network'],
  ['dhcp', 'DHCP', 'wifi'],
  ['gpo', 'Group Policy', 'layers'],
  ['coverage', 'Evidence', 'check'],
];
const FSMO_LABEL = { schema: 'Schema master', naming: 'Domain naming', pdc: 'PDC emulator', rid: 'RID master', infra: 'Infrastructure' };

let cache = { orgId: null, at: 0, data: null };
async function topology(orgId) {
  if (cache.orgId === orgId && Date.now() - cache.at < 20_000) return cache.data;
  const data = await api(`/api/v1/orgs/${orgId}/infrastructure/topology`);
  cache = { orgId, at: Date.now(), data };
  return data;
}

const short = (h) => String(h ?? '').split('.')[0];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dur = (s) => {
  if (s == null) return '—';
  if (s % 86400 === 0) return plural(s / 86400, 'day');
  if (s % 3600 === 0) return plural(s / 3600, 'hour');
  return s >= 3600 ? `${(s / 3600).toFixed(1)} hours` : `${Math.round(s / 60)} min`;
};
const levelLabel = (m) => (m ? m.replace(/^Windows(\d{4})(R2)?(Forest|Domain)$/, (_, y, r2) => `Windows Server ${y}${r2 ? ' R2' : ''}`) : '—');
const ledState = (agent) => (agent ? (agent.offline ? 'is-off' : '') : 'is-unknown');
const agentLabel = (agent) => (agent ? (agent.offline ? 'agent offline' : 'agent online') : 'no NinjaOne agent matched');
const isPublicIp = (ip) => /^(\d+)\.(\d+)\./.test(ip) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);

/* ── Health signals — derived from collected evidence, never guessed ──── */
function signals(t) {
  const out = [];
  const dcIps = new Set(t.directory.dcs.map((d) => d.ip).filter(Boolean));
  const dcs = t.directory.dcs;
  if (dcs.length > 1 && dcs[0].fsmo.length === 5) out.push({ sev: 'info', tab: 'directory', title: `All five FSMO roles are on ${short(dcs[0].host)}`, sub: 'Common and fine for a small domain — but that DC is a single point for schema, RID, and PDC operations.' });
  if (dcs.length === 1) out.push({ sev: 'warn', tab: 'directory', title: 'Only one domain controller observed', sub: 'No directory redundancy is visible in the collected evidence.' });
  for (const s of t.dhcp.servers) {
    if (s.authorized === false && s.scopes.some((z) => z.state === 'Active')) out.push({ sev: 'bad', tab: 'dhcp', title: `${short(s.name)} has active scopes but is not authorized in AD`, sub: 'An unauthorized Windows DHCP server will not lease — its scopes are configuration, not service.' });
    for (const z of s.scopes) {
      if (z.pctUsed != null && z.pctUsed >= 80) out.push({ sev: z.pctUsed >= 90 ? 'bad' : 'warn', tab: 'dhcp', title: `Scope ${z.label} (${short(s.name)}) is ${z.pctUsed}% used`, sub: `${z.free ?? '?'} free addresses left in ${z.start}–${z.end}.` });
      const stale = z.dnsServers.filter((ip) => !isPublicIp(ip) && dcIps.size && !dcIps.has(ip));
      const pub = z.dnsServers.filter(isPublicIp);
      const asOf = ` As of evidence collected ${ago(z.collectedAt)} — re-collect after any change.`;
      if (z.state === 'Active' && stale.length) out.push({ sev: 'warn', tab: 'dhcp', title: `Scope ${z.label} (${short(s.name)}) hands out DNS ${stale.join(', ')}`, sub: `Not an observed domain controller address (DCs: ${[...dcIps].join(', ')}).${asOf}` });
      if (z.state === 'Active' && pub.length) out.push({ sev: 'warn', tab: 'dhcp', title: `Scope ${z.label} (${short(s.name)}) includes public DNS ${pub.join(', ')}`, sub: `Clients that fall back to a public resolver cannot resolve AD names.${asOf}` });
    }
  }
  const dead = t.dhcp.authorizations.filter((a) => !a.agent);
  if (dead.length) out.push({ sev: 'warn', tab: 'dhcp', title: `${plural(dead.length, 'AD DHCP authorization')} with no matching device`, sub: `${dead.map((a) => short(a.host)).join(', ')} — likely decommissioned servers still registered.` });
  const zones = t.dns.servers[0]?.zones ?? [];
  const insecure = zones.filter((z) => z.insecureUpdates);
  if (insecure.length) out.push({ sev: 'warn', tab: 'dns', title: `${plural(insecure.length, 'zone')} accept nonsecure dynamic updates`, sub: insecure.map((z) => z.name).join(', ') });
  for (const s of t.dns.servers) if (s.scavenging && !s.scavenging.enabled) { out.push({ sev: 'info', tab: 'dns', title: `DNS scavenging is off on ${short(s.name)}`, sub: 'Stale dynamic records accumulate until removed by hand.' }); break; }
  const pubFwd = [...new Set(t.dns.servers.flatMap((s) => s.forwarders))];
  if (pubFwd.length) out.push({ sev: 'info', tab: 'dns', title: `Forwarding to ${pubFwd.join(', ')}`, sub: 'External resolution depends on these resolvers.' });
  if (t.gpo.counts.unlinked) out.push({ sev: 'info', tab: 'gpo', title: `${plural(t.gpo.counts.unlinked, 'GPO')} not linked anywhere`, sub: 'They apply to nothing — cleanup candidates.' });
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

const signalRow = (s) => `<button class="sig-row sig-${s.sev}" data-go-tab="${s.tab}"><span class="sig-ic">${icon(s.sev === 'info' ? 'eye' : 'warn')}</span><span class="sig-body"><span class="sig-title">${esc(s.title)}</span><span class="sig-sub">${esc(s.sub)}</span></span><span class="sig-go">${icon('chev-r')}</span></button>`;

function dcCard(dc) {
  return `<button class="dc-card glass" data-ent="${esc(dc.id)}" data-ent-title="${esc(dc.host)}">
    <div class="dcc-head"><span class="led ${ledState(dc.agent)}" title="${agentLabel(dc.agent)}"></span><span class="dcc-name">${esc(short(dc.host))}</span>
      ${dc.gc ? '<span class="badge badge-info" title="Global catalog">GC</span>' : ''}${dc.rodc ? '<span class="badge badge-warn">RODC</span>' : ''}</div>
    <div class="dcc-meta"><span class="mono-val">${esc(dc.ip ?? '—')}</span><span>${esc(dc.os ?? 'OS unknown')}</span><span>${icon('building')} ${esc(dc.site ?? 'site unknown')}</span></div>
    <div class="dcc-fsmo">${Object.keys(FSMO_LABEL).map((r) => `<span class="fsmo-pip${dc.fsmo.includes(r) ? ' on' : ''}" title="${FSMO_LABEL[r]}${dc.fsmo.includes(r) ? ' — held here' : ''}">${r}</span>`).join('')}</div>
    ${dc.agent ? `<a class="dcc-link" href="#/device/${dc.agent.deviceId}/overview">${icon('devices')} device page</a>` : ''}
  </button>`;
}

/* ── Overview ─────────────────────────────────────────────────────────── */
function overview(t, orgId) {
  const d = t.directory;
  const dom = d.domains[0];
  const sig = signals(t);
  const zones = t.dns.servers[0]?.zones ?? [];
  const recCount = t.dns.records.length;
  const g = t.gpo.counts;
  const cov = t.coverage.reduce((m, c) => { m[c.status] = (m[c.status] ?? 0) + 1; return m; }, {});
  return `
    <section class="domain-hero glass">
      <div class="dh-main">
        <span class="icon-tile tile-obs dh-ic">${icon('building')}</span>
        <div><div class="ph-kicker">Active Directory</div><div class="dh-name">${esc(dom?.dnsRoot ?? d.forest?.name ?? 'No domain observed')}</div>
          <div class="dh-meta">${dom?.netbios ? `<span>${esc(dom.netbios)}</span>` : ''}<span>Forest level ${esc(levelLabel(d.forest?.mode))}</span><span>Domain level ${esc(levelLabel(dom?.mode))}</span><span>${plural(d.sites.length, 'site')}</span><span>${plural(d.forest?.gcCount ?? d.dcs.filter((x) => x.gc).length, 'global catalog')}</span></div></div>
      </div>
      <div class="fsmo-map">${d.fsmo.map((f) => `<div class="fsmo-cell${f.holder ? '' : ' unknown'}"><span class="fc-role">${esc(FSMO_LABEL[f.role])}</span><span class="fc-holder">${esc(f.holder ? short(f.holder) : 'not observed')}</span></div>`).join('')}</div>
    </section>

    <div class="dc-grid">${d.dcs.map(dcCard).join('') || '<div class="hc-empty">No domain controllers observed.</div>'}</div>

    <div class="infra-grid">
      <section class="hud-card glass svc-card" data-go-tab="dns">
        <div class="hc-head"><h2 class="hc-title">${icon('network')} DNS</h2><span class="hc-meta">${plural(t.dns.servers.length, 'server')}</span></div>
        <div class="svc-nums"><div><b>${zones.length}</b><span>zones</span></div><div><b>${recCount}</b><span>records</span></div><div class="${zones.some((z) => z.insecureUpdates) ? 'warn' : ''}"><b>${zones.filter((z) => z.insecureUpdates).length}</b><span>nonsecure</span></div></div>
        <div class="svc-chips">${[...new Set(t.dns.servers.flatMap((s) => s.forwarders))].map((f) => `<span class="badge badge-muted">→ ${esc(f)}</span>`).join('') || '<span class="sub">no forwarders</span>'}</div>
      </section>
      <section class="hud-card glass svc-card" data-go-tab="dhcp">
        <div class="hc-head"><h2 class="hc-title">${icon('wifi')} DHCP</h2><span class="hc-meta">${plural(t.dhcp.servers.length, 'server')}</span></div>
        ${t.dhcp.servers.flatMap((s) => s.scopes.filter((z) => z.state === 'Active').map((z) => {
          const tone = z.pctUsed == null ? 'muted' : z.pctUsed >= 90 ? 'bad' : z.pctUsed >= 75 ? 'warn' : 'ok';
          return `<div class="snap-scope"><div class="ss-head"><span>${esc(z.label)} <span class="sub">${esc(short(s.name))}${s.authorized === false ? ' · <b class="bad-text">unauthorized</b>' : ''}</span></span><span class="ss-pct tone-${tone}">${z.pctUsed ?? '—'}%</span></div><div class="util-bar"><span class="tone-${tone}" style="width:${z.pctUsed ?? 0}%"></span></div></div>`;
        })).join('') || '<div class="hc-empty">No active scopes.</div>'}
      </section>
      <section class="hud-card glass svc-card" data-go-tab="gpo">
        <div class="hc-head"><h2 class="hc-title">${icon('layers')} Group Policy</h2><span class="hc-meta">${plural(g.total, 'GPO')}</span></div>
        <div class="gpo-mini">
          <div class="ring-wrap sm" style="width:96px;height:96px">${ring({ value: g.enabled, total: g.total, size: 96, stroke: 9, title: 'GPO status', segments: [
            { value: g.enabled, color: 'var(--ok)' }, { value: g.partial, color: 'var(--warn)' }, { value: g.disabled, color: 'var(--text-faint)' },
          ] })}<div class="ring-center"><div class="ring-value" style="font-size:22px">${g.total}</div></div></div>
          <ul class="mini-legend"><li><i style="background:var(--ok)"></i>${g.enabled} enabled</li><li><i style="background:var(--warn)"></i>${g.partial} half-disabled</li><li><i style="background:var(--text-faint)"></i>${g.disabled} disabled</li><li class="${g.unlinked ? 'warn' : ''}"><i style="background:var(--bad)"></i>${g.unlinked ?? '?'} unlinked</li></ul>
        </div>
      </section>
    </div>

    <div class="infra-grid two">
      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('pulse')} Health signals</h2><span class="hc-meta ${t.lastCollected && Date.now() - t.lastCollected > 3 * 86400_000 ? 'warn-text' : ''}">from evidence collected ${t.lastCollected ? ago(t.lastCollected) : 'never'}</span></div>
        ${sig.length ? `<div class="sig-list">${sig.map(signalRow).join('')}</div>` : `<div class="all-clear">${icon('shield')}<div><strong>No signals</strong><div class="sub">Nothing in the collected evidence stands out.</div></div></div>`}
      </section>
      <section class="hud-card glass">
        <div class="hc-head"><h2 class="hc-title">${icon('sparkle')} Findings</h2><a class="hc-link" href="#/review/${orgId}/inbox">Review Center ${icon('arrow-ur')}</a></div>
        ${t.findings.length ? `<div class="sig-list">${t.findings.slice(0, 8).map((f) => `<a class="sig-row sig-warn" href="#/review/${orgId}/inbox"><span class="sig-ic">${icon('sparkle')}</span><span class="sig-body"><span class="sig-title">${esc(f.title)}</span><span class="sig-sub">${esc(f.rule ?? '')} · ${ago(f.at)}</span></span><span class="sig-go">${icon('chev-r')}</span></a>`).join('')}</div>` : '<div class="hc-empty">No open findings.</div>'}
        <div class="cov-strip" data-go-tab="coverage" title="Evidence sections by status">
          ${['complete', 'partial', 'unverified', 'failed'].map((s) => cov[s] ? `<span class="cov-seg cov-${s}" style="flex:${cov[s]}">${cov[s]} ${s}</span>` : '').join('')}
        </div>
      </section>
    </div>`;
}

/* ── Directory ────────────────────────────────────────────────────────── */
function directory(t) {
  const d = t.directory;
  return `
    <div class="dir-tree">
      <div class="tree-node glass tn-forest"><span class="tn-k">${icon('layers')} Forest</span><span class="tn-v">${esc(d.forest?.name ?? 'not observed')}</span><span class="tn-s">${esc(levelLabel(d.forest?.mode))}</span></div>
      ${d.domains.map((dom) => `
        <div class="tree-branch">
          <div class="tree-node glass tn-domain"><span class="tn-k">${icon('building')} Domain</span><span class="tn-v">${esc(dom.dnsRoot)}</span><span class="tn-s">${esc(dom.netbios ?? '')} · ${esc(levelLabel(dom.mode))}</span></div>
          ${d.sites.map((s) => `
            <div class="tree-branch">
              <div class="tree-node glass tn-site"><span class="tn-k">${icon('network')} Site</span><span class="tn-v">${esc(s.name)}</span><span class="tn-s">${plural(s.dcs.length, 'DC')}</span></div>
              <div class="tree-branch leaf"><div class="dc-grid">${d.dcs.filter((x) => x.site === s.name).map(dcCard).join('')}</div></div>
            </div>`).join('')}
          ${d.dcs.some((x) => !x.site || !d.sites.some((s) => s.name === x.site)) ? `<div class="tree-branch leaf"><div class="dc-grid">${d.dcs.filter((x) => !x.site || !d.sites.some((s) => s.name === x.site)).map(dcCard).join('')}</div></div>` : ''}
        </div>`).join('')}
    </div>
    <section class="hud-card glass" style="margin-top:var(--sp-4)">
      <div class="hc-head"><h2 class="hc-title">${icon('key')} Operations master (FSMO) roles</h2></div>
      <div class="fsmo-map wide">${d.fsmo.map((f) => `<div class="fsmo-cell${f.holder ? '' : ' unknown'}"><span class="fc-role">${esc(FSMO_LABEL[f.role])}</span><span class="fc-holder">${esc(f.holder ?? 'not observed')}</span><span class="sub">${f.role === 'schema' || f.role === 'naming' ? 'forest-wide' : 'domain-wide'}</span></div>`).join('')}</div>
    </section>`;
}

/* ── DNS ──────────────────────────────────────────────────────────────── */
const RT_COLORS = { A: 'var(--chart-1)', AAAA: 'var(--chart-6)', CNAME: 'var(--chart-2)', PTR: 'var(--chart-3)', SRV: 'var(--chart-4)', NS: 'var(--chart-5)', SOA: 'var(--text-faint)', MX: 'var(--warn)', TXT: 'var(--obs)' };
function zoneTile(z) {
  const total = Object.values(z.recordTypes).reduce((a, b) => a + b, 0);
  const dyn = z.dynamicUpdate ?? '—';
  const dynCls = z.insecureUpdates ? 'badge-warn' : /secure/i.test(dyn) ? 'badge-ok' : 'badge-muted';
  return `<button class="zone-tile glass${z.insecureUpdates ? ' is-warn' : ''}" data-zone="${esc(z.id)}">
    <div class="zt-head"><span class="zt-ic">${icon(z.reverse ? 'history' : 'network')}</span><span class="zt-name" title="${esc(z.name)}">${esc(z.name)}</span></div>
    <div class="zt-badges"><span class="badge badge-muted">${esc(z.type ?? '?')}${z.reverse ? ' · reverse' : ''}</span>${z.dsIntegrated ? '<span class="badge badge-info" title="Active Directory–integrated">AD</span>' : ''}<span class="badge ${dynCls}" title="Dynamic updates">${esc(dyn === 'NonsecureAndSecure' ? 'nonsecure' : dyn === 'None' ? 'no updates' : dyn.toLowerCase())}</span></div>
    <div class="zt-foot"><span class="zt-count">${z.recordCount ?? '—'}<small> records</small></span>
      ${total ? `<span class="rt-bar">${Object.entries(z.recordTypes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span style="flex:${n};background:${RT_COLORS[k] ?? 'var(--text-faint)'}" title="${esc(k)}: ${n}"></span>`).join('')}</span>` : '<span class="sub">records not collected</span>'}</div>
  </button>`;
}
function dns(t) {
  const servers = t.dns.servers;
  if (!servers.length) return '<div class="hc-empty">No DNS evidence collected for this organization.</div>';
  const si = Math.min(state.infraDnsServer ?? 0, servers.length - 1);
  const s = servers[si];
  const f = state.infraDnsFilter ?? 'all';
  const q = (state.infraDnsQ ?? '').toLowerCase();
  const zones = s.zones.filter((z) => (f === 'all' || (f === 'forward' && !z.reverse) || (f === 'reverse' && z.reverse) || (f === 'nonsecure' && z.insecureUpdates) || (f === 'nonad' && !z.dsIntegrated)) && (!q || z.name.toLowerCase().includes(q)));
  const divergent = t.dns.zoneMatrix.filter((r) => r.servers.includes(false));
  return `
    <div class="infra-toolbar">
      ${servers.length > 1 ? `<div class="seg" role="radiogroup" aria-label="DNS server">${servers.map((x, i) => `<button class="seg-btn" role="radio" data-dns-server="${i}" aria-checked="${i === si}"><span class="led ${ledState(x.agent)}"></span> ${esc(short(x.name))}</button>`).join('')}</div>` : ''}
      <div class="seg" role="radiogroup" aria-label="Zone filter">${[['all', 'All'], ['forward', 'Forward'], ['reverse', 'Reverse'], ['nonsecure', 'Nonsecure'], ['nonad', 'Not AD-integrated']].map(([k, l]) => `<button class="seg-btn" role="radio" data-dns-filter="${k}" aria-checked="${f === k}">${l}</button>`).join('')}</div>
      <input type="search" id="dns-q" class="fi-search" placeholder="Find a zone…" value="${esc(state.infraDnsQ ?? '')}" />
    </div>
    <div class="srv-strip glass">
      <span class="led ${ledState(s.agent)}" title="${agentLabel(s.agent)}"></span><strong>${esc(s.name)}</strong>
      <span class="ss-item">${icon('arrow-ur')} forwarders ${s.forwarders.length ? s.forwarders.map((x) => `<code>${esc(x)}</code>`).join(' ') : '—'}</span>
      <span class="ss-item">${icon('refresh')} scavenging ${s.scavenging ? (s.scavenging.enabled ? `<b class="ok-text">on</b> (${s.scavenging.intervalHours}h)` : '<b class="warn-text">off</b>') : 'unverified'}</span>
      <span class="ss-item">${plural(s.zones.length, 'zone')} · collected ${ago(s.collectedAt)}</span>
    </div>
    ${divergent.length ? `<div class="sec-banner warn">${icon('warn')}<div><strong>Zone sets differ between DNS servers:</strong> ${divergent.map((r) => esc(r.zone)).join(', ')}</div></div>` : ''}
    <div class="zone-grid">${zones.map(zoneTile).join('') || '<div class="hc-empty">No zones match.</div>'}</div>`;
}

function zoneDrawer(t, zone, orgId) {
  const recs = t.dns.records.filter((r) => r.ns === zone.recordNamespace);
  const types = [...new Set(recs.map((r) => r.type))].sort();
  const body = `
    <div class="insp-meta">
      <span class="badge badge-muted">${esc(zone.type ?? '?')}${zone.reverse ? ' · reverse' : ''}</span>${zone.dsIntegrated ? '<span class="badge badge-info">AD-integrated</span>' : ''}
      <span class="badge ${zone.insecureUpdates ? 'badge-warn' : 'badge-ok'}">updates: ${esc(zone.dynamicUpdate ?? '—')}</span><span class="sub">collected ${ago(zone.collectedAt)}</span>
    </div>
    ${recs.length ? `<div class="insp-tools"><input type="search" id="rec-q" placeholder="Filter records…" /><div class="seg" id="rec-types"><button class="seg-btn" data-rt="" aria-checked="true">All ${recs.length}</button>${types.map((x) => `<button class="seg-btn" data-rt="${esc(x)}" aria-checked="false">${esc(x)} ${recs.filter((r) => r.type === x).length}</button>`).join('')}</div></div>
      <table class="data insp-table"><thead><tr><th>Host</th><th>Type</th><th>Data</th><th>TTL</th><th></th></tr></thead><tbody id="rec-body">
      ${recs.sort((a, b) => String(a.host).localeCompare(String(b.host))).map((r) => `<tr data-rt="${esc(r.type)}" data-q="${esc(`${r.host} ${r.data}`.toLowerCase())}"><td class="mono-val">${esc(r.host)}</td><td><span class="badge badge-muted" style="border-color:${RT_COLORS[r.type] ?? 'var(--border)'}">${esc(r.type)}</span></td><td class="mono-val wrap">${esc(r.data ?? '—')}</td><td class="sub">${esc(dur(r.ttl))}</td><td>${r.static ? '<span class="badge badge-muted">static</span>' : '<span class="badge badge-info">dynamic</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="hc-empty">Records for this zone were not collected on this server.</div>'}
    <details class="identity-details" id="ev-details"><summary>Evidence &amp; history</summary><div id="ev-slot"></div></details>`;
  openDrawer(`${icon('network')} ${esc(zone.name)}`, body);
  wireInspector(orgId, zone.id);
  const apply = () => {
    const q = ($('#rec-q')?.value ?? '').toLowerCase();
    const rt = document.querySelector('#rec-types [aria-checked="true"]')?.dataset.rt ?? '';
    document.querySelectorAll('#rec-body tr').forEach((tr) => { tr.hidden = (rt && tr.dataset.rt !== rt) || (q && !tr.dataset.q.includes(q)); });
  };
  $('#rec-q')?.addEventListener('input', apply);
  document.querySelectorAll('#rec-types [data-rt]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#rec-types [data-rt]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    apply();
  }));
}

/* ── DHCP ─────────────────────────────────────────────────────────────── */
function scopeCard(z, s, dcIps) {
  const tone = z.pctUsed == null ? 'muted' : z.pctUsed >= 90 ? 'bad' : z.pctUsed >= 75 ? 'warn' : 'ok';
  const total = (z.inUse ?? 0) + (z.free ?? 0);
  return `<button class="scope-card glass${z.state !== 'Active' ? ' is-inactive' : ''}" data-scope="${esc(z.id)}" data-server="${esc(s.id)}">
    <div class="sc-gauge">${ring({ value: z.inUse ?? 0, total: total || 1, size: 92, stroke: 9, title: `${z.pctUsed ?? 0}% used`, segments: [{ value: z.inUse ?? 0, color: `var(--${tone === 'muted' ? 'text-faint' : tone})` }] })}
      <div class="ring-center"><div class="ring-value" style="font-size:19px">${z.pctUsed == null ? '—' : `${Math.round(z.pctUsed)}%`}</div><div class="ring-of">${z.state === 'Active' ? 'used' : esc((z.state ?? '').toLowerCase())}</div></div></div>
    <div class="sc-body">
      <div class="sc-name">${esc(z.label)}</div>
      <div class="sc-range mono-val">${esc(z.start ?? '?')} – ${esc(z.end ?? '?')}</div>
      <div class="sc-nums"><span><b>${z.inUse ?? '—'}</b> in use</span><span><b>${z.free ?? '—'}</b> free</span><span><b>${z.reservations}</b> reserved</span></div>
      <div class="sc-opts">
        ${z.router.length ? `<span title="Default gateway (option 3)">${icon('network')} ${z.router.map(esc).join(', ')}</span>` : ''}
        <span title="DNS servers (option 6)">${icon('server')} ${z.dnsServers.map((ip) => `<code class="${isPublicIp(ip) ? 'warn-text' : dcIps.size && !dcIps.has(ip) ? 'bad-text' : ''}" title="${isPublicIp(ip) ? 'public resolver' : dcIps.has(ip) ? 'domain controller' : 'not an observed DC'}">${esc(ip)}</code>`).join(' ') || '—'}</span>
        <span title="Lease duration (option 51)">${icon('clock')} ${esc(dur(z.leaseSeconds))}</span>
      </div>
    </div>
  </button>`;
}
function dhcp(t) {
  if (!t.dhcp.servers.length && !t.dhcp.authorizations.length) return '<div class="hc-empty">No DHCP evidence collected for this organization.</div>';
  const dcIps = new Set(t.directory.dcs.map((d) => d.ip).filter(Boolean));
  return `
    ${t.dhcp.servers.map((s) => `
      <section class="dhcp-server">
        <div class="srv-strip glass">
          <span class="led ${ledState(s.agent)}" title="${agentLabel(s.agent)}"></span><strong>${esc(s.name)}</strong>
          ${s.authorized === true ? '<span class="badge badge-ok">authorized in AD</span>' : s.authorized === false ? '<span class="badge badge-bad">NOT authorized in AD</span>' : '<span class="badge badge-muted">authorization unverified</span>'}
          <span class="ss-item">${plural(s.scopes.length, 'scope')} · ${s.scopes.reduce((a, z) => a + z.leases, 0)} leases · ${s.scopes.reduce((a, z) => a + z.reservations, 0)} reservations · collected ${ago(s.collectedAt)}</span>
        </div>
        ${s.authorized === false ? `<div class="sec-banner warn">${icon('warn')}<div>An unauthorized Windows DHCP server does not lease addresses — the scopes below are configuration, not live service.</div></div>` : ''}
        <div class="scope-grid">${s.scopes.map((z) => scopeCard(z, s, dcIps)).join('') || '<div class="hc-empty">No scopes observed.</div>'}</div>
      </section>`).join('')}
    ${t.dhcp.authorizations.length ? `<section class="hud-card glass" style="margin-top:var(--sp-4)">
      <div class="hc-head"><h2 class="hc-title">${icon('shield')} Authorized in Active Directory</h2><span class="hc-meta">directory registrations — checked against live agents</span></div>
      <div class="auth-grid">${t.dhcp.authorizations.map((a) => `<div class="auth-chip ${a.agent ? (a.agent.offline ? 'is-off' : 'is-live') : 'is-dead'}"><span class="led ${ledState(a.agent)}"></span><span class="mono-val">${esc(short(a.host))}</span><span class="sub">${a.agent ? agentLabel(a.agent) : 'no device found — stale?'}</span></div>`).join('')}</div>
    </section>` : ''}
    ${t.dhcp.clientsTruncated ? '<div class="sub">Client list truncated for display.</div>' : ''}`;
}

function scopeDrawer(t, scope, server, orgId) {
  const clients = t.dhcp.clients.filter((c) => c.sourceDeviceId === server.sourceDeviceId && c.scopeId === String(scope.scopeId ?? '').toLowerCase())
    .sort((a, b) => String(a.ip).localeCompare(String(b.ip), undefined, { numeric: true }));
  const body = `
    <div class="insp-meta"><span class="badge ${scope.state === 'Active' ? 'badge-ok' : 'badge-muted'}">${esc(scope.state ?? '?')}</span><span class="mono-val">${esc(scope.start)} – ${esc(scope.end)}</span><span class="sub">on ${esc(short(server.name))} · collected ${ago(scope.collectedAt)}</span></div>
    <div class="insp-kv">
      <div><span class="ik">Gateway</span><span>${scope.router.map(esc).join(', ') || '—'}</span></div>
      <div><span class="ik">DNS servers</span><span class="mono-val">${scope.dnsServers.map(esc).join(', ') || '—'}</span></div>
      <div><span class="ik">Domain</span><span>${esc(scope.domain ?? '—')}</span></div>
      <div><span class="ik">Lease</span><span>${esc(dur(scope.leaseSeconds))}</span></div>
    </div>
    ${clients.length ? `<div class="insp-tools"><input type="search" id="cl-q" placeholder="Filter by IP, name, MAC…" /><div class="seg" id="cl-kind"><button class="seg-btn" data-k="" aria-checked="true">All ${clients.length}</button><button class="seg-btn" data-k="lease" aria-checked="false">Leases ${clients.filter((c) => c.kind === 'lease').length}</button><button class="seg-btn" data-k="reservation" aria-checked="false">Reserved ${clients.filter((c) => c.kind === 'reservation').length}</button></div></div>
      <table class="data insp-table"><thead><tr><th>IP</th><th>Name</th><th>MAC</th><th>Kind</th><th>State</th></tr></thead><tbody id="cl-body">
      ${clients.map((c) => `<tr data-k="${c.kind}" data-q="${esc(`${c.ip} ${c.name ?? ''} ${c.mac ?? ''}`.toLowerCase())}"><td class="mono-val">${esc(c.ip)}</td><td>${c.agent ? `<a href="#/device/${c.agent.deviceId}/overview">${esc(c.name ?? '—')}</a>` : esc(c.name ?? '—')}</td><td class="mono-val sub">${esc(c.mac ?? '—')}</td>
        <td><span class="badge ${c.kind === 'reservation' ? 'badge-info' : 'badge-muted'}">${c.kind}</span></td><td><span class="badge ${/inactive|expired|declined/i.test(c.state ?? '') ? 'badge-warn' : /active|configured/i.test(c.state ?? '') ? 'badge-ok' : 'badge-muted'}">${esc(c.state ?? '—')}</span></td></tr>`).join('')}
      </tbody></table>` : '<div class="hc-empty">No clients observed in this scope.</div>'}
    <details class="identity-details"><summary>Evidence &amp; history</summary><div id="ev-slot"></div></details>`;
  openDrawer(`${icon('wifi')} ${esc(scope.label)} <span class="sub">${esc(scope.scopeId ?? '')}</span>`, body);
  wireInspector(orgId, scope.id);
  const apply = () => {
    const q = ($('#cl-q')?.value ?? '').toLowerCase();
    const k = document.querySelector('#cl-kind [aria-checked="true"]')?.dataset.k ?? '';
    document.querySelectorAll('#cl-body tr').forEach((tr) => { tr.hidden = (k && tr.dataset.k !== k) || (q && !tr.dataset.q.includes(q)); });
  };
  $('#cl-q')?.addEventListener('input', apply);
  document.querySelectorAll('#cl-kind [data-k]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#cl-kind [data-k]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    apply();
  }));
}

/* ── Group Policy ─────────────────────────────────────────────────────── */
const GPO_STATE = {
  enabled: ['badge-ok', 'Enabled', 'Computer and User settings on — applies where linked'],
  'user-off': ['badge-warn', 'User side off', 'User Configuration disabled; Computer settings still process'],
  'computer-off': ['badge-warn', 'Computer side off', 'Computer Configuration disabled; User settings still process'],
  disabled: ['badge-muted', 'Disabled', 'Both halves off — inert wherever linked'],
  unknown: ['badge-muted', 'Unknown', 'Status not collected'],
};
const toMs = (v) => { const m = /\/Date\((\d+)\)\//.exec(String(v ?? '')); return m ? Number(m[1]) : Date.parse(v) || null; };
function gpo(t) {
  const g = t.gpo;
  const f = state.infraGpoFilter ?? 'all';
  const q = (state.infraGpoQ ?? '').toLowerCase();
  const mode = state.infraGpoMode ?? 'gpos';
  const list = g.gpos.filter((x) => (f === 'all' || (f === 'unlinked' && x.linked === false) || (f === 'disabled' && x.enabled === 'disabled') || (f === 'partial' && (x.enabled === 'user-off' || x.enabled === 'computer-off')) || (f === 'enabled' && x.enabled === 'enabled'))
    && (!q || x.name.toLowerCase().includes(q)));
  const card = (k, label, n, tone) => `<button class="gpo-stat glass${f === k ? ' is-active' : ''} tone-${tone}" data-gpo-filter="${k}"><span class="gs-v">${n ?? '?'}</span><span class="gs-k">${label}</span></button>`;
  return `
    <div class="gpo-stats">
      ${card('all', 'All GPOs', g.counts.total, 'accent')}${card('enabled', 'Enabled', g.counts.enabled, 'ok')}${card('partial', 'Half-disabled', g.counts.partial, 'warn')}${card('disabled', 'Disabled', g.counts.disabled, 'muted')}${card('unlinked', 'Unlinked', g.counts.unlinked, g.counts.unlinked ? 'warn' : 'muted')}
    </div>
    <div class="infra-toolbar">
      <div class="seg" role="radiogroup" aria-label="View"><button class="seg-btn" data-gpo-mode="gpos" aria-checked="${mode === 'gpos'}">By policy</button><button class="seg-btn" data-gpo-mode="ous" aria-checked="${mode === 'ous'}">By container</button></div>
      ${mode === 'gpos' ? `<input type="search" id="gpo-q" class="fi-search" placeholder="Find a GPO…" value="${esc(state.infraGpoQ ?? '')}" /><span class="sub">${list.length} of ${g.gpos.length}</span>` : ''}
      ${!g.linksComplete ? '<span class="badge badge-warn" title="Link targets were not fully collected — unlinked cannot be claimed">links incomplete</span>' : ''}
    </div>
    ${mode === 'gpos' ? `<div class="gpo-grid">${list.map((x) => {
      const [cls, label, tip] = GPO_STATE[x.enabled] ?? GPO_STATE.unknown;
      const mod = toMs(x.modified);
      return `<button class="gpo-card glass${x.linked === false ? ' is-unlinked' : ''}" data-gpo="${esc(x.id)}">
        <div class="gc-name">${esc(x.name)}</div>
        <div class="gc-meta"><span class="badge ${cls}" title="${esc(tip)}">${label}</span>
          ${x.linked === false ? '<span class="badge badge-warn" title="Linked nowhere — applies to nothing">unlinked</span>' : x.links.length ? `<span class="badge badge-muted" title="${esc(x.links.join('\n'))}">${plural(x.links.length, 'link')}</span>` : '<span class="badge badge-muted">links unknown</span>'}</div>
        <div class="gc-foot sub">modified ${mod ? ago(mod) : '—'}</div>
      </button>`;
    }).join('') || '<div class="hc-empty">No GPOs match.</div>'}</div>`
    : `<div class="ou-list">${g.containers.map((c) => `<div class="ou-row glass"><div class="ou-path">${c.path.split('/').map((p, i, a) => `<span class="${i === a.length - 1 ? 'ou-leaf' : 'ou-seg'}">${esc(p)}</span>`).join('<span class="ou-sep">/</span>')}</div>
        <div class="ou-gpos">${c.gpos.length ? c.gpos.map((n) => { const x = g.gpos.find((y) => y.name === n); const [cls] = GPO_STATE[x?.enabled] ?? GPO_STATE.unknown; return `<span class="badge ${cls}">${esc(n)}</span>`; }).join('') : '<span class="sub">no GPOs linked</span>'}</div></div>`).join('') || '<div class="hc-empty">No containers observed.</div>'}</div>`}`;
}

function gpoDrawer(t, x, orgId) {
  const [cls, label, tip] = GPO_STATE[x.enabled] ?? GPO_STATE.unknown;
  const created = toMs(x.created); const mod = toMs(x.modified);
  openDrawer(`${icon('layers')} ${esc(x.name)}`, `
    <div class="insp-meta"><span class="badge ${cls}">${label}</span><span class="sub">${esc(tip)}</span></div>
    <div class="insp-kv"><div><span class="ik">Created</span><span>${created ? esc(fmtTs(created)) : '—'}</span></div><div><span class="ik">Modified</span><span>${mod ? `${esc(fmtTs(mod))} · ${ago(mod)}` : '—'}</span></div><div><span class="ik">Collected</span><span>${ago(x.collectedAt)}</span></div></div>
    <div class="section-title">Linked to</div>
    ${x.links.length ? `<div class="link-list">${x.links.map((l) => `<div class="link-row">${icon('building')}<span class="mono-val">${esc(l)}</span></div>`).join('')}</div>`
      : x.linked === false ? '<div class="sec-banner warn">' + icon('warn') + '<div>Linked nowhere in the latest complete collection — this GPO applies to nothing.</div></div>' : '<div class="sub">Link targets not collected.</div>'}
    <div class="sub" style="margin-top:8px">Whether a linked GPO actually applies (security filtering, WMI filters, precedence) is not inferred.</div>
    <details class="identity-details"><summary>Evidence &amp; history</summary><div id="ev-slot"></div></details>`);
  wireInspector(orgId, x.id);
}

/* ── Evidence (coverage matrix) ──────────────────────────────────────── */
function coverage(t) {
  const sources = [...new Map(t.coverage.map((c) => [c.sourceDeviceId, c.source ?? `device ${c.sourceDeviceId}`])).entries()];
  const sections = [...new Set(t.coverage.map((c) => c.section))].sort();
  const cell = (src, sec) => t.coverage.find((c) => c.sourceDeviceId === src && c.section === sec);
  return `
    <div class="sub" style="margin-bottom:var(--sp-3)">Each cell is one collection section from one source. Only <b>complete</b> sections can establish that something is absent; partial, failed, and unverified sections make no absence claims.</div>
    <div class="cov-matrix glass" style="--cols:${sections.length}">
      <div class="cm-corner">Source</div>${sections.map((s) => `<div class="cm-col">${esc(s)}</div>`).join('')}
      ${sources.map(([id, name]) => `<div class="cm-row"><span class="mono-val">${esc(name)}</span></div>${sections.map((sec) => {
        const c = cell(id, sec);
        return c ? `<div class="cm-cell cov-${esc(c.status)}" title="${esc(`${c.runbook ?? ''} · ${c.status}${c.count != null ? ` · ${c.count} items` : ''}${c.truncated ? ' (truncated)' : ''} · ${fmtTs(c.at)}`)}"><span>${esc(c.status)}</span><small>${c.count ?? ''}${c.truncated ? '+' : ''} · ${ago(c.at)}</small></div>` : '<div class="cm-cell cov-none"><span>—</span></div>';
      }).join('')}`).join('')}
    </div>
    <section class="hud-card glass" style="margin-top:var(--sp-4)">
      <div class="hc-head"><h2 class="hc-title">${icon('refresh')} Refresh evidence</h2><span class="hc-meta">creates a plan for your approval — never runs directly</span></div>
      <div class="refresh-grid">${[...new Map(t.coverage.filter((c) => c.runbook).map((c) => [`${c.runbook}|${c.sourceDeviceId}`, c])).values()].map((c) => `<div class="refresh-row"><span class="mono-val">${esc(c.runbook)}</span><span class="sub">on ${esc(c.source ?? c.sourceDeviceId)} · ${ago(c.at)}</span>${refreshButton(c.runbook, c.sourceDeviceId, 'Plan refresh')}</div>`).join('') || '<div class="hc-empty">No collections yet.</div>'}</div>
    </section>`;
}

/* ── Inspector plumbing ───────────────────────────────────────────────── */
function wireInspector(orgId, entityId) {
  const det = document.querySelector('#drawer-body details.identity-details');
  det?.addEventListener('toggle', () => { if (det.open && !det.dataset.loaded) { det.dataset.loaded = '1'; expandEntity($('#ev-slot'), orgId, entityId); } });
}
function entityDrawer(orgId, id, title) {
  openDrawer(esc(title), '<div id="ev-slot"><div class="sub">loading evidence…</div></div>');
  expandEntity($('#ev-slot'), orgId, id);
}

/* ── View root ────────────────────────────────────────────────────────── */
export async function infrastructureView(el) {
  const orgId = requireOrg(el, { title: 'Infrastructure', icon: 'infrastructure', sub: 'Directory, DNS, DHCP, and Group Policy are mapped per organization — choose one.' });
  if (orgId == null) return;
  state.infraOrg = orgId;
  const tab = state.infraTab || 'overview';
  el.innerHTML = `
    <div class="infra rise" data-view-root="infrastructure">
    ${pageHeader({
      icon: 'infrastructure', title: 'Infrastructure',
      subHtml: `Directory, DNS, DHCP, and Group Policy for <strong>${esc(orgName(orgId))}</strong> — mapped from collected evidence. Click anything for detail.`,
      actions: `<label class="asof ${state.infraAsOf ? 'is-on' : ''}" title="Replay the latest evidence collected by a date">${icon('history')}<input type="date" id="infra-asof" value="${esc(state.infraAsOf || '')}" /></label>
        ${state.infraAsOf ? '<button class="btn secondary" id="infra-asof-clear">Back to live</button>' : ''}`,
    })}
    ${state.infraAsOf ? `<div class="sec-banner warn">${icon('history')}<div>Viewing evidence <strong>as of ${esc(state.infraAsOf)}</strong> — the latest observations collected by that date, in list form. "Not present" means not yet observed.</div></div>` : ''}
    <div class="tabbar" role="tablist">${TABS.map(([k, label, ic]) => `<button class="tab-pill${k === tab ? ' active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}">${icon(ic)}${label}</button>`).join('')}</div>
    <div id="infra-body"><div class="hc-empty">Loading…</div></div>
    </div>`;
  $('#infra-asof').addEventListener('change', (e) => { state.infraAsOf = e.target.value || null; ctx.render(); });
  $('#infra-asof-clear')?.addEventListener('click', () => { state.infraAsOf = null; ctx.render(); });
  el.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => { state.infraTab = b.dataset.tab; state.infraCat = null; ctx.nav(); }));
  const body = $('#infra-body');
  try {
    if (state.infraAsOf || state.infraCat) { await renderHistorical(body, orgId, tab, state.infraCat); return; }
    const t = await topology(orgId);
    if (t.empty) {
      body.innerHTML = `<div class="all-clear glass-inset">${icon('infrastructure')}<div><strong>No infrastructure evidence yet</strong><div class="sub">Plan the diagnostic runbooks (diag/ad-health, diag/dns-server, diag/dhcp-scopes, diag/gpo-inventory) on a domain controller. Each plan waits for your approval.</div></div></div>`;
      return;
    }
    body.innerHTML = { directory, dns, dhcp, gpo, coverage }[tab]?.(t, orgId) ?? overview(t, orgId);
    wire(body, t, orgId);
  } catch (e) {
    body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

function wire(body, t, orgId) {
  body.querySelectorAll('[data-go-tab]').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.closest('a,[data-ent],[data-zone],[data-scope]')) return;
    state.infraTab = c.dataset.goTab; ctx.nav();
  }));
  body.querySelectorAll('[data-ent]').forEach((c) => c.addEventListener('click', (e) => { if (!e.target.closest('a')) entityDrawer(orgId, c.dataset.ent, c.dataset.entTitle); }));
  const zones = t.dns.servers.flatMap((s) => s.zones);
  body.querySelectorAll('[data-zone]').forEach((c) => c.addEventListener('click', () => { const z = zones.find((x) => x.id === c.dataset.zone); if (z) zoneDrawer(t, z, orgId); }));
  body.querySelectorAll('[data-scope]').forEach((c) => c.addEventListener('click', () => {
    const s = t.dhcp.servers.find((x) => x.id === c.dataset.server);
    const z = s?.scopes.find((x) => x.id === c.dataset.scope);
    if (z) scopeDrawer(t, z, s, orgId);
  }));
  body.querySelectorAll('[data-gpo]').forEach((c) => c.addEventListener('click', () => { const x = t.gpo.gpos.find((y) => y.id === c.dataset.gpo); if (x) gpoDrawer(t, x, orgId); }));
  const setAnd = (k, v) => { state[k] = v; ctx.render(); };
  body.querySelectorAll('[data-dns-server]').forEach((b) => b.addEventListener('click', () => setAnd('infraDnsServer', Number(b.dataset.dnsServer))));
  body.querySelectorAll('[data-dns-filter]').forEach((b) => b.addEventListener('click', () => setAnd('infraDnsFilter', b.dataset.dnsFilter)));
  body.querySelectorAll('[data-gpo-filter]').forEach((b) => b.addEventListener('click', () => setAnd('infraGpoFilter', b.dataset.gpoFilter)));
  body.querySelectorAll('[data-gpo-mode]').forEach((b) => b.addEventListener('click', () => setAnd('infraGpoMode', b.dataset.gpoMode)));
  for (const [id, key] of [['dns-q', 'infraDnsQ'], ['gpo-q', 'infraGpoQ']]) {
    let deb;
    $(`#${id}`)?.addEventListener('input', (e) => {
      const v = e.target.value;
      clearTimeout(deb);
      deb = setTimeout(() => { state[key] = v; ctx.render().then(() => { const s = $(`#${id}`); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 200);
    });
  }
  wireRefresh(body, orgId);
}
