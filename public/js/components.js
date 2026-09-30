/* Shared render primitives — the component vocabulary for resource cards,
   status language, freshness, glance strips, and comparisons. Used by the
   device drawer, device details page, and the fixture gallery. Pure
   functions: data in → HTML string out. */

import { esc, ago, fmtTs } from './core.js';
import { icon, iconTile } from './icons.js';

/* ── Page header — icon tile + title + one-line purpose (UI-2 §7) ─────── */
/* `subHtml` is for callers that build the subtitle themselves with esc() —
   use `sub` for plain text. */
export const pageHeader = ({ icon: ic, title, sub, subHtml = '', actions = '' }) => `
  <div class="page-head">
    ${iconTile(ic)}
    <div class="page-head-text">
      <h1 class="page-title">${esc(title)}</h1>
      ${subHtml ? `<div class="page-sub">${subHtml}</div>` : sub ? `<div class="page-sub">${esc(sub)}</div>` : ''}
    </div>
    ${actions ? `<div class="page-head-actions">${actions}</div>` : ''}
  </div>`;

/* ── Stat card — icon tile + count + label + optional chevron (UI-2 §8) ─
   `go` marks it a real navigation/filter action; without it the card is
   inert (no chevron, no button styling — honest affordance). */
export const statCard = ({ icon: ic, tone = 'accent', value, label, sub = '', go = false, title = '', data = '', active = false }) => `
  <div class="stat-card${go ? ' clickable' : ''}${active ? ' card-active' : ''}"${title ? ` title="${esc(title)}"` : ''}${go ? ' role="button" tabindex="0"' : ''}${data ? ` data-go="${esc(data)}"` : ''}>
    ${iconTile(ic, tone)}
    <div class="stat-body">
      <div class="stat-value">${value === null || value === undefined ? '—' : esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>
    ${go ? `<span class="stat-chev">${icon('chev-r')}</span>` : ''}
  </div>`;

export const RESOURCE_LABELS = {
  identity: 'Identity', network: 'Network', last_user: 'Last reported user',
  policy_assignment: 'Policy', software_inventory: 'Software',
  os_patch_state: 'OS patches', software_patch_state: 'Software patches',
  storage: 'Storage', alerts: 'Alerts',
  os_patch_history: 'OS patch history', software_patch_history: 'Software patch history',
};
export const STANDARD_RESOURCES = [
  'identity', 'network', 'last_user', 'policy_assignment',
  'software_inventory', 'os_patch_state', 'storage', 'alerts',
];

/* ── Status language ────────────────────────────────────────────────────
   Collection-state machine: distinct not-collected / collecting /
   available / failed / forbidden / unsupported / skipped / referenced,
   with staleness and history as MODIFIERS (badges), never state swaps. */
export const resBadge = (r, { collecting = false } = {}) => {
  if (collecting) return '<span class="badge badge-accent">collecting…</span>';
  if (!r) return '<span class="badge badge-muted">not collected</span>';
  if (r.state === 'reused') return '<span class="badge badge-accent">referenced</span>';
  if (r.state === 'skipped') return '<span class="badge badge-warn">skipped</span>';
  if (r.state === 'failed') return '<span class="badge badge-bad">failed</span>';
  const byStatus = {
    succeeded: '<span class="badge badge-ok">available</span>',
    forbidden: '<span class="badge badge-bad">forbidden</span>',
    unsupported: '<span class="badge badge-muted">unsupported</span>',
    skipped: '<span class="badge badge-warn">skipped</span>',
    failed: '<span class="badge badge-bad">failed</span>',
  };
  return byStatus[r.collection_status] || `<span class="badge badge-muted">${esc(r.collection_status ?? 'unknown')}</span>`;
};

export const staleBadge = (r) =>
  r?.fetched_at && Date.now() - r.fetched_at > 24 * 3600e3
    ? '<span class="badge badge-warn" title="Fetched more than 24h ago — verify before relying on it">stale</span>'
    : '';

/** Historical-viewing modifier — distinct from collection state. */
export const historicalBanner = (snap) =>
  `<div class="banner-warn">Viewing snapshot assembled ${fmtTs(snap.sealed_at)} — historical evidence, not current state. Refresh creates a new snapshot.</div>`;

/** Completeness chip — only when the resource declares a partial shape. */
export const completenessBadge = (r) =>
  r?.completeness && r.completeness !== 'complete' && r.completeness !== 'not_applicable'
    ? `<span class="badge badge-warn">${esc(r.completeness)}</span>` : '';

/* ── At-a-glance strip ──────────────────────────────────────────────────
   The four things a tech checks first. Only collected fields render —
   absent ones stay absent (never fabricated). */
export const glanceHtml = (byType) => {
  const idp = byType.get('identity')?.preview ?? {};
  const net = byType.get('network')?.preview ?? {};
  const usr = byType.get('last_user')?.preview?.items?.[0] ?? {};
  const pol = byType.get('policy_assignment')?.preview ?? {};
  const cells = [
    ['OS', idp.os?.name ?? idp.os ?? null],
    ['IP', net.ipAddresses?.[0] ?? net.publicIP ?? null],
    ['Last user', usr.userName ?? null],
    ['Policy', pol.observedName ?? (pol.policyId ? `policy ${pol.policyId}` : null)],
  ].filter(([, v]) => v != null && v !== '');
  if (!cells.length) return '';
  return `<div class="glance-strip">${cells.map(([k, v]) =>
    `<div class="glance-cell"><div class="glance-k">${k}</div><div class="glance-v">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</div></div>`).join('')}</div>`;
};

