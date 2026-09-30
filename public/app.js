// Keyturn — vanilla ES modules, no build step (M4.6).
// Feature modules live in /assets/js/: core (api/state/utils), components
// (shared render vocabulary), device-drawer, device-page, gallery.
// Data routes require a bearer token: pass ?token=… once (saved to
// localStorage) or enter it when prompted.

import { api, state, $, esc, ago, fmtTs, fmtBool, toast, ctx, streamInvalidations } from './js/core.js';
import { appearanceMenu, wireAppearanceMenu, getAppearance, setAppearance } from './theme.js';
import { icon } from './js/icons.js';
import { pageHeader, statCard } from './js/components.js';
import { openDeviceDrawer, openOrgDrawer, openEntityDrawer, closeDrawer } from './js/device-drawer.js';
import { deviceView } from './js/device-page.js';
import { galleryView } from './js/gallery.js';
import { approvalsView, planView, operationView } from './js/operations.js';
import { operationsListView, runbooksView } from './js/library.js';
import { infrastructureView } from './js/infrastructure.js';
import { reviewView } from './js/review.js';
import { reportsView } from './js/reports.js';
import { hudView, leaveHud, attentionItem } from './js/hud.js';
import { analyticsView } from './js/analytics.js';
import { initPalette } from './js/palette.js';
import { securityView } from './js/security.js';
import { settingsView } from './js/settings.js';
import { initScope, adoptUrlOrg, updateOrgs, scopeOrg, setScope } from './js/scope.js';

const setScopeQuiet = (v) => setScope(v, { render: false });
import { organizationsView, orgPageView } from './js/orgs.js';

// ── Chrome ──────────────────────────────────────────────────────────────
async function loadMeta() {
  const appBadge = $('#app-status');
  try {
    const h = await api('/health');
    state.meta = h;
    appBadge.textContent = 'app connected';
    appBadge.className = 'badge badge-ok';
    appBadge.hidden = true;
    $('#connection-label').textContent = h.demo ? 'demo data' : h.cache?.tenant || (h.connectionId ? `conn ${h.connectionId.slice(0, 8)}` : 'no connection');
    const badge = $('#profile-badge');
    badge.textContent = h.principal?.profile || 'unknown';
    badge.className = 'badge ' + (h.principal?.profile === 'reporting' ? 'badge-ok' : 'badge-warn');
    // Data freshness is independent of app connectivity and endpoint status.
    const syncs = (h.syncState || []).filter((s) => s.lastSyncAt);
    const oldest = syncs.length ? Math.min(...syncs.map((s) => s.lastSyncAt)) : null;
    $('#freshness').innerHTML = oldest
      ? `data <span class="badge ${Date.now() - oldest > 3600_000 ? 'badge-warn' : 'badge-ok'}">${ago(oldest)}</span>`
      : `<span class="badge badge-warn">data never synced</span>`;
  } catch (e) {
    appBadge.textContent = 'app unreachable';
    appBadge.className = 'badge badge-bad';
    appBadge.hidden = false;
    $('#connection-label').textContent = 'auth failed';
    $('#view').innerHTML = `<div class="error-box">Could not reach the local server: ${esc(e.message)}</div>`;
  }
}

// ── Shell icons + shared org selector ───────────────────────────────────
document.querySelectorAll('.nav-item[data-icon]').forEach((b) =>
  b.insertAdjacentHTML('afterbegin', `<span class="nav-ic">${icon(b.dataset.icon)}</span>`));
$('#appearance-btn').innerHTML = icon('settings');
$('#attention-ic').innerHTML = icon('bell');
$('#palette-ic').innerHTML = icon('search');
$('#palette-search-ic').innerHTML = icon('search');

// Sidebar collapse — persisted with the other appearance prefs.
const syncSidebarToggle = () => {
  const collapsed = getAppearance().sidebar === 'collapsed';
  const t = $('#sidebar-toggle');
  t.innerHTML = icon(collapsed ? 'sidebar-r' : 'sidebar-l');
  t.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  t.setAttribute('aria-label', t.title);
  t.setAttribute('aria-expanded', String(!collapsed));
};
syncSidebarToggle();
$('#sidebar-toggle').addEventListener('sync', syncSidebarToggle);
$('#sidebar-toggle').addEventListener('click', () => {
  setAppearance({ sidebar: getAppearance().sidebar === 'collapsed' ? 'expanded' : 'collapsed' });
  syncSidebarToggle();
});

