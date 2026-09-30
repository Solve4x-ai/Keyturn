// Command palette — Ctrl/⌘+K (or "/") from anywhere.
// Searches LOCAL data only: pages, devices, organizations, review findings,
// and runbooks. Choosing a result navigates; nothing here executes on an
// endpoint or calls NinjaOne. Preference toggles are the only "actions".
import { api, state, $, esc, ctx } from './core.js';
import { icon } from './icons.js';
import { getAppearance, setAppearance } from '../theme.js';

const PAGES = [
  { title: 'Mission Control', sub: 'Live fleet HUD', ic: 'hud', href: '#/hud', kw: 'home dashboard hud overview live' },
  { title: 'Analytics', sub: 'Trends and throughput', ic: 'analytics', href: '#/analytics', kw: 'charts trends stats' },
  { title: 'Devices', sub: 'Endpoint inventory', ic: 'devices', href: '#/devices', kw: 'endpoints computers servers workstations' },
  { title: 'Offline devices', sub: 'Devices not checking in', ic: 'devices', href: '#/devices?offline=1', kw: 'down offline' },
  { title: 'Organizations', sub: 'Tenants', ic: 'building', href: '#/organizations', kw: 'orgs clients tenants customers' },
  { title: 'Infrastructure', sub: 'AD · DNS · DHCP · GPO', ic: 'infrastructure', href: '#/infrastructure', kw: 'active directory dns dhcp gpo domain' },
  { title: 'Review Center', sub: 'AI findings, risks, questions', ic: 'review', href: '#/review', kw: 'risks findings ai questions inbox' },
  { title: 'Approvals', sub: 'Plans awaiting a human', ic: 'approvals', href: '#/approvals', kw: 'approve pending plans queue' },
  { title: 'Operations', sub: 'Execution history and receipts', ic: 'terminal', href: '#/operations', kw: 'jobs runs history receipts' },
  { title: 'Runbooks', sub: 'Reviewed script library', ic: 'book', href: '#/runbooks', kw: 'scripts library powershell' },
  { title: 'Approval security', sub: 'Passkeys · YubiKey · Bitwarden', ic: 'shield', href: '#/security', kw: 'security passkey yubikey bitwarden webauthn keys approver' },
  { title: 'Reports', sub: 'Management reports', ic: 'reports', href: '#/reports', kw: 'report export management' },
  { title: 'Activity', sub: 'Tool-call journal', ic: 'activity', href: '#/activity', kw: 'journal log audit' },
  { title: 'Changes', sub: 'Observed field-level diffs', ic: 'history', href: '#/changes', kw: 'diff changes' },
  { title: 'Collection & schedules', sub: 'Sync coverage, schedules', ic: 'refresh', href: '#/overview', kw: 'sync schedule collection refresh' },
];
const PREFS = [
  { title: 'Toggle light / dark theme', sub: 'Preference', ic: 'eye', run: () => setAppearance({ theme: getAppearance().theme === 'light' ? 'dark' : 'light' }), kw: 'theme dark light mode' },
  { title: 'Toggle sidebar', sub: 'Preference', ic: 'sidebar-l', run: () => { setAppearance({ sidebar: getAppearance().sidebar === 'collapsed' ? 'expanded' : 'collapsed' }); $('#sidebar-toggle')?.dispatchEvent(new Event('sync')); }, kw: 'sidebar collapse expand' },
  { title: 'Toggle density', sub: 'Preference', ic: 'layers', run: () => setAppearance({ density: getAppearance().density === 'comfortable' ? 'compact' : 'comfortable' }), kw: 'density compact comfortable' },
];

let runbookCache = null;
let orgCache = null;
let results = [];
let active = 0;
let seq = 0;

const norm = (s) => String(s ?? '').toLowerCase();
function score(q, ...fields) {
  if (!q) return 1;
  const hay = fields.map(norm).join(' ');
  if (norm(fields[0]).startsWith(q)) return 3;
  if (norm(fields[0]).includes(q)) return 2;
  return q.split(/\s+/).every((t) => hay.includes(t)) ? 1 : 0;
}
function highlight(text, q) {
  const t = String(text ?? '');
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(q);
  return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
}

