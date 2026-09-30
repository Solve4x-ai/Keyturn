// Global organization scope — one source of truth for "which tenant am I
// looking at", shared by every view.
//
//   state.scope === null   → All organizations
//   state.scope === <id>   → that organization
//
// The top-bar control is a two-part switch: an "All orgs" segment and an
// organization picker (searchable popover with live health per tenant).
// Changing scope re-renders the current page in place; org-bound pages
// (Infrastructure, Review, Reports, an org page) follow the new org, and
// pages that need a single org show a chooser while "All" is selected.
// A URL that names an org (e.g. #/infrastructure/2/dns or ?org=2, or
// ?org=all) wins over the stored scope; links without one keep the scope.
import { api, state, $, esc, ctx } from './core.js';
import { icon } from './icons.js';

const KEY = 'n1_scope';
let orgs = [];          // [{orgId, name, devices, offline, servers, risks}]
let lastOrg = null;     // most recent specific org — the picker segment label

export const scopeOrg = () => (state.scope == null ? null : Number(state.scope));
export const orgName = (id) => orgs.find((o) => o.orgId === Number(id))?.name ?? (id == null ? 'All organizations' : `Org ${id}`);
export const allOrgs = () => orgs;

/** Mirror the scope into the per-view state keys the older views read. */
function applyToState(v) {
  state.scope = v;
  state.hudScope = v == null ? 'all' : String(v);
  state.anOrg = v == null ? 'all' : String(v);
  state.orgId = v;
  if (v != null) {
    state.reviewOrg = state.infraOrg = state.reportOrg = v;
    lastOrg = v;
  }
}

export function setScope(v, { render = true } = {}) {
  const next = v === 'all' || v === '' || v == null ? null : Number(v);
  applyToState(next);
  try { localStorage.setItem(KEY, next == null ? 'all' : String(next)); } catch { /* private mode */ }
  paintSwitcher();
  if (!render) return;
  // Pages whose URL carries an org id navigate to the new org's version.
  if (next != null && ['review', 'infrastructure', 'reports', 'org'].includes(state.view)) {
    if (state.view === 'org') state.orgPageId = next;
    ctx.nav();
  } else {
    state.page = 1;
    ctx.nav();
  }
  ctx.refreshShell?.();
}

/** Called by the router when a URL names an org — URL beats stored scope. */
export function adoptUrlOrg(id) {
  if (id == null || Number.isNaN(Number(id))) return;
  applyToState(Number(id));
  try { localStorage.setItem(KEY, String(id)); } catch { /* ignore */ }
  paintSwitcher();
}

function paintSwitcher() {
  const all = $('#scope-all');
  const pick = $('#scope-pick');
  if (!all || !pick) return;
  const cur = scopeOrg();
  all.setAttribute('aria-pressed', String(cur == null));
  pick.setAttribute('aria-pressed', String(cur != null));
  const labelOrg = cur ?? lastOrg;
  const o = orgs.find((x) => x.orgId === labelOrg);
  $('#scope-pick-label').textContent = labelOrg == null ? 'Choose organization' : (o?.name ?? `Org ${labelOrg}`);
  $('#scope-pick-dot').className = `scope-dot ${o ? (o.offline && o.servers && o.risks.critical ? 'bad' : o.risks.high ? 'warn' : 'ok') : ''}`;
  document.documentElement.dataset.scope = cur == null ? 'all' : 'org';
}

function healthOf(o) {
  const on = o.devices - o.offline;
  return { pct: o.devices ? Math.round((on / o.devices) * 100) : 0, on };
}

function renderMenu(filter = '') {
  const q = filter.trim().toLowerCase();
  const cur = scopeOrg();
  const list = orgs.filter((o) => !q || o.name.toLowerCase().includes(q));
  const totals = orgs.reduce((t, o) => ({ devices: t.devices + o.devices, offline: t.offline + o.offline, risks: t.risks + o.risks.open }), { devices: 0, offline: 0, risks: 0 });
  $('#scope-menu-list').innerHTML = `
    <button class="scope-opt${cur == null ? ' is-current' : ''}" data-scope-opt="all" role="option" aria-selected="${cur == null}">
      <span class="so-avatar so-all">${icon('layers')}</span>
      <span class="so-body"><span class="so-name">All organizations</span><span class="so-meta">${orgs.length} tenants · ${totals.devices - totals.offline}/${totals.devices} online · ${totals.risks} open risks</span></span>
      ${cur == null ? `<span class="so-check">${icon('check')}</span>` : ''}
    </button>
    <div class="scope-sep"></div>
    ${list.map((o) => {
      const h = healthOf(o);
      const initials = o.name.split(/[\s,&]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      return `<button class="scope-opt${cur === o.orgId ? ' is-current' : ''}" data-scope-opt="${o.orgId}" role="option" aria-selected="${cur === o.orgId}">
        <span class="so-avatar">${esc(initials)}</span>
        <span class="so-body"><span class="so-name">${esc(o.name)}</span>
          <span class="so-meta"><span class="so-bar"><span style="width:${h.pct}%"></span></span>${h.on}/${o.devices} online · ${o.servers} servers${o.risks.open ? ` · <b class="${o.risks.high || o.risks.critical ? 'warn' : ''}">${o.risks.open} risks</b>` : ''}</span></span>
        ${cur === o.orgId ? `<span class="so-check">${icon('check')}</span>` : ''}
      </button>`;
    }).join('') || '<div class="so-empty">No organizations match.</div>'}`;
}