// Attention popover — the same ranked queue the Overview shows, from the
// shell's HUD poll. Every entry links to a real page; nothing is fabricated.
let lastHud = null;
function renderAttention() {
  const pop = $('#attention-pop');
  const items = lastHud?.attention ?? [];
  pop.innerHTML = `
    <div class="ap-head"><span class="ap-title">Needs attention</span><a class="hc-link" href="#/hud">Overview ${icon('arrow-ur')}</a></div>
    ${items.length ? `<div class="ap-list">${items.slice(0, 10).map(attentionItem).join('')}</div>`
      : `<div class="ap-empty">${lastHud ? 'All clear — nothing needs you right now.' : 'Loading…'}</div>`}`;
}
$('#attention-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#attention-pop');
  if (pop.hidden) { renderAttention(); pop.hidden = false; } else pop.hidden = true;
});
document.addEventListener('click', (e) => {
  const pop = $('#attention-pop');
  if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
  if (e.target.closest?.('#attention-pop a')) pop.hidden = true;
});

/* Organization scope lives in js/scope.js (top-bar "All orgs | org" switch).
   Older views call ctx.syncOrg when their URL names an org. */
ctx.syncOrg = adoptUrlOrg;

// Appearance popover — theme/accent/density, persisted under n1_appearance.
$('#appearance-btn').addEventListener('click', () => {
  const pop = $('#appearance-pop');
  if (pop.hidden) {
    pop.innerHTML = appearanceMenu();
    wireAppearanceMenu(pop);
    pop.hidden = false;
    pop.querySelector('.seg-btn')?.focus();
  } else {
    pop.hidden = true;
  }
});
document.addEventListener('click', (e) => {
  const pop = $('#appearance-pop');
  if (!pop.hidden && !pop.contains(e.target) && e.target !== $('#appearance-btn') && !$('#appearance-btn').contains(e.target)) pop.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#appearance-pop').hidden) { $('#appearance-pop').hidden = true; $('#appearance-btn').focus(); }
  if (e.key === 'Escape' && !$('#attention-pop').hidden) { $('#attention-pop').hidden = true; $('#attention-btn').focus(); }
});

