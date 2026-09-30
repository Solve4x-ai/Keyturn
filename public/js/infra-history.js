// INFRA-1 — historical (as-of) infrastructure lists.
// Route: #/infrastructure/<orgId>/<tab> — tabs: overview | directory | dns |
// dhcp | gpo | coverage. Everything shown is evidence-backed: every row
// carries its producing operation and collection time; "not collected" is
// disclosed, never implied (plan §7/§11).
import { api, state, $, esc, ago, fmtTs, toast, ctx } from './core.js';
import { pageHeader } from './components.js';
import { icon } from './icons.js';

const TABS = [
  ['overview', 'Overview', 'overview'],
  ['directory', 'Directory', 'building'],
  ['dns', 'DNS', 'network'],
  ['dhcp', 'DHCP', 'wifi'],
  ['gpo', 'Group Policy', 'layers'],
  ['coverage', 'Coverage & Evidence', 'check'],
];

const CATEGORY_LABEL = {
  forest: 'Forest', domain: 'Domain', 'domain-controller': 'Domain controller',
  'fsmo-role': 'FSMO role', site: 'Site', 'dns-server': 'DNS server',
  'dns-zone': 'DNS zone', 'dhcp-server': 'DHCP server', 'dhcp-scope': 'DHCP scope',
  'dhcp-reservation': 'Reservation', 'dhcp-lease': 'Lease',
  'dns-record': 'DNS record',
  gpo: 'GPO', container: 'Policy container',
};

/** Overview card → owning tab. Drilling sets state.infraCat so the target
    tab renders a focused list of just that category. */
const CATEGORY_TAB = {
  forest: 'directory', domain: 'directory', 'domain-controller': 'directory',
  'fsmo-role': 'directory', site: 'directory',
  'dns-server': 'dns', 'dns-zone': 'dns', 'dns-record': 'dns',
  'dhcp-server': 'dhcp', 'dhcp-scope': 'dhcp', 'dhcp-reservation': 'dhcp', 'dhcp-lease': 'dhcp',
  gpo: 'gpo', container: 'gpo',
};

const statusBadge = (s, conflicting) => {
  if (conflicting) return '<span class="badge badge-warn">conflicting</span>';
  switch (s) {
    case 'observed': return '<span class="badge badge-ok">observed</span>';
    case 'not_observed': return '<span class="badge badge-muted">not observed</span>';
    case 'stale': return '<span class="badge badge-warn">stale</span>';
    default: return `<span class="badge badge-muted">${esc(s ?? 'unknown')}</span>`;
  }
};

const covBadge = (s) => {
  switch (s) {
    case 'complete': return '<span class="badge badge-ok">complete</span>';
    case 'partial': return '<span class="badge badge-warn">partial</span>';
    case 'failed': return '<span class="badge badge-bad">failed</span>';
    case 'unverified': return '<span class="badge badge-warn">unverified</span>';
    case 'not-applicable': return '<span class="badge badge-muted">n/a</span>';
    default: return `<span class="badge badge-muted">${esc(s)}</span>`;
  }
};

async function orgOptions(selected) {
  const { organizations } = await api('/api/v1/organizations');
  return (organizations || [])
    .map((o) => `<option value="${o.org_id}" ${Number(o.org_id) === Number(selected) ? 'selected' : ''}>${esc(o.name ?? o.display_name ?? `Org ${o.org_id}`)}</option>`)
    .join('');
}

function tabBar(orgId, active) {
  return `<div class="tabbar" role="tablist">
    ${TABS.map(([k, label, ic]) => `<button class="tab-pill${k === active ? ' active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === active}">${icon(ic)}${label}</button>`).join('')}
  </div>`;
}

function entityRow(e, expandKey) {
  const a = e.attrs || {};
  const attrPreview = Object.entries(a).slice(0, 3).map(([k, v]) => `<span class="sub">${esc(k)}=${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`).join(' · ');
  return `<tr class="clickable" data-entity="${e.id}" data-ekey="${esc(expandKey ?? '')}" tabindex="0">
    <td>${esc(e.display_name ?? e.stable_key)}</td>
    <td><span class="badge badge-muted">${esc(CATEGORY_LABEL[e.category] ?? e.category)}</span></td>
    <td>${statusBadge(e.status, e.conflicting)}</td>
    <td class="sub">${attrPreview}</td>
    <td class="sub" title="last collected">${ago(e.collected_at)}</td>
  </tr>`;
}