function openMenu() {
  const m = $('#scope-menu');
  renderMenu();
  m.hidden = false;
  $('#scope-pick').setAttribute('aria-expanded', 'true');
  const s = $('#scope-search');
  s.value = '';
  s.focus();
}
function closeMenu() {
  const m = $('#scope-menu');
  if (m.hidden) return;
  m.hidden = true;
  $('#scope-pick').setAttribute('aria-expanded', 'false');
}

/** Refresh org list + health (called by the shell poll with the HUD aggregate). */
export function updateOrgs(hudOrgs) {
  if (!Array.isArray(hudOrgs)) return;
  orgs = hudOrgs;
  paintSwitcher();
  if (!$('#scope-menu').hidden) renderMenu($('#scope-search').value);
}

export async function initScope() {
  try {
    const stored = localStorage.getItem(KEY);
    // Only apply the stored scope when the URL didn't already set one.
    if (state.scope === undefined) applyToState(stored && stored !== 'all' ? Number(stored) : null);
  } catch { if (state.scope === undefined) applyToState(null); }
  $('#scope-all-ic').innerHTML = icon('layers');
  $('#scope-pick-chev').innerHTML = icon('chev-d');
  $('#scope-search-ic').innerHTML = icon('search');
  $('#scope-all').addEventListener('click', () => { if (scopeOrg() != null) setScope(null); });
  $('#scope-pick').addEventListener('click', (e) => { e.stopPropagation(); $('#scope-menu').hidden ? openMenu() : closeMenu(); });
  $('#scope-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-scope-opt]');
    if (!b) return;
    closeMenu();
    setScope(b.dataset.scopeOpt === 'all' ? null : Number(b.dataset.scopeOpt));
  });
  $('#scope-search').addEventListener('input', (e) => renderMenu(e.target.value));
  $('#scope-search').addEventListener('keydown', (e) => {
    const opts = [...document.querySelectorAll('#scope-menu-list [data-scope-opt]')];
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[0]?.focus(); }
    // Enter picks the first matching organization (skipping "All") when searching.
    if (e.key === 'Enter') { e.preventDefault(); (e.target.value.trim() ? opts.find((o) => o.dataset.scopeOpt !== 'all') : opts[0])?.click(); }
  });
  $('#scope-menu-list').addEventListener('keydown', (e) => {
    const opts = [...document.querySelectorAll('#scope-menu-list [data-scope-opt]')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); i <= 0 ? $('#scope-search').focus() : opts[i - 1]?.focus(); }
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  try { updateOrgs((await api('/api/v1/hud')).orgs); } catch { /* shell poll retries */ }
  paintSwitcher();
}

/**
 * For pages that need exactly one org: returns the org id, or renders an
 * organization chooser into `el` and returns null while "All" is selected.
 */
export function requireOrg(el, { title, sub, icon: ic = 'building' }) {
  const cur = scopeOrg();
  if (cur != null) return cur;
  el.innerHTML = `
    <div class="org-chooser rise" data-view-root="${esc(state.view)}">
      <div class="oc-head"><span class="icon-tile">${icon(ic)}</span>
        <div><h1 class="page-title">${esc(title)}</h1><div class="page-sub">${esc(sub ?? 'This page covers one organization at a time — pick which one. The top-bar switch changes it anywhere.')}</div></div></div>
      <div class="oc-grid">${orgs.map((o) => {
        const h = healthOf(o);
        return `<button class="oc-card glass" data-pick-org="${o.orgId}">
          <div class="oc-name">${esc(o.name)}</div>
          <div class="ot-bar"><span style="width:${h.pct}%"></span></div>
          <div class="ot-stats"><span><b>${h.on}</b>/${o.devices} online</span><span><b>${o.servers}</b> servers</span><span class="${o.risks.high || o.risks.critical ? 'warn' : ''}"><b>${o.risks.open}</b> risks</span></div>
          <span class="oc-go">${icon('arrow-ur')}</span>
        </button>`;
      }).join('') || '<div class="empty">No organizations in the local inventory — sync from Overview.</div>'}</div>
    </div>`;
  el.querySelectorAll('[data-pick-org]').forEach((b) => b.addEventListener('click', () => setScope(Number(b.dataset.pickOrg))));
  return null;
}