// ── Views ───────────────────────────────────────────────────────────────
const views = {
  async overview(el) {
    const o = await api('/api/v1/overview');
    el.innerHTML = `
      ${pageHeader({ icon: 'overview', title: 'Overview', sub: 'Local inventory and collection state for the connected tenant' })}
      <div class="card-grid">
        <div class="card clickable" data-goto="devices"><div class="card-value">${o.devices ?? 0}</div><div class="card-label">Devices (local)</div></div>
        <div class="card clickable" data-goto="offline"><div class="card-value">${o.offlineDevices ?? 0}</div><div class="card-label">Offline</div></div>
        <div class="card clickable" data-goto="organizations"><div class="card-value">${o.organizations ?? 0}</div><div class="card-label">Organizations</div></div>
        <div class="card clickable" data-goto="changes"><div class="card-value">${o.changesLast24h ?? 0}</div><div class="card-label">Changes · 24h</div></div>
        <div class="card clickable" data-goto="activity"><div class="card-value">${o.journal ?? 0}</div><div class="card-label">Journal entries</div></div>
      </div>
      <div class="section-title">Sync coverage</div>
      <table class="data"><thead><tr><th>Entity</th><th>Last sync</th><th>Items</th></tr></thead><tbody>
      ${(o.syncState || []).map((s) => `<tr class="clickable" tabindex="0" data-type="${esc(s.entityType)}"><td>${esc(s.entityType)}</td><td>${s.lastSyncAt ? ago(s.lastSyncAt) : '<span class="badge badge-warn">never</span>'}</td><td>${s.itemCount}</td></tr>`).join('')}
      </tbody></table>
      <div class="section-title">Collection</div>
      <div class="toolbar">
        <button class="btn" id="refresh-now">Refresh now</button>
        <button class="btn secondary" id="sched-toggle">Schedules…</button>
        <span id="refresh-status" class="sub"></span>
      </div>
      <div id="sched-panel" hidden>
        <div id="sched-list"></div>
        <div class="section-title" style="margin-top:10px">New daily schedule</div>
        <div class="toolbar">
          <input type="text" id="sched-name" placeholder="Name" />
          <input type="number" id="sched-org" placeholder="Org ID (blank = explicit devices)" style="width:170px" />
          <select id="sched-profile"><option value="standard">standard</option><option value="quick">quick</option><option value="full">full</option></select>
          <input type="text" id="sched-window" value="02:00" style="width:70px" title="Local window hour, HH:MM" />
          <input type="text" id="sched-tz" value="UTC" style="width:110px" title="IANA timezone" />
          <button class="btn" id="sched-create">Create</button>
        </div>
        <div class="sub">Daily read-only collection; deterministic per-date slots. Runs while this server process is up.</div>
      </div>`;
    el.querySelectorAll('.card[data-goto]').forEach((card) =>
      card.addEventListener('click', () => {
        const dest = card.dataset.goto;
        if (dest === 'offline') { state.view = 'devices'; state.offline = true; }
        else { state.view = dest; state.offline = null; }
        state.orgId = null; state.q = ''; state.page = 1; state.changesType = null;
        nav();
      }));
    el.querySelectorAll('tr[data-type]').forEach((tr) => {
      const go = () => {
        const t = tr.dataset.type;
        state.view = t === 'devices' ? 'devices' : t === 'organizations' ? 'organizations' : 'changes';
        state.changesType = state.view === 'changes' ? (t === 'policies' ? 'policy' : t === 'locations' ? 'location' : null) : null;
        state.offline = null; state.orgId = null; state.q = ''; state.page = 1;
        nav();
      };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });

    // Refresh = entity sync through the same guarded tool path the MCP client
    // uses — a cache read-refresh, never an upstream write.
    $('#refresh-now').addEventListener('click', async () => {
      const status = $('#refresh-status');
      status.textContent = 'syncing…';
      try {
        const r = await api('/tools/sync_entities', { method: 'POST', body: '{}' });
        const text = JSON.parse(r.content?.[0]?.text ?? '{}');
        status.textContent = text.reports ? `synced — ${text.reports.length} entity type(s)` : 'sync done';
        loadMeta();
        render();
      } catch (e) {
        status.textContent = `sync failed: ${e.message}`;
      }
    });

    const renderSchedules = async () => {
      const { schedules } = await api('/api/v1/schedules');
      $('#sched-list').innerHTML = schedules.length
        ? `<table class="data"><thead><tr><th>Name</th><th>Scope</th><th>Window</th><th>Profile</th><th>Last slot</th><th></th></tr></thead><tbody>
          ${schedules.map((s) => `<tr>
            <td>${esc(s.name)}</td>
            <td class="sub">${esc(s.scope.orgId != null ? `org ${s.scope.orgId}` : `${(s.scope.deviceIds || []).length} device(s)`)}</td>
            <td class="sub">${esc(s.window_hhmm)} ${esc(s.timezone)}</td>
            <td class="sub">${esc(s.profile)}</td>
            <td class="sub">${esc(s.last_slot ?? '—')}</td>
            <td><button class="btn secondary" data-sched="${s.id}" data-enabled="${s.enabled ? 0 : 1}">${s.enabled ? 'Disable' : 'Enable'}</button></td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="empty">No schedules — create one below</div>';
      $('#sched-list').querySelectorAll('[data-sched]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/v1/schedules/${btn.dataset.sched}`, {
            method: 'PUT', body: JSON.stringify({ enabled: btn.dataset.enabled === '1' }),
          });
          renderSchedules();
        });
      });
    };
    $('#sched-toggle').addEventListener('click', () => {
      const panel = $('#sched-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderSchedules();
    });
    $('#sched-create').addEventListener('click', async () => {
      const name = $('#sched-name').value.trim();
      if (!name) return toast('Schedule needs a name');
      const orgVal = $('#sched-org').value.trim();
      const body = {
        name,
        orgId: orgVal ? Number(orgVal) : undefined,
        deviceIds: orgVal ? undefined : [Number(state.lastDeviceId ?? 0)].filter(Boolean),
        profile: $('#sched-profile').value,
        windowHhmm: $('#sched-window').value || '02:00',
        timezone: $('#sched-tz').value || 'UTC',
      };
      const r = await api('/api/v1/schedules', { method: 'POST', body: JSON.stringify(body) });
      if (r.error) return toast(r.error);
      toast('Schedule created');
      renderSchedules();
    });
  },

  organizations: organizationsView,
  org: orgPageView,

  async changes(el) {
    const typeParam = state.changesType ? `&entityType=${encodeURIComponent(state.changesType)}` : '';
    const data = await api(`/api/v1/changes?limit=200${typeParam}`);
    const rows = data.changes.filter((c) => c.field !== 'last_contact');
    const ticks = data.changes.length - rows.length;
    el.innerHTML = `
      ${state.changesType ? `<div class="toolbar"><span class="badge badge-accent">type: ${esc(state.changesType)}</span><button class="btn secondary" id="clear-type">Clear filter</button></div>` : ''}
      ${pageHeader({ icon: 'activity', title: 'Changes', sub: 'Observed field-level diffs between retained entity snapshots' })}
      ${ticks ? `<div class="sub" style="margin-bottom:8px">${ticks} last_contact tick(s) suppressed</div>` : ''}
      <table class="data"><thead><tr><th>Entity</th><th>Field</th><th>Change</th><th>When</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="clickable" tabindex="0" data-type="${esc(c.entity_type)}" data-id="${c.entity_id}">
        <td>${esc(c.entity_label || `${c.entity_type} ${c.entity_id}`)}${c.org_name ? ` <span class="sub">· ${esc(c.org_name)}</span>` : ''}</td>
        <td>${esc(c.field)}</td><td>${esc(`${c.old_value ?? '∅'} → ${c.new_value ?? '∅'}`)}</td><td class="sub">${fmtTs(c.detected_at)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No changes recorded</td></tr>'}
      </tbody></table>`;
    $('#clear-type')?.addEventListener('click', () => { state.changesType = null; render(); });
    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      const go = () => openEntityDrawer(tr.dataset.type, Number(tr.dataset.id));
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  },

  async devices(el) {
    const orgParam = state.orgId ? `&orgId=${state.orgId}` : '';
    const offParam = state.offline !== null ? `&offline=${state.offline ? 1 : 0}` : '';
    const kindParam = state.kind ? `&kind=${state.kind}` : '';
    const [data, hud] = await Promise.all([
      api(`/api/v1/devices?page=${state.page}&pageSize=50&q=${encodeURIComponent(state.q)}${orgParam}${offParam}${kindParam}&sort=${state.sort}&dir=${state.dir}`),
      api(`/api/v1/hud${state.orgId ? `?orgId=${state.orgId}` : ''}`).catch(() => null),
    ]);
    const pages = Math.max(Math.ceil(data.total / data.pageSize), 1);
    const th = (key, label) => {
      const arrow = state.sort === key ? icon(state.dir === 'asc' ? 'chev-u' : 'chev-d', 'sort-ic') : '';
      return `<th class="th-sort" data-sort="${key}" tabindex="0">${label}${arrow}</th>`;
    };
    const seg = (name, cur, opts) => `<div class="seg" role="radiogroup" aria-label="${name}">${opts.map(([v, l]) => `<button class="seg-btn" role="radio" data-${name}="${v}" aria-checked="${String(cur ?? '') === v}">${l}</button>`).join('')}</div>`;
    const status = state.offline === null ? '' : state.offline ? 'offline' : 'online';
    const f = hud?.fleet;
    // Age is judged against the last inventory sync, not the wall clock —
    // otherwise a stale sync paints every healthy device red.
    const ref = hud?.freshness?.deviceSyncAt ?? Date.now();
    const ageClass = (lc) => { const ms = Number(lc) > 1e12 ? Number(lc) : Number(lc) * 1000; const d = (ref - ms) / 86_400_000; return d > 7 ? 'age-old' : d > 1 ? 'age-warn' : ''; };
    const kindLabel = (c) => (String(c ?? '').includes('SERVER') ? 'Server' : String(c ?? '').includes('WORKSTATION') ? 'Workstation' : String(c ?? '—').replace(/_/g, ' ').toLowerCase());
    el.innerHTML = `
      <div data-view-root="devices">
      ${pageHeader({ icon: 'devices', title: 'Devices', sub: 'Every endpoint the NinjaOne agent reports. Status is as of the last inventory sync — click a row for the live inspector.' })}
      ${f ? `<div class="stat-row">
        ${statCard({ icon: 'devices', tone: 'accent', value: f.total, label: 'Endpoints', sub: state.orgId ? 'in this organization' : 'all organizations' })}
        ${statCard({ icon: 'pulse', tone: 'ok', value: `${f.online}`, label: 'Online', sub: `${Math.round((f.online / Math.max(f.total, 1)) * 100)}% of fleet`, go: true, data: 'online', active: status === 'online' })}
        ${statCard({ icon: 'warn', tone: f.offline ? 'bad' : 'muted', value: f.offline, label: 'Offline', sub: f.offlineAging.gt7d ? `${f.offlineAging.gt7d} for 7+ days` : 'recently seen', go: true, data: 'offline', active: status === 'offline' })}
        ${statCard({ icon: 'server', tone: 'obs', value: `${f.servers.online}/${f.servers.total}`, label: 'Servers up', go: true, data: 'server', active: state.kind === 'server' })}
      </div>` : ''}
      <div class="panel">
        <div class="panel-head">
          <div class="filterbar">
            <input type="search" id="q" class="fi-search" placeholder="Search name, display name, DNS…" value="${esc(state.q)}" />
            ${seg('kind', state.kind, [['', 'All'], ['server', 'Servers'], ['workstation', 'Workstations']])}
            ${seg('status', status, [['', 'Any'], ['online', 'Online'], ['offline', 'Offline']])}
            ${state.orgId ? `<span class="badge badge-accent">${icon('building')} ${esc(data.rows[0]?.org_name ?? `org ${state.orgId}`)}</span>` : ''}
            ${state.q || state.kind || status || state.orgId ? '<button class="btn-mini" id="clear-filters">Clear</button>' : ''}
          </div>
          <span class="sub">${data.total} match${data.total === 1 ? '' : 'es'}</span>
        </div>
        <table class="data dev-table"><thead><tr>
          ${th('status', 'Status')}${th('name', 'System name')}${th('display', 'Display name')}${th('org', 'Organization')}${th('last_contact', 'Last contact')}${th('class', 'Type')}
        </tr></thead><tbody>
        ${data.rows.map((r) => `<tr tabindex="0" data-id="${r.device_id}">
          <td><span class="badge ${r.offline ? 'badge-bad' : 'badge-ok'}"><span class="dot${r.offline ? '' : ' live'}"></span>${r.offline ? 'offline' : 'online'}</span></td>
          <td><span class="dev-name">${icon(String(r.node_class ?? '').includes('SERVER') ? 'server' : 'devices')}<span class="mono-val">${esc(r.system_name)}</span></span></td>
          <td>${esc(r.display_name ?? '')}</td>
          <td class="sub">${esc(r.org_name ?? r.org_id ?? '—')}</td>
          <td class="sub ${ageClass(r.last_contact)}" title="${esc(fmtTs(r.last_contact))}">${ago(r.last_contact)}</td>
          <td class="sub">${esc(kindLabel(r.node_class))}</td>
        </tr>`).join('') || `<tr><td colspan="6" class="empty">${state.q || state.kind || status ? 'No devices match these filters.' : 'No devices — sync the inventory from Overview.'}</td></tr>`}
        </tbody></table>
      </div>
      <div class="pager">
        <button id="prev" ${state.page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span>Page ${data.page} / ${pages}</span>
        <button id="next" ${state.page >= pages ? 'disabled' : ''}>Next →</button>
      </div>
      </div>`;
    let debounce;
    $('#q').addEventListener('input', (e) => {
      const v = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.q = v; state.page = 1; render().then(() => { const s = $('#q'); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 300);
    });
    $('#clear-filters')?.addEventListener('click', () => { state.offline = null; state.kind = null; state.q = ''; state.page = 1; if (scopeOrg() != null) setScope(null); else render(); });
    el.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.kind = b.dataset.kind || null; state.page = 1; render(); }));
    el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { const v = b.dataset.status; state.offline = v === '' ? null : v === 'offline'; state.page = 1; render(); }));
    el.querySelectorAll('.stat-card[data-go]').forEach((c) => c.addEventListener('click', () => {
      const g = c.dataset.go;
      if (g === 'server') state.kind = state.kind === 'server' ? null : 'server';
      else state.offline = status === g ? null : g === 'offline';
      state.page = 1; render();
    }));
    el.querySelectorAll('th.th-sort').forEach((header) => {
      const sortBy = () => {
        if (state.sort === header.dataset.sort) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = header.dataset.sort; state.dir = 'asc'; }
        state.page = 1;
        render();
      };
      header.addEventListener('click', sortBy);
      header.addEventListener('keydown', (e) => { if (e.key === 'Enter') sortBy(); });
    });
    $('#prev').addEventListener('click', () => { state.page--; render(); });
    $('#next').addEventListener('click', () => { state.page++; render(); });
    el.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openDeviceDrawer(tr.dataset.id));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDeviceDrawer(tr.dataset.id); });
    });
  },

  device: deviceView,
  gallery: galleryView,
  infrastructure: infrastructureView,
  review: reviewView,
  reports: reportsView,
  approvals: approvalsView,
  plan: planView,
  operation: operationView,
  operations: operationsListView,
  runbooks: runbooksView,
  hud: hudView,
  analytics: analyticsView,
  security: securityView,
  settings: settingsView,

  async activity(el) {
    const [data, devs] = await Promise.all([
      api(`/api/v1/journal?page=${state.page}&pageSize=50`),
      api('/api/v1/devices?page=1&pageSize=200').catch(() => ({ rows: [] })),
    ]);
    const label = new Map((devs.rows || []).map((d) => [Number(d.device_id), d.system_name || d.display_name]));
    const pages = Math.max(Math.ceil(data.total / data.pageSize), 1);
    const ST = { ok: ['badge-ok', 'check'], dry_run: ['badge-accent', 'eye'], error: ['badge-bad', 'warn'], blocked: ['badge-warn', 'lock'] };
    el.innerHTML = `
      <div data-view-root="activity">
      ${pageHeader({ icon: 'activity', title: 'Activity', sub: 'The tool-call journal — every write tool this command center invoked (including blocked and dry-run attempts) and what came back.' })}
      <div class="panel">
        <table class="data"><thead><tr><th>Result</th><th>When</th><th>Tool</th><th>Target</th><th>Detail</th></tr></thead><tbody>
        ${data.rows.map((j) => {
          const [cls, ic] = ST[j.status] || ['badge-muted', 'pulse'];
          const detail = j.error || (j.args_redacted?.profile ? `${j.args_redacted.profile}${j.args_redacted.kind ? ` · ${j.args_redacted.kind}` : ''}` : '');
          const dev = j.target_device_id != null ? `<a href="#/device/${j.target_device_id}/overview" class="mono-val">${esc(label.get(Number(j.target_device_id)) ?? `device ${j.target_device_id}`)}</a>` : j.target_org_id != null ? `<span class="sub">org ${esc(j.target_org_id)}</span>` : '<span class="sub">—</span>';
          return `<tr><td><span class="badge ${cls}">${icon(ic)}${esc(String(j.status).replace('_', ' '))}</span></td>
            <td class="sub" title="${esc(fmtTs(j.ts))}">${ago(j.ts)}</td><td class="mono-val">${esc(j.tool)}</td><td>${dev}</td>
            <td class="sub wrap">${esc(detail || '—')}</td></tr>`;
        }).join('') || '<tr><td colspan="5" class="empty">No journal entries yet.</td></tr>'}
        </tbody></table>
      </div>
      <div class="pager">
        <button id="prev" ${state.page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span>Page ${data.page} / ${pages}</span>
        <button id="next" ${state.page >= pages ? 'disabled' : ''}>Next →</button>
      </div>
      </div>`;
    $('#prev').addEventListener('click', () => { state.page--; render(); });
    $('#next').addEventListener('click', () => { state.page++; render(); });
  },
};