async function loadEntities(orgId, category, extra = '', limit = 200) {
  const at = state.infraAsOf ? `&at=${encodeURIComponent(state.infraAsOf)}` : '';
  const q = category ? `?category=${encodeURIComponent(category)}&limit=${limit}${at}${extra}` : `?limit=${limit}${at}${extra}`;
  const r = await api(`/api/v1/orgs/${orgId}/infrastructure/entities${q}`);
  // Superseded entities are history (namespace-resolved twins) — their
  // observations stay queryable via the entity drawer, but lists and counts
  // show the live identity only.
  return (r.entities || []).filter((e) => e.status !== 'superseded');
}

/** Evidence expand: observation history + producing operation link. */
async function expandEntity(el, orgId, entityId) {
  el.innerHTML = '<div class="sub">loading evidence…</div>';
  try {
    const d = await api(`/api/v1/orgs/${orgId}/infrastructure/entities/${entityId}`);
    const e = d.entity || {};
    const cur = e.current || {};
    const attrs = cur.attrs || {};
    const rows = Object.entries(attrs).map(([k, v]) => `<tr><td class="sub">${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
    const hist = (d.history || []).slice(0, 8).map((h) =>
      `<tr><td class="sub">${fmtTs(h.collected_at)}</td><td><a href="#/operation/${h.operation_id}" class="link">op ${String(h.operation_id).slice(0, 8)}</a></td><td class="sub">${esc(JSON.stringify(h.attrs).slice(0, 140))}</td></tr>`).join('');
    const rels = (d.relationships || []).slice(0, 12).map((r) => {
      const other = String(r.from_entity_id) === entityId ? `${r.to_name ?? r.to_entity_id}` : `${r.from_name ?? r.from_entity_id}`;
      return `<tr><td class="sub">${esc(r.rel_type)}</td><td>${esc(other)} <span class="badge badge-muted">${esc(String(r.from_entity_id) === entityId ? r.to_cat : r.from_cat)}</span></td><td class="sub">${r.attrs ? esc(JSON.stringify(r.attrs).slice(0, 100)) : ''}</td></tr>`;
    }).join('');
    el.innerHTML = `
      <div class="drawer-section">
        <div class="section-title">Current projection ${statusBadge(cur.status, cur.conflicting)} <span class="sub">observed ${fmtTs(cur.observedAt)} · collected ${fmtTs(cur.collectedAt)}</span></div>
        ${cur.conflict ? `<div class="error-box">Conflicting evidence: ${esc(JSON.stringify(cur.conflict).slice(0, 400))}</div>` : ''}
        <table class="data"><tbody>${rows || '<tr><td class="sub">no attributes</td></tr>'}</tbody></table>
        ${rels ? `<div class="section-title">Relationships</div><table class="data"><tbody>${rels}</tbody></table>` : ''}
        <div class="section-title">Observation history</div>
        <table class="data"><tbody>${hist || '<tr><td class="sub">no observations</td></tr>'}</tbody></table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

function wireEntityRows(el, orgId) {
  el.querySelectorAll('tr[data-entity]').forEach((tr) => {
    const go = async () => {
      const next = tr.nextElementSibling;
      if (next?.classList.contains('entity-evidence')) { next.remove(); return; }
      el.querySelectorAll('tr.entity-evidence').forEach((r) => r.remove());
      const holder = document.createElement('tr');
      holder.className = 'entity-evidence';
      holder.innerHTML = `<td colspan="6"><div class="evidence-body"></div></td>`;
      tr.after(holder);
      expandEntity(holder.querySelector('.evidence-body'), orgId, tr.dataset.entity);
    };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/**
 * Drawer rows (scope → clients, zone → records): click toggles the hidden
 * drawer row immediately after. `.ent-link` inside a drawer opens the full
 * entity evidence into the drawer's .ent-slot — two levels of drill without
 * leaving the tab.
 */
function wireDrawers(el, orgId) {
  el.querySelectorAll('tr.drawer-row').forEach((tr) => {
    const tog = () => {
      const next = tr.nextElementSibling;
      if (!next?.classList.contains('client-draw')) return;
      next.hidden = !next.hidden;
      tr.setAttribute('aria-expanded', String(!next.hidden));
    };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) tog(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tog(); });
  });
  el.querySelectorAll('.ent-link').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const slot = a.closest('.client-draw')?.querySelector('.ent-slot');
    if (slot) expandEntity(slot, orgId, a.dataset.ent);
  }));
}

/** Refresh = create a PLAN via the existing approval path — never auto-runs. */
function refreshButton(runbookId, deviceId, label) {
  const cmd = state.meta?.principal?.profile === 'command';
  if (!cmd) return `<span class="sub">refresh needs command profile</span>`;
  return `<button class="btn secondary" data-rb="${esc(runbookId)}" data-dev="${deviceId}">${esc(label ?? 'Plan refresh')}</button>`;
}

function wireRefresh(el, orgId) {
  el.querySelectorAll('button[data-rb]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        const plan = await api('/api/v1/plans', {
          method: 'POST',
          body: JSON.stringify({ operation: 'run_device_powershell', targetType: 'device', targetId: Number(b.dataset.dev), args: { runbookId: b.dataset.rb, params: {} } }),
        });
        toast(`Plan created — approve to run: ${String(plan.id).slice(0, 8)}`);
        location.hash = `#/plan/${plan.id}`;
      } catch (err) {
        toast(`plan rejected: ${err.message}`);
        b.disabled = false;
      }
    }));
}