/* ── Resource preview line ────────────────────────────────────────────── */
export const previewLine = (type, r) => {
  const p = r?.preview;
  if (!p) return '';
  const items = p.items;
  switch (type) {
    case 'network': {
      const ips = [p.ipAddresses, p.publicIP].flat().filter(Boolean);
      const n = Array.isArray(p.interfaces) ? p.interfaces.length : 0;
      return `${ips.slice(0, 4).map(esc).join(', ') || '—'}${n ? ` · ${n} interface(s)` : ''}`;
    }
    case 'last_user': return items?.[0]?.userName || items?.[0]?.logonName || '—';
    case 'policy_assignment': return p.observedName || (p.policyId ? `policy ${p.policyId}` : '—');
    case 'software_inventory': return `${p.total ?? items?.length ?? 0} item(s)`;
    case 'os_patch_state': case 'software_patch_state': {
      if (!items?.length) return 'none pending';
      const byStatus = {};
      for (const i of items) byStatus[i.status ?? 'unknown'] = (byStatus[i.status ?? 'unknown'] || 0) + 1;
      return `${p.total ?? items.length} item(s) · ` + Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ');
    }
    case 'storage': {
      if (!items?.length) return '';
      const v = items.reduce((a, b) => ((b.freeSpace ?? Infinity) < (a.freeSpace ?? Infinity) ? b : a), items[0]);
      return `${items.length} volume(s) · lowest free ${esc(v.name ?? '?')} ${v.freeSpace != null && v.capacity ? Math.round(100 * v.freeSpace / v.capacity) + '%' : '?'}`;
    }
    case 'alerts': return `${p.total ?? items?.length ?? 0} alert(s)`;
    default: return items ? `${p.total ?? items.length} item(s)` : '';
  }
};

/* ── Generic key/value sheet ──────────────────────────────────────────── */
export const kvOf = (obj) =>
  `<dl class="kv">${Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono-val">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd>`).join('')}</dl>`;

/* ── Pending-patch status buckets ───────────────────────────────────────
   Separate available categories — never imply "installed" from a
   pending-only endpoint. */
export const patchBuckets = (r) => {
  const items = r?.preview?.items ?? [];
  const total = r?.preview?.total ?? items.length;
  if (!items.length) return `<div class="sub">${total} pending — pending-patch list, not install status</div>`;
  const buckets = {};
  for (const i of items) { const k = i.status ?? 'unknown'; buckets[k] = (buckets[k] ?? 0) + 1; }
  return `<div class="sub">${total} pending</div>
    <div class="toolbar">${Object.entries(buckets).map(([k, n]) => `<span class="badge badge-warn">${esc(k)}: ${n}</span>`).join('')}</div>`;
};

/* ── Comparison rendering — shared between drawer + details page ────────
   Grouped changed/unchanged/not-comparable with routine-tick separation,
   schema-delta notes, and partial-coverage caveats. */
export function comparisonHtml(comparison, { compact = false } = {}) {
  const c = comparison.counts || {};
  const res = comparison.resources || [];
  const row = (r) => {
    const det = r.detail || {};
    const statusBadge =
      r.status === 'changed' && r.meaningful === false ? '<span class="badge badge-muted">routine tick</span>'
      : r.status === 'changed' ? '<span class="badge badge-accent">changed</span>'
      : r.status === 'unchanged' ? '<span class="badge badge-ok">unchanged</span>'
      : `<span class="badge badge-muted">not comparable${r.reason ? ` — ${esc(r.reason)}` : ''}</span>`;
    const bits = [];
    if (det.fields?.length) {
      bits.push(det.fields.slice(0, compact ? 8 : 30).map((f) =>
        `<div class="cmp-change">${esc(f.field)}: ${esc(JSON.stringify(f.before))} → ${esc(JSON.stringify(f.after))}</div>`).join(''));
    }
    if (det.itemCounts || det.added?.length || det.removed?.length || det.modified?.length) {
      bits.push(`<div class="sub">items ${det.itemCounts ? `${det.itemCounts.baseline}→${det.itemCounts.comparison}` : '—'} · +${(det.added || []).length} −${(det.removed || []).length} ~${(det.modified || []).length}${det.truncated ? ' (truncated)' : ''}</div>`);
    }
    if (det.schemaDelta) {
      bits.push(`<div class="sub">schema change: +${(det.schemaDelta.onlyInComparison || []).length}/−${(det.schemaDelta.onlyInBaseline || []).length} field(s) not in both versions — adapter output changed, not necessarily the endpoint</div>`);
    }
    if (r.coverage === 'partial') bits.push('<div class="sub">partial coverage — removals are tentative</div>');
    if (!bits.length) bits.push('<div class="sub">—</div>');
    return `<div class="snap-card"><div class="snap-card-head"><strong>${esc(RESOURCE_LABELS[r.resource] ?? r.resource)}</strong>${statusBadge}</div>${bits.join('')}</div>`;
  };
  const changed = res.filter((r) => r.status === 'changed');
  const other = res.filter((r) => r.status !== 'changed');
  return `
    <div class="sub" style="margin-bottom:8px">
      ${c.changed ?? 0} changed (${c.meaningfulChanged ?? c.changed ?? 0} meaningful)
      · ${c.unchanged ?? 0} unchanged · ${c.not_comparable ?? 0} not comparable
    </div>
    ${changed.length ? `<div class="section-title">Changed</div><div class="snap-cards">${changed.map(row).join('')}</div>` : ''}
    ${other.length ? `<div class="section-title">Unchanged / not comparable</div><div class="snap-cards">${other.map(row).join('')}</div>` : ''}`;
}