// ── Hash router — the M5 deep-link contract ─────────────────────────────
//   #/overview #/devices #/organizations #/changes #/activity #/gallery
//   #/device/<id>/<tab>?snap=<snapshotId>
//   #/approvals #/plan/<id> #/operation/<id>  (M5A operation surfaces)
// Structural changes (view/device/tab) push history; parameter changes
// (snapshot selection) replace — so back/forward stays meaningful.
const NAV_VIEWS = ['hud', 'analytics', 'overview', 'devices', 'organizations', 'infrastructure', 'review', 'reports', 'changes', 'activity', 'approvals', 'operations', 'runbooks', 'security', 'settings'];
/* Sidebar highlight for views without their own nav entry. */
const NAV_PARENT = { device: 'devices', overview: 'hud', changes: 'activity', plan: 'approvals', operation: 'operations', gallery: 'hud', org: 'organizations' };

/* Views that show "all orgs or one org" carry the scope as ?org= so a URL
   always says what it shows. Org-bound views put the org in the path. */
const SCOPED_VIEWS = new Set(['hud', 'analytics', 'devices', 'organizations']);
const ORG_PATH_VIEWS = new Set(['infrastructure', 'review', 'reports']);

function stateToHash() {
  let path = `/${state.view}`;
  const sc = scopeOrg();
  if (state.view === 'device' && state.deviceId) path += `/${state.deviceId}/${state.deviceTab || 'overview'}`;
  else if (state.view === 'plan' && state.planId) path += `/${state.planId}`;
  else if (state.view === 'operation' && state.opId) path += `/${state.opId}`;
  else if (state.view === 'org' && state.orgPageId) path += `/${state.orgPageId}`;
  else if (state.view === 'infrastructure' && sc != null) path += `/${sc}/${state.infraTab || 'overview'}`;
  else if (state.view === 'review' && sc != null) path += `/${sc}/${state.reviewTab || 'inbox'}`;
  else if (state.view === 'reports' && sc != null) path += `/${sc}`;
  const q = new URLSearchParams();
  if (SCOPED_VIEWS.has(state.view) && sc != null) q.set('org', sc);
  if (state.view === 'device' && state.deviceSnapId) q.set('snap', state.deviceSnapId);
  if (state.view === 'devices') {
    if (state.q) q.set('q', state.q);
    if (state.page > 1) q.set('page', state.page);
    if (state.offline !== null) q.set('offline', state.offline ? '1' : '0');
    if (state.kind) q.set('kind', state.kind);
    if (state.sort !== 'name' || state.dir !== 'asc') { q.set('sort', state.sort); q.set('dir', state.dir); }
  }
  if (state.view === 'changes' && state.changesType) q.set('type', state.changesType);
  if (state.view === 'infrastructure' && state.infraCat) q.set('cat', state.infraCat);
  if (state.view === 'review' && state.reviewTab === 'item' && state.reviewItemId) q.set('i', state.reviewItemId);
  if (state.view === 'runbooks' && state.runbookId) q.set('rb', state.runbookId);
  if (state.view === 'operations' && state.opsStatus) q.set('status', state.opsStatus);
  const qs = q.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

function hashToState(hash) {
  const m = (hash || '').replace(/^#/, '').match(/^\/([a-z]+)(?:\/([A-Za-z0-9-]+))?(?:\/([a-z]+))?(?:\?(.*))?$/);
  if (!m) return;
  const [, view, id, sub, qs] = m;
  if (!views[view]) return;
  state.view = view;
  if (view === 'device') { state.deviceId = id ? Number(id) : null; state.deviceTab = sub || 'overview'; }
  if (view === 'plan') state.planId = id ?? null;
  if (view === 'operation') state.opId = id ?? null;
  if (view === 'infrastructure') state.infraTab = sub || 'overview';
  if (view === 'review') state.reviewTab = sub || 'inbox';
  if (view === 'org') state.orgPageId = id ? Number(id) : null;
  if ((ORG_PATH_VIEWS.has(view) || view === 'org') && id && /^\d+$/.test(id)) adoptUrlOrg(Number(id));
  const p = new URLSearchParams(qs || '');
  // Scoped views: an explicit ?org= wins (?org=all = every org); a link
  // without one keeps the current scope, so in-page links never reset it.
  if (SCOPED_VIEWS.has(view)) {
    const o = p.get('org') ?? p.get('orgId');
    if (o === 'all') { if (scopeOrg() != null) setScopeQuiet(null); }
    else if (o) adoptUrlOrg(Number(o));
  }
  state.reviewItemId = view === 'review' && sub === 'item' ? p.get('i') : null;
  if (view === 'device') state.deviceSnapId = p.get('snap');
  if (view === 'devices') {
    state.q = p.get('q') || '';
    state.page = Math.max(1, Number(p.get('page')) || 1);
    state.offline = p.has('offline') ? p.get('offline') === '1' : null;
    state.kind = p.get('kind') || null;
    state.sort = p.get('sort') || 'name';
    state.dir = p.get('dir') || 'asc';
  }
  if (view === 'changes') state.changesType = p.get('type');
  if (view === 'infrastructure') state.infraCat = p.get('cat');
  if (view === 'runbooks') state.runbookId = p.get('rb');
  if (view === 'operations') state.opsStatus = p.get('status');
}

/** Navigate: serialize state → hash. Pushes on structural change, replaces
    on parameter-only change, then renders. */
function nav() {
  const target = stateToHash();
  const structural = (h) => h.replace(/^#/, '').split('?')[0];
  if (target === location.hash) { render(); return; }
  if (structural(target) === structural(location.hash)) {
    history.replaceState(null, '', target);
    render();
  } else {
    location.hash = target; // hashchange → applyHash → render
  }
}

let renderedView = null;
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const el = $('#view');
  const structural = renderedView !== state.view;
  if (structural && renderedView === 'hud') leaveHud();
  // An inspector belongs to the page that opened it — never let it follow
  // the user to another page.
  if (structural) closeDrawer();
  const paint = async () => {
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === (NAV_PARENT[state.view] ?? state.view)));
    try {
      await views[state.view](el);
    } catch (e) {
      if (seq === renderSeq) el.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  };
  // Route changes morph through a View Transition; in-place refreshes
  // (polling, filters, SSE) repaint directly so nothing flickers.
  if (structural && document.startViewTransition && renderedView !== null) {
    renderedView = state.view;
    await document.startViewTransition(paint).updateCallbackDone.catch(() => {});
    if (structural) el.scrollTop = 0, window.scrollTo({ top: 0 });
  } else {
    renderedView = state.view;
    await paint();
  }
  // Keep the address bar truthful after state mutations that bypassed nav().
  const target = stateToHash();
  if (target !== location.hash) history.replaceState(null, '', target);
}

// Cross-module wiring — feature modules call ctx.* instead of importing app.
ctx.render = render;
ctx.nav = nav;
ctx.openDeviceDrawer = openDeviceDrawer;
ctx.openEntityDrawer = openEntityDrawer;

document.querySelectorAll('.nav-item').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = b.dataset.view; state.page = 1;
    if (state.view !== 'device') { state.deviceId = null; state.deviceSnapId = null; }
    nav();
  }));