async function search(raw) {
  const my = ++seq;
  const q = raw.trim().toLowerCase();
  const groups = [];
  const pages = PAGES.map((p) => ({ ...p, s: score(q, p.title, p.sub, p.kw) })).filter((p) => p.s).sort((a, b) => b.s - a.s);
  if (pages.length) groups.push(['Pages', pages.slice(0, q ? 5 : 8)]);
  if (q.length >= 1) {
    const org = state.reviewOrg || state.infraOrg || 2;
    const [dev, items] = await Promise.all([
      api(`/api/v1/devices?page=1&pageSize=7&q=${encodeURIComponent(q)}`).catch(() => ({ rows: [] })),
      q.length >= 2 ? api(`/api/v1/orgs/${org}/review/items?q=${encodeURIComponent(q)}&limit=6`).catch(() => ({ items: [] })) : { items: [] },
    ]);
    if (!orgCache) orgCache = (await api('/api/v1/organizations').catch(() => ({ organizations: [] }))).organizations || [];
    if (!runbookCache) runbookCache = (await api('/api/v1/runbooks').catch(() => ({ runbooks: [] }))).runbooks || [];
    if (my !== seq) return null;
    const devices = (dev.rows || []).map((d) => ({
      title: d.system_name || d.display_name, sub: `${d.display_name && d.display_name !== d.system_name ? `${d.display_name} · ` : ''}${d.org_name ?? ''} · ${d.offline ? 'offline' : 'online'}`,
      ic: String(d.node_class ?? '').includes('SERVER') ? 'server' : 'devices', href: `#/device/${d.device_id}/overview`, hint: d.offline ? 'offline' : '',
    }));
    if (devices.length) groups.push(['Devices', devices]);
    const orgs = orgCache.filter((o) => score(q, o.name)).slice(0, 4).map((o) => ({ title: o.name, sub: `${o.device_count ?? '?'} devices`, ic: 'building', href: `#/org/${o.org_id}` }));
    if (orgs.length) groups.push(['Organizations', orgs]);
    const findings = (items.items || []).slice(0, 6).map((i) => ({ title: i.title, sub: `${i.item_type} · ${i.severity ?? 'unrated'} · ${i.category ?? ''}`, ic: i.item_type === 'risk' ? 'warn' : i.item_type === 'improvement' ? 'bulb' : 'eye', href: `#/review/${org}/item?i=${i.id}` }));
    if (findings.length) groups.push(['Findings', findings]);
    const rbs = runbookCache.map((r) => ({ r, s: score(q, r.title ?? r.id, r.id, r.category, r.purpose) })).filter((x) => x.s).slice(0, 5)
      .map(({ r }) => ({ title: r.title ?? r.id, sub: `${r.id} v${r.version} · ${r.category ?? ''}`, ic: 'book', href: `#/runbooks?rb=${encodeURIComponent(r.id)}` }));
    if (rbs.length) groups.push(['Runbooks', rbs]);
  }
  const prefs = PREFS.filter((p) => score(q, p.title, p.kw));
  if (prefs.length && (q || groups.length < 2)) groups.push(['Preferences', prefs]);
  return { groups, q };
}

function paint(res) {
  if (!res) return;
  const box = $('#palette-results');
  results = res.groups.flatMap(([, items]) => items);
  active = Math.min(active, Math.max(results.length - 1, 0));
  let i = 0;
  box.innerHTML = results.length ? res.groups.map(([g, items]) => `<div class="pal-group">${esc(g)}</div>${items.map((it) => {
    const idx = i++;
    return `<div class="pal-item" role="option" id="pal-${idx}" data-idx="${idx}" aria-selected="${idx === active}">
      <span class="pal-ic">${icon(it.ic)}</span>
      <span style="min-width:0"><span class="pal-title">${highlight(it.title, res.q)}</span><span class="pal-sub">${esc(it.sub ?? '')}</span></span>
      <span class="pal-hint">${esc(it.hint ?? '')}</span></div>`;
  }).join('')}`).join('') : `<div class="pal-empty">No local matches for “${esc(res.q)}”.</div>`;
  $('#palette-input').setAttribute('aria-activedescendant', results.length ? `pal-${active}` : '');
}

function move(d) {
  if (!results.length) return;
  active = (active + d + results.length) % results.length;
  document.querySelectorAll('.pal-item').forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.idx) === active)));
  document.getElementById(`pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  $('#palette-input').setAttribute('aria-activedescendant', `pal-${active}`);
}

function choose(idx) {
  const it = results[idx];
  if (!it) return;
  close();
  if (it.run) { it.run(); return; }
  if (it.href === '#/review') { location.hash = `#/review/${state.reviewOrg || 2}/inbox`; return; }
  if (it.href === '#/infrastructure') { location.hash = `#/infrastructure/${state.infraOrg || 2}/overview`; return; }
  if (location.hash === it.href) ctx.render(); else location.hash = it.href;
}

export function open() {
  const dlg = $('#palette');
  if (dlg.open) return;
  dlg.showModal();
  const input = $('#palette-input');
  input.value = '';
  active = 0;
  search('').then(paint);
  input.focus();
}
export function close() { const dlg = $('#palette'); if (dlg.open) dlg.close(); }

export function initPalette() {
  const input = $('#palette-input');
  let deb;
  input.addEventListener('input', () => { clearTimeout(deb); active = 0; deb = setTimeout(() => search(input.value).then(paint), 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  });
  $('#palette-results').addEventListener('click', (e) => { const it = e.target.closest('.pal-item'); if (it) choose(Number(it.dataset.idx)); });
  $('#palette-results').addEventListener('mousemove', (e) => {
    const it = e.target.closest('.pal-item');
    if (it && Number(it.dataset.idx) !== active) { active = Number(it.dataset.idx); move(0); }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  $('#palette-btn').addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').open ? close() : open(); }
    else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') && !$('#palette').open) { e.preventDefault(); open(); }
  });
}