/* ── Tabs ──────────────────────────────────────────────────────────────── */

async function tabOverview(el, orgId) {
  const [sum, cov] = await Promise.all([
    api(`/api/v1/orgs/${orgId}/infrastructure`),
    api(`/api/v1/orgs/${orgId}/infrastructure/coverage`),
  ]);
  const cats = sum.categories || {};
  const cards = Object.entries(cats).map(([cat, statuses]) => {
    const obs = statuses.observed ?? 0;
    const other = Object.entries(statuses).filter(([s]) => s !== 'observed').map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(', ');
    return `<div class="card clickable" data-cat="${esc(cat)}" role="button" tabindex="0" title="Show ${esc(CATEGORY_LABEL[cat] ?? cat)} entities"><div class="card-value">${obs}</div><div class="card-label">${esc(CATEGORY_LABEL[cat] ?? cat)}${other ? `<div class="sub">${esc(other)}</div>` : ''}</div></div>`;
  }).join('');
  const dcs = await loadEntities(orgId, 'domain-controller');
  const fsmo = await loadEntities(orgId, 'fsmo-role');
  const fsmoChips = fsmo.map((f) => {
    const holder = f.attrs?.holder ?? f.attrs?.holderFqdn ?? '—';
    return `<span class="badge badge-muted clickable" data-cat="fsmo-role" tabindex="0" title="Show FSMO role entities">${esc(f.display_name)}: ${esc(String(holder).split('.')[0])}</span>`;
  }).join(' ');
  const findings = (sum.findings || []).map((f) =>
    `<tr class="clickable" data-goto-review tabindex="0" title="Open in Review Center"><td>${esc(f.title)}</td><td class="sub">${esc(f.detail || '')}</td><td class="sub">${ago(f.created_at)}</td></tr>`).join('');
  const conflicts = (sum.conflicts || []).map((c) => `<tr><td>${esc(c.display_name)}</td><td><span class="badge badge-warn">conflicting</span></td><td class="sub">${esc((c.conflict_json || '').slice(0, 200))}</td></tr>`).join('');
  // Onboarding checklist from coverage: what's been measured vs not.
  const seen = new Set((cov.coverage || []).map((c) => `${c.runbook_id}`));
  const checklist = [
    ['diag/ad-health', 'Directory health (FSMO/DCs/replication)'],
    ['diag/dns-server', 'DNS zones & forwarders'],
    ['diag/dhcp-scopes', 'DHCP scopes & failover'],
    ['diag/gpo-inventory', 'GPO inventory & links'],
  ].map(([rb, label]) => `<tr class="clickable" data-goto-coverage tabindex="0" title="Open Coverage & Evidence"><td>${esc(label)}</td><td>${seen.has(rb) ? '<span class="badge badge-ok">collected</span>' : '<span class="badge badge-warn">not collected</span>'}</td></tr>`).join('');

  el.innerHTML = `
    <div class="section-title">Known configuration</div>
    <div class="card-grid">${cards || '<div class="sub">Nothing collected yet for this organization — see Coverage to plan first collections.</div>'}</div>
    <div class="section-title">FSMO role holders</div>
    <div>${fsmoChips || '<span class="sub">not collected</span>'}</div>
    <div class="section-title">Domain controllers</div>
    <table class="data"><tbody>${dcs.map((d) => entityRow(d)).join('') || '<tr><td class="sub">none observed</td></tr>'}</tbody></table>
    ${conflicts ? `<div class="section-title">Conflicting evidence</div><table class="data"><tbody>${conflicts}</tbody></table>` : ''}
    <div class="section-title">Findings (deterministic, evidence-linked)</div>
    <table class="data"><tbody>${findings || '<tr><td class="sub">no open findings</td></tr>'}</tbody></table>
    <div class="section-title">Onboarding checklist</div>
    <table class="data"><tbody>${checklist}</tbody></table>`;
  wireEntityRows(el, orgId);
  // Card/chip drill → owning tab + focused category list (deep-linkable ?cat=).
  el.querySelectorAll('[data-cat]').forEach((c) => {
    const go = () => {
      state.infraTab = CATEGORY_TAB[c.dataset.cat] ?? 'overview';
      state.infraCat = c.dataset.cat;
      ctx.nav();
    };
    c.addEventListener('click', go);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  el.querySelectorAll('[data-goto-review]').forEach((r) => {
    const go = () => { state.reviewOrg = orgId; state.reviewTab = 'inbox'; state.view = 'review'; ctx.nav(); };
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  el.querySelectorAll('[data-goto-coverage]').forEach((r) => {
    const go = () => { state.infraTab = 'coverage'; state.infraCat = null; ctx.nav(); };
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/** Focused category list — where overview cards land. Every row still
    expands to evidence; clear returns to the unfiltered owning tab. */
async function tabCategory(el, orgId, cat) {
  const rows = await loadEntities(orgId, cat);
  const tab = CATEGORY_TAB[cat] ?? 'overview';
  const tabLabel = TABS.find(([k]) => k === tab)?.[1] ?? tab;
  el.innerHTML = `
    <div class="toolbar">
      <span class="badge badge-accent">filtered</span>
      <strong>${esc(CATEGORY_LABEL[cat] ?? cat)}</strong>
      <span class="sub">${rows.length} entit${rows.length === 1 ? 'y' : 'ies'}</span>
      <button class="btn secondary" id="cat-clear">← all ${esc(tabLabel)}</button>
    </div>
    <table class="data"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Attributes</th><th>Collected</th></tr></thead>
    <tbody>${rows.map((e) => entityRow(e)).join('') || '<tr><td colspan="5" class="sub">none observed — not collected or not applicable</td></tr>'}</tbody></table>`;
  $('#cat-clear').addEventListener('click', () => { state.infraCat = null; ctx.nav(); });
  wireEntityRows(el, orgId);
}

async function tabDirectory(el, orgId) {
  const cats = ['forest', 'domain', 'domain-controller', 'fsmo-role', 'site'];
  const groups = await Promise.all(cats.map((c) => loadEntities(orgId, c)));
  el.innerHTML = cats.map((c, i) => `
    <details class="srv-card"${i === 0 ? ' open' : ''}>
      <summary><span class="srv-name">${CATEGORY_LABEL[c]}s</span><span class="srv-stats sub">${groups[i].length} entit${groups[i].length === 1 ? 'y' : 'ies'}</span><span class="chev">›</span></summary>
      <div class="srv-body"><table class="data"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Attributes</th><th>Collected</th></tr></thead>
      <tbody>${groups[i].map((e) => entityRow(e)).join('') || '<tr><td colspan="5" class="sub">none observed — not collected or not applicable</td></tr>'}</tbody></table></div>
    </details>`).join('');
  wireEntityRows(el, orgId);
}

async function tabDns(el, orgId) {
  const [servers, zones, records] = await Promise.all([
    loadEntities(orgId, 'dns-server'),
    loadEntities(orgId, 'dns-zone'),
    loadEntities(orgId, 'dns-record', '', 1000),
  ]);
  if (!servers.length && !zones.length) {
    el.innerHTML = '<div class="sub">No DNS evidence collected for this organization.</div>';
    return;
  }
  // Record entities live in the zone's namespace — group once, reuse per row.
  const byNs = new Map();
  for (const r of records) {
    let m = byNs.get(r.namespace);
    if (!m) byNs.set(r.namespace, (m = []));
    m.push(r);
  }
  const zoneDraw = (z) => {
    const recs = (byNs.get(z.namespace) || []).sort((x, y) => String(x.attrs?.host ?? '').localeCompare(String(y.attrs?.host ?? '')));
    const rows = recs.slice(0, 300).map((r) => {
      const a = r.attrs || {};
      return `<tr><td>${esc(a.host ?? r.display_name)}</td><td><span class="badge badge-muted">${esc(a.type ?? '')}</span></td><td class="sub">${esc(String(a.data ?? '—').slice(0, 120))}</td><td class="sub">${esc(a.ttl ?? '—')}</td><td class="sub">${a.timestamp ? esc(fmtTs(a.timestamp)) : '<span class="badge badge-muted">static</span>'}</td></tr>`;
    }).join('');
    return `<tr class="client-draw" hidden><td colspan="7">
      <div class="draw-head"><a href="#" class="link ent-link" data-ent="${z.id}">zone detail →</a><span class="sub">${recs.length} record${recs.length === 1 ? '' : 's'}${recs.length > 300 ? ' — first 300 shown' : ''}</span></div>
      <div class="ent-slot"></div>
      ${rows ? `<table class="data"><thead><tr><th>Host</th><th>Type</th><th>Data</th><th>TTL</th><th>Timestamp</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="sub">no records collected for this zone</div>'}
    </td></tr>`;
  };
  el.innerHTML = servers.map((s, si) => {
    const a = s.attrs || {};
    const sZones = zones.filter((z) => z.namespace === `dns-server:${String(s.stable_key).toLowerCase()}` || z.namespace.includes(String(s.stable_key).toLowerCase()));
    const nRec = sZones.reduce((t, z) => t + (byNs.get(z.namespace)?.length ?? 0), 0);
    return `
      <details class="srv-card"${si === 0 ? ' open' : ''}>
        <summary><span class="srv-name">${esc(s.display_name ?? s.stable_key)}</span>${statusBadge(s.status, s.conflicting)}
          <span class="srv-stats sub">${sZones.length} zone${sZones.length === 1 ? '' : 's'} · ${nRec} records · ${ago(s.collected_at)}</span><span class="chev">›</span></summary>
        <div class="srv-body">
          <div class="sub srv-meta">forwarders: ${esc((a.forwarders || []).join(', ') || '—')} · scavenging: ${esc(a.scavenging ? (a.scavenging.enabled ? `enabled (${a.scavenging.intervalHours})` : 'disabled') : 'unverified')} · module: ${a.moduleAvailable === false ? 'unavailable' : 'present'}</div>
          <table class="data"><thead><tr><th>Zone</th><th>Type</th><th>DS-integrated</th><th>Dynamic updates</th><th>Records</th><th>Status</th><th>Collected</th></tr></thead><tbody>
          ${sZones.map((z) => `<tr class="drawer-row" tabindex="0"><td>${esc(z.display_name)}</td><td class="sub">${esc(z.attrs?.zoneType ?? '')}${z.attrs?.reverse ? ' (reverse)' : ''}</td><td>${z.attrs?.dsIntegrated ? 'yes' : 'no'}</td><td class="sub">${esc(z.attrs?.dynamicUpdate ?? '—')}</td><td class="sub">${byNs.get(z.namespace)?.length ?? '—'}</td><td>${statusBadge(z.status, z.conflicting)}</td><td class="sub">${ago(z.collected_at)}</td></tr>${zoneDraw(z)}`).join('') || '<tr><td colspan="7" class="sub">no zones observed</td></tr>'}
          </tbody></table>
        </div>
      </details>`;
  }).join('') + (servers.length === 0 ? `<table class="data"><tbody>${zones.map((z) => entityRow(z)).join('')}</tbody></table>` : '');
  wireEntityRows(el, orgId);
  wireDrawers(el, orgId);
}

const authBadge = (a) => {
  if (a?.authorizedInAd === true) return '<span class="badge badge-ok">authorized in AD</span>';
  if (a?.authorizedInAd === false) return '<span class="badge badge-bad">NOT authorized in AD</span>';
  return '<span class="badge badge-muted">authorization unverified</span>';
};

async function tabDhcp(el, orgId) {
  const [servers, scopes, reservations, leases] = await Promise.all([
    loadEntities(orgId, 'dhcp-server'),
    loadEntities(orgId, 'dhcp-scope'),
    loadEntities(orgId, 'dhcp-reservation'),
    loadEntities(orgId, 'dhcp-lease', '', 1000),
  ]);
  // AD-authorization entries are directory name→IP records, not servers
  // that serve scopes — render them as a record strip, never as empty
  // server sections (the 'DC04' auth record vs the live DC04 card).
  const live = servers.filter((s) => s.attrs?.observedVia !== 'ad-authorization-list');
  const authOnly = servers.filter((s) => s.attrs?.observedVia === 'ad-authorization-list');
  if (!live.length && !scopes.length && !leases.length) {
    el.innerHTML = '<div class="sub">No DHCP evidence collected for this organization.</div>';
    return;
  }

  // Merge reservation + lease rows per IP — the lease table mirrors
  // reservations as ActiveReservation/InactiveReservation; two rows for
  // one address reads as duplication. One row per IP: Kind shows what
  // the address IS, State shows its live lease-table state.
  const sidOf = (e) => String(e.attrs?.scopeId ?? String(e.namespace || '').replace(/^dhcp-scope:/, '')).toLowerCase();
  const isResv = (c) => c.kinds.has('Reservation') || c.kinds.has('Reservation lease');
  const clientRow = (c) => {
    // A reservation + its reservation-backed lease mirror = one
    // reservation. 'Reservation + lease' only when a *dynamic* lease
    // also claims the address (unusual — worth seeing distinctly).
    const kind = c.kinds.has('Reservation') && c.kinds.has('Lease') ? 'Reservation + lease'
      : isResv(c) ? 'Reservation' : 'Lease';
    const st = c.states.length ? c.states.join(', ') : (kind === 'Reservation' ? 'configured' : '—');
    const stBadge = /inactive|expired|declined/i.test(st) ? 'badge-warn' : /active|configured/i.test(st) ? 'badge-ok' : 'badge-muted';
    const worst = c.entities.find((x) => x.status !== 'observed') ?? c.entities[0];
    return `<tr class="clickable" data-entity="${worst.id}" tabindex="0"><td>${esc(c.ip)}</td><td>${esc(c.name ?? '—')}</td><td class="sub">${esc(c.mac ?? '—')}</td><td><span class="badge ${kind === 'Lease' ? 'badge-muted' : 'badge-ok'}">${kind}</span></td><td><span class="badge ${stBadge}">${esc(st)}</span></td><td>${statusBadge(worst.status, worst.conflicting)}</td><td class="sub">${ago(c.collected)}</td></tr>`;
  };
  const clientTable = (clients) => clients.length
    ? `<table class="data"><thead><tr><th>IP</th><th>Name</th><th>MAC</th><th>Kind</th><th>Lease state</th><th>Status</th><th>Collected</th></tr></thead><tbody>${clients.map(clientRow).join('')}</tbody></table>`
    : '<div class="sub">no clients observed in this scope</div>';

  const serverCard = (s, open) => {
    // Scope + client entities carry no server qualifier in their lease
    // namespace — join on source_device_id so two servers sharing a
    // subnet never claim each other's clients.
    const dev = s.source_device_id;
    const sScopes = scopes.filter((z) => z.source_device_id === dev);
    const perScope = new Map(); // scopeId(lower) -> Map(ip -> merged client)
    const put = (e, kind) => {
      const sid = sidOf(e);
      if (!sid) return;
      let m = perScope.get(sid);
      if (!m) perScope.set(sid, (m = new Map()));
      const ip = String(e.attrs?.ip ?? e.stable_key);
      const c = m.get(ip) ?? { ip, name: null, mac: null, kinds: new Set(), states: [], entities: [], collected: 0 };
      c.kinds.add(kind);
      c.name = c.name ?? e.attrs?.hostName ?? e.attrs?.name;
      c.mac = c.mac ?? e.attrs?.clientId;
      if (e.attrs?.state) c.states.push(String(e.attrs.state));
      c.entities.push(e);
      c.collected = Math.max(c.collected, e.collected_at ?? 0);
      m.set(ip, c);
    };
    for (const r of reservations) if (r.source_device_id === dev) put(r, 'Reservation');
    for (const l of leases) if (l.source_device_id === dev) put(l, l.attrs?.isReservation ? 'Reservation lease' : 'Lease');
    let totRes = 0, totLease = 0;
    for (const m of perScope.values()) for (const c of m.values()) isResv(c) ? totRes++ : totLease++;

    const scopeIds = new Set(sScopes.map((z) => String(z.attrs?.scopeId ?? z.stable_key).toLowerCase()));
    const scopeRows = sScopes.map((z) => {
      const a = z.attrs || {};
      const sid = String(a.scopeId ?? z.stable_key).toLowerCase();
      const opts = a.options ? Object.entries(a.options).map(([k, v]) => `${k}=${(v || []).join('/')}`).join(' ') : '—';
      const clients = [...(perScope.get(sid)?.values() ?? [])].sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true }));
      const resv = clients.filter(isResv).length;
      return `<tr class="drawer-row" tabindex="0"><td>${esc(a.name ?? a.scopeId ?? z.display_name)}</td><td class="sub">${esc(a.start ?? '')}–${esc(a.end ?? '')}</td><td>${esc(a.state ?? '')}${a.state === 'Active' && s.attrs?.authorizedInAd === false ? ' <span class="badge badge-warn" title="server not authorized — configured state, cannot serve">config only</span>' : ''}</td><td class="sub">${resv}</td><td class="sub">${clients.length - resv}</td><td class="sub">${a.free ?? '?'}</td><td class="sub" title="${esc(opts)}">${esc(opts.slice(0, 60))}${opts.length > 60 ? '…' : ''}</td><td>${statusBadge(z.status, z.conflicting)}</td><td class="sub">${ago(z.collected_at)}</td></tr>`
        + `<tr class="client-draw" hidden><td colspan="9"><div class="draw-head"><a href="#" class="link ent-link" data-ent="${z.id}">scope detail →</a><span class="sub">${clients.length} client${clients.length === 1 ? '' : 's'} — one row per address</span></div><div class="ent-slot"></div>${clientTable(clients)}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="sub">no scopes observed</td></tr>';

    const orphans = [...perScope.entries()].filter(([sid]) => !scopeIds.has(sid)).flatMap(([, m]) => [...m.values()]);
    const authNote = s.attrs?.authorizedInAd === false
      ? '<div class="sub" style="color:var(--warn,#c99)">Not authorized in AD — an unauthorized server cannot issue leases; scope state is configuration, not live service.</div>'
      : '';
    return `<details class="srv-card"${open ? ' open' : ''}>
      <summary><span class="srv-name">${esc(s.display_name ?? s.stable_key)}</span>${statusBadge(s.status, s.conflicting)}${authBadge(s.attrs)}
        <span class="srv-stats sub">${sScopes.length} scope${sScopes.length === 1 ? '' : 's'} · ${totRes} reserved · ${totLease} leases · ${ago(s.collected_at)}</span><span class="chev">›</span></summary>
      <div class="srv-body">${authNote}
        <table class="data"><thead><tr><th>Scope</th><th>Range</th><th>State</th><th>Reserved</th><th>Leased</th><th>Free</th><th>Options</th><th>Status</th><th>Collected</th></tr></thead><tbody>${scopeRows}</tbody></table>
        ${orphans.length ? `<div class="sub" style="margin:8px 0 4px">Clients outside observed scopes:</div>${clientTable(orphans.sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true })))}` : ''}
      </div>
    </details>`;
  };

  const orphanScopes = scopes.filter((z) => !live.some((s) => s.source_device_id === z.source_device_id));
  el.innerHTML = live.sort((x, y) => String(x.display_name).localeCompare(String(y.display_name))).map((s, i) => serverCard(s, i === 0)).join('')
    + (orphanScopes.length ? `<details class="srv-card"><summary><span class="srv-name">Scopes without a collected server</span><span class="srv-stats sub">${orphanScopes.length}</span><span class="chev">›</span></summary><div class="srv-body"><table class="data"><tbody>${orphanScopes.map((z) => entityRow(z)).join('')}</tbody></table></div></details>` : '')
    + (authOnly.length ? `<details class="srv-card"><summary><span class="srv-name">AD authorization records</span><span class="srv-stats sub">${authOnly.length} directory record${authOnly.length === 1 ? '' : 's'} — registered names, not observed servers</span><span class="chev">›</span></summary>
      <div class="srv-body"><table class="data"><thead><tr><th>Registered name</th><th>Registered IP</th><th>Status</th><th>Collected</th></tr></thead><tbody>
      ${authOnly.map((a) => `<tr class="clickable" data-entity="${a.id}" tabindex="0"><td>${esc(a.display_name)}</td><td class="sub">${esc(a.attrs?.reportedIp ?? '—')}</td><td>${statusBadge(a.status, a.conflicting)}</td><td class="sub">${ago(a.collected_at)}</td></tr>`).join('')}
      </tbody></table></div></details>` : '');
  wireEntityRows(el, orgId);
  wireDrawers(el, orgId);
}

async function tabGpo(el, orgId) {
  const [gpos, cov] = await Promise.all([
    loadEntities(orgId, 'gpo', '&linkCounts=1'),
    api(`/api/v1/orgs/${orgId}/infrastructure/coverage`),
  ]);
  // links coverage complete = "unlinked" is honest; otherwise "not collected".
  const linksComplete = (cov.coverage || []).some((c) => c.section === 'links' && c.status === 'complete');
  const linkCell = (g) => {
    const n = g.link_count;
    if (n != null && n > 0) return `<span title="linked to ${n} container(s) — targets in entity detail">${n}</span>`;
    if (linksComplete) return `<span class="badge badge-warn" title="no link targets in the latest complete collection — enabled but unlinked applies nowhere">unlinked</span>`;
    return '<span class="sub" title="link targets not collected (links coverage incomplete)">—</span>';
  };
  // Enabled = the GPO's own switch (gpoStatus flags), rendered as plain
  // words — whether it actually applies is a separate question (Linked col).
  const enabledCell = (g) => {
    const v = Number(g.attrs?.gpoStatus);
    // Microsoft.GroupPolicy.GpoStatus ordinals (3 = AllSettingsEnabled).
    const map = {
      3: ['badge-ok', 'Enabled', 'Both Computer and User settings are on — applies only where linked'],
      1: ['badge-warn', 'User side off', 'User Configuration disabled; Computer settings still process'],
      2: ['badge-warn', 'Computer side off', 'Computer Configuration disabled; User settings still process'],
      0: ['badge-muted', 'Disabled', 'Both halves off — the GPO is inert wherever it is linked'],
    }[v];
    if (!map) return `<span class="badge badge-muted">${esc(g.attrs?.statusLabel ?? g.attrs?.gpoStatus ?? 'unknown')}</span>`;
    return `<span class="badge ${map[0]}" title="${esc(map[2])}">${map[1]}</span>`;
  };
  const q = (state.infraGpoQ || '').toLowerCase();
  const shown = q ? gpos.filter((g) => String(g.display_name ?? '').toLowerCase().includes(q) || g.stable_key.includes(q)) : gpos;
  el.innerHTML = `
    <div class="toolbar"><input type="text" id="gpo-q" placeholder="filter GPOs…" value="${esc(state.infraGpoQ || '')}" style="width:260px" /><span class="sub">${shown.length} of ${gpos.length}</span></div>
    <div class="sub"><b>Enabled</b> = the GPO's own switch — "on" only means <i>allowed</i> to apply where linked. <b>Linked</b> = link targets in the latest collection. Enabled + unlinked = applies nowhere (cleanup candidate). Actual application (filtering, precedence) is never inferred (plan §7).</div>
    <table class="data"><thead><tr><th>GPO</th><th>Enabled</th><th>Linked</th><th>Projection</th><th>Modified</th><th>Collected</th></tr></thead><tbody>
    ${shown.map((g) => `<tr class="clickable" data-entity="${g.id}" tabindex="0"><td>${esc(g.display_name ?? g.stable_key)}</td><td>${enabledCell(g)}</td><td>${linkCell(g)}</td><td>${statusBadge(g.status, g.conflicting)}</td><td class="sub">${fmtTs(g.attrs?.modified)}</td><td class="sub">${ago(g.collected_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="sub">none observed</td></tr>'}
    </tbody></table>`;
  $('#gpo-q')?.addEventListener('input', (e) => { state.infraGpoQ = e.target.value; const t = e.target; clearTimeout(state._gpoDeb); state._gpoDeb = setTimeout(() => { ctx.render().then(() => $('#gpo-q')?.focus()); }, 400); });
  wireEntityRows(el, orgId);
}

async function tabCoverage(el, orgId) {
  const cov = await api(`/api/v1/orgs/${orgId}/infrastructure/coverage`);
  const rows = (cov.coverage || []).map((c) => `<tr>
    <td>${esc(c.source_name ?? c.source_device_id)}</td>
    <td><span class="badge badge-muted">${esc(c.runbook_id ?? '')} v${c.runbook_version ?? '?'}</span></td>
    <td>${esc(c.section)}</td>
    <td>${covBadge(c.status)}</td>
    <td class="sub">${c.enumerated_count ?? '—'}${c.truncated ? ' (truncated)' : ''}</td>
    <td class="sub" title="${esc(c.note ?? '')}">${esc((c.note ?? '').slice(0, 80))}${(c.note ?? '').length > 80 ? '…' : ''}</td>
    <td class="sub">${fmtTs(c.collected_at)}</td>
    <td>${refreshButton(c.runbook_id, c.source_device_id, 'Plan refresh')}</td>
  </tr>`).join('');
  const ing = Object.entries(cov.ingestion || {}).map(([s, n]) => `<span class="badge ${s === 'error' ? 'badge-bad' : s === 'pending' ? 'badge-warn' : 'badge-ok'}">${esc(s)}: ${n}</span>`).join(' ');
  el.innerHTML = `
    <div class="section-title">Ingestion</div><div>${ing || '<span class="sub">no jobs</span>'}</div>
    <div class="section-title">Collection coverage</div>
    <div class="sub">"Failed"/"unverified" sections create no absence claims — only complete enumerations establish "not observed".</div>
    <table class="data"><thead><tr><th>Source</th><th>Runbook</th><th>Section</th><th>Status</th><th>Count</th><th>Note</th><th>Collected</th><th></th></tr></thead><tbody>
    ${rows || '<tr><td colspan="8" class="sub">nothing collected yet — plan a diagnostic runbook on an authorized target</td></tr>'}
    </tbody></table>`;
  wireRefresh(el, orgId);
}

/* ── Historical (as-of) rendering — the latest evidence collected by a date.
   Used by infrastructure.js only while an as-of date is selected; the live
   view draws from the topology endpoint instead. */
export async function renderHistorical(body, orgId, tab, cat) {
  if (cat) return tabCategory(body, orgId, cat);
  switch (tab) {
    case 'directory': return tabDirectory(body, orgId);
    case 'dns': return tabDns(body, orgId);
    case 'dhcp': return tabDhcp(body, orgId);
    case 'gpo': return tabGpo(body, orgId);
    case 'coverage': return tabCoverage(body, orgId);
    default: return tabOverview(body, orgId);
  }
}
export { expandEntity, refreshButton, wireRefresh };