window.addEventListener('hashchange', () => { hashToState(location.hash); render(); });

// Shell poll — one cheap local aggregate drives every badge: pending
// approvals (global, surfaced for the human instead of buried in a drawer),
// review items for the scoped org, devices online, and the attention bell.
// A failed poll hides counts rather than showing a misleading zero.
async function refreshShell() {
  const setCount = (sel, n, text = String(n)) => { const b = $(sel); if (b) { b.hidden = !n; b.textContent = text; } };
  try {
    const h = await api('/api/v1/hud');
    lastHud = h;
    updateOrgs(h.orgs);
    setCount('#nav-approvals-count', h.approvals.pending);
    setCount('#nav-devices-count', h.fleet.total, `${h.fleet.online}/${h.fleet.total}`);
    const att = h.attentionTotal;
    const ac = $('#attention-count');
    ac.hidden = !att; ac.textContent = att > 99 ? '99+' : String(att);
    ac.classList.toggle('is-warn', !h.attention.some((a) => a.severity === 'critical'));
    if (!$('#attention-pop').hidden) renderAttention();
  } catch {
    ['#nav-approvals-count', '#nav-devices-count', '#attention-count'].forEach((s) => { const b = $(s); if (b) b.hidden = true; });
  }
  try {
    const org = state.reviewOrg || state.infraOrg || 2;
    const d = await api(`/api/v1/orgs/${org}/review`);
    setCount('#nav-review-count', (d.counts?.open ?? 0) + (d.counts?.openQuestions ?? 0));
  } catch { setCount('#nav-review-count', 0); }
  try {
    const s = await api('/api/v1/approver/status');
    const f = $('#nav-security-flag');
    if (f) f.hidden = s.enforced || s.profile !== 'command';
  } catch { /* best-effort */ }
}
ctx.refreshShell = refreshShell;
setInterval(() => { if (!document.hidden) refreshShell(); }, 30_000);

// ── SSE invalidation — live badge + silent re-render of list views ──────
{
  const badge = $('#live-badge');
  const ac = new AbortController();
  let deb;
  streamInvalidations({
    signal: ac.signal,
    onStatus: (s) => {
      badge.querySelector('.live-text').textContent = s === 'live' ? 'Live' : 'Offline';
      badge.classList.toggle('is-live', s === 'live');
      badge.title = s === 'live' ? 'Live — the UI refreshes as the local store changes' : 'Live stream disconnected — retrying';
    },
    onEvent: () => {
      // Entities changed upstream → refresh meta + re-render list views,
      // but never steal focus out of an input the user is typing in.
      clearTimeout(deb);
      deb = setTimeout(() => {
        loadMeta();
        const active = document.activeElement;
        if (active && $('#view').contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName)) return;
        refreshShell();
        if (['devices', 'overview', 'organizations', 'changes', 'activity', 'hud'].includes(state.view)) render();
      }, 1500);
    },
  }).catch(() => { badge.querySelector('.live-text').textContent = 'Offline'; });
}

// ── Boot ────────────────────────────────────────────────────────────────
// URL scope (if any) is applied first; initScope falls back to the stored one.
if (location.hash) hashToState(location.hash);
else state.view = 'hud';
initScope();
refreshShell();
initPalette();
loadMeta().then(render);
