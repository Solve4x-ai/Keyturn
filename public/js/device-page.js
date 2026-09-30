/* Full-page device details — route-addressable tabs, persistent snapshot
   context, structured resource views. Same services as the drawer; nothing
   forked. Tab ↔ hash mapping is the M5 deep-link contract:
     #/device/<id>/<tab>?snap=<snapshotId>
   Tabs: overview | software | patches | netstorage | alerts | history */

import { api, state, $, esc, ago, fmtTs, fmtBytes, toast, ctx } from './core.js';
import {
  resBadge, staleBadge, glanceHtml, kvOf, patchBuckets,
  comparisonHtml, completenessBadge, RESOURCE_LABELS,
} from './components.js';

/* Minimal context menu — positioned at cursor, closes on outside click,
   Escape, or scroll. Items carry disabled state honestly. */
let openMenu = null;
function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) =>
    `<button class="ctx-item" role="menuitem" data-ctx="${i}" ${it.disabled ? 'disabled' : ''} title="${esc(it.hint ?? '')}">${esc(it.label)}</button>`,
  ).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelectorAll('[data-ctx]').forEach((b) =>
    b.addEventListener('click', () => { const it = items[Number(b.dataset.ctx)]; closeCtxMenu(); if (!it.disabled) it.onClick?.(); }));
  openMenu = menu;
}
function closeCtxMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('click', (e) => { if (openMenu && !openMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
document.addEventListener('scroll', closeCtxMenu, true);

const TABS = [
  ['overview', 'Overview'],
  ['software', 'Software'],
  ['patches', 'Patches'],
  ['netstorage', 'Network & storage'],
  ['alerts', 'Alerts'],
  ['history', 'History & evidence'],
];

// Auto-classified heuristic: hotfixes/updates, and Microsoft-published
// platform components (.NET, VC++ redists, SDKs, Edge, runtimes) go to the
// components bucket; everything else is an installed application.
const isComponent = (i) =>
  /^KB\d{4,}/i.test(i.name ?? '') ||
  /update for|security update|hotfix|feature pack|language pack/i.test(i.name ?? '') ||
  (/microsoft/i.test(i.publisher ?? '') &&
    /\.net|runtime|redistributable|visual c\+\+|sdk\b|edge|host fx|windows/i.test(i.name ?? ''));

/* Resource section header: state badges + freshness + Fetch control.
   The body only renders when an observation is linked. */
const resSection = (byType, type, title, render) => {
  const r = byType.get(type);
  const times = r ? `<span class="sub">fetched ${r.fetched_at ? ago(r.fetched_at) : '—'}${r.source_observed_at ? ` · source observed ${ago(r.source_observed_at)}` : ' · source time n/a'}</span>` : '';
  return `<div class="section-title">${esc(title)} ${resBadge(r)} ${completenessBadge(r)} ${staleBadge(r)} ${times}
      <button class="btn-mini" data-dp-fetch="${type}">${r ? 'Refresh' : 'Fetch'}</button></div>
    <div data-res-body="${type}">${r?.observation_id ? render(r) : '<div class="sub">Not collected in the selected snapshot.</div>'}</div>`;
};

/* Structured network interfaces — cards keyed off interfaceName/adapterName,
   honest about absent fields. */
const networkHtml = (r) => {
  const p = r.preview ?? {};
  const ifaces = Array.isArray(p.interfaces) ? p.interfaces : [];
  const ips = [p.ipAddresses, p.publicIP].flat().filter(Boolean);
  return `
    ${ips.length ? `<div class="sub" style="margin-bottom:8px">Observed IPs: ${ips.map(esc).join(', ')}</div>` : ''}
    ${ifaces.length ? `<div class="iface-grid">${ifaces.map((f) => `
      <div class="iface-card">
        <div class="iface-name">${esc(f.interfaceName ?? f.adapterName ?? 'interface')}</div>
        <div class="iface-meta">
          ${f.ipAddress ? `IP ${esc(f.ipAddress)}` : 'IP not reported'}${f.macAddress ? ` · MAC ${esc(f.macAddress)}` : ''}
          ${f.adapterName && f.interfaceName && f.adapterName !== f.interfaceName ? `<div>${esc(f.adapterName)}</div>` : ''}
        </div>
      </div>`).join('')}</div>` : `<div class="sub">${ifaces.length === 0 && !ips.length ? 'No interface data in this observation.' : 'Interface list not in preview — see observation detail.'}</div>`}`;
};

/* Volumes with usage bars — only when numerator+denominator+units are valid.
   Disks and volumes are NOT merged into a fake 1:1 relationship. */
const storageHtml = (r) => {
  const p = r.preview ?? {};
  // Validated fields: name, driveLetter, label, deviceType, fileSystem,
  // capacity, freeSpace (unit is whatever the source reports — shown raw).
  const vols = Array.isArray(p.volumes) ? p.volumes : (p.items ?? []);
  const volRow = (v) => {
    const cap = Number(v.capacity), free = Number(v.freeSpace);
    const valid = Number.isFinite(cap) && cap > 0 && Number.isFinite(free) && free >= 0;
    const pct = valid ? Math.round(100 * (1 - free / cap)) : null;
    const cls = pct == null ? '' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
    // driveLetter arrives as 'C:'; name often repeats it; label is the real
    // volume label ('Windows', 'Data'). Build one human-readable title.
    const letter = String(v.driveLetter ?? '').replace(/:+$/, '');
    const name = String(v.name ?? '').replace(/:+$/, '');
    const volLabel = String(v.label ?? '').trim();
    const title = letter
      ? `${letter}: ${volLabel || (name && name.toUpperCase() !== letter.toUpperCase() ? name : '')}`.trim()
      : volLabel || name || 'volume';
    return `<div class="vol-row">
      <span class="vol-name">${esc(title)}</span>
      <span class="vol-meta">
        ${[v.fileSystem, v.deviceType].filter(Boolean).map(esc).join(' · ')}
        ${valid ? `<div class="usage-bar"><div class="usage-fill ${cls}" style="width:${pct}%"></div></div>` : ''}
      </span>
      <span class="vol-nums">${valid ? `${pct}% used · ${fmtBytes(free)} free of ${fmtBytes(cap)}` : 'capacity unknown'}</span>
    </div>`;
  };
  return vols.length ? vols.map(volRow).join('') : '<div class="sub">No volumes in this observation.</div>';
};

/* Alerts — validated condition/severity fields only; expandable detail.
   "0 alerts" = successful collection with no issues, stated explicitly. */
const alertsHtml = (r) => {
  const items = r?.preview?.items ?? [];
  const total = r?.preview?.total ?? items.length;
  if (!items.length) return `<div class="sub">${total === 0 ? '0 alerts — collection succeeded, no issues reported' : `${total} alert(s) — item detail not in preview`}</div>`;
  return `${items.slice(0, 25).map((a, i) => {
    const sev = a.conditionHealthStatus ?? a.severity ?? a.priority ?? 'unknown';
    const cls = /fail|error|critical|bad/i.test(sev) ? 'badge-bad' : /warn/i.test(sev) ? 'badge-warn' : 'badge-muted';
    return `<details class="evidence-item">
      <summary class="clickable"><span class="badge ${cls}">${esc(sev)}</span> ${esc(a.conditionName ?? a.name ?? `alert ${i + 1}`)}</summary>
      <dl class="kv" style="margin-top:8px">${Object.entries(a)
        .filter(([k]) => !['conditionName', 'name'].includes(k))
        .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono-val">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd>`).join('')}</dl>
    </details>`;
  }).join('')}${total > 25 ? `<div class="sub">…${total - 25} more not shown in preview</div>` : ''}`;
};

export async function deviceView(el) {
  const id = state.deviceId;
  if (!id) { el.innerHTML = '<div class="empty">No device selected — open one from Devices</div>'; return; }
  const d = await api(`/api/v1/devices/${id}`);
  if (!d.device) { el.innerHTML = '<div class="empty">Device not in local inventory</div>'; return; }
  const dev = d.device;
  const { snapshots } = await api(`/api/v1/devices/${id}/snapshots?limit=50`);
  // Honor the snapshot the user picked (details page or drawer) — default latest.
  const latest = snapshots[0] ?? null;
  const selId = state.deviceSnapId && snapshots.some((s) => s.id === state.deviceSnapId)
    ? state.deviceSnapId : latest?.id;
  const sel = snapshots.find((s) => s.id === selId) ?? null;
  const detail = sel ? (await api(`/api/v1/snapshots/${sel.id}`)).snapshot : null;
  const byType = new Map((detail?.resources || []).map((r) => [r.resource_type, r]));
  const tab = TABS.some(([t]) => t === state.deviceTab) ? state.deviceTab : 'overview';

  const kv = [
    ['System name', dev.system_name], ['Display name', dev.display_name], ['DNS name', dev.dns_name],
    ['ID', dev.device_id], ['Organization', `${d.orgName ?? '—'} (${dev.org_id ?? '—'})`],
    ['Node class', dev.node_class], ['Reported status', dev.offline ? 'offline' : 'online'],
    ['Last contact', fmtTs(dev.last_contact)], ['Seen in local cache', fmtTs(dev.seen_at)],
  ];

  el.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">${esc(dev.display_name || dev.system_name)}</h2>
      <span class="badge ${dev.offline ? 'badge-bad' : 'badge-ok'}">${dev.offline ? 'offline' : 'online'}</span>
      <span class="sub">${esc(d.orgName ?? '—')} · id ${dev.device_id}</span>
      <select id="dp-snap" title="Snapshot context">${snapshots.map((s) => `<option value="${s.id}" ${sel && s.id === sel.id ? 'selected' : ''}>${fmtTs(s.sealed_at)} · ${esc(s.profile)}</option>`).join('') || '<option value="">no snapshots</option>'}</select>
      <button class="btn secondary" id="dp-collect">Collect device details</button>
    </div>
    ${glanceHtml(byType)}
    ${sel && detail && sel.id !== latest?.id ? `<div class="banner">Viewing historical snapshot sealed ${fmtTs(sel.sealed_at)} — not the latest device state. <button class="btn-mini" id="dp-latest">Jump to latest</button></div>` : ''}
    ${detail ? '' : '<div class="empty">No snapshots yet — Collect device details to gather evidence, or Fetch a single resource below.</div>'}
    <div class="dtabs" role="tablist" aria-label="Device sections">
      ${TABS.map(([t, label]) => `<button class="dtab ${t === tab ? 'active' : ''}" role="tab" aria-selected="${t === tab}" data-tab="${t}">${label}</button>`).join('')}
    </div>
    <div id="dp-tab-body"></div>`;

  const body = $('#dp-tab-body');

  /* ── Tab bodies ─────────────────────────────────────────────────────── */
  const renderTab = async () => {
    if (tab === 'overview') {
      body.innerHTML = `
        ${resSection(byType, 'identity', 'Identity', (r) => kvOf(r.preview ?? {}))}
        ${resSection(byType, 'last_user', 'Last reported user', (r) => kvOf(r.preview?.items?.[0] ?? {}))}
        ${resSection(byType, 'policy_assignment', 'Policy', (r) => kvOf(r.preview ?? {}))}
        <div class="section-title">Local changes</div>
        ${d.changes.filter((c) => c.field !== 'last_contact').length
          ? `<table class="data"><tbody>${d.changes.filter((c) => c.field !== 'last_contact').map((c) =>
              `<tr><td>${esc(c.field)}</td><td>${esc(`${c.old_value ?? '∅'} → ${c.new_value ?? '∅'}`)}</td><td class="sub">${fmtTs(c.detected_at)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="sub">No meaningful changes recorded.</div>'}`;
    } else if (tab === 'software') {
      body.innerHTML = `
        ${resSection(byType, 'software_inventory', 'Software inventory', (r) => `<div id="sw-inventory" data-obs="${r.observation_id}"><div class="sub">Loading inventory…</div></div>`)}
        <div class="sub" style="margin-top:10px">Components/runtimes grouping is a heuristic (name + publisher rules), not a Windows feature API — it errs toward Applications. Classification never affects snapshot records or comparison.</div>`;
      await renderSoftware();
    } else if (tab === 'patches') {
      body.innerHTML = `
        <div class="banner">Pending-patch lists describe what is available to install — they are not install-status totals. Install history is a separate resource.</div>
        ${resSection(byType, 'os_patch_state', 'OS patches (pending)', (r) => patchBuckets(r))}
        ${resSection(byType, 'software_patch_state', 'Software patches (pending)', (r) => `${patchBuckets(r)}<div class="sub">Third-party patch item shape is unverified — no representative response observed yet.</div>`)}
        ${resSection(byType, 'os_patch_history', 'OS patch history', (r) => `<div class="sub">${r.preview?.total ?? 0} install event(s) — install history, not current state</div>`)}
        ${resSection(byType, 'software_patch_history', 'Software patch history', (r) => `<div class="sub">${r.preview?.total ?? 0} install event(s)</div>`)}`;
    } else if (tab === 'netstorage') {
      body.innerHTML = `
        ${resSection(byType, 'network', 'Network', networkHtml)}
        ${resSection(byType, 'storage', 'Storage', storageHtml)}`;
    } else if (tab === 'alerts') {
      body.innerHTML = resSection(byType, 'alerts', 'Alerts', alertsHtml);
    } else if (tab === 'history') {
      body.innerHTML = `
        <div class="section-title">Snapshot history</div>
        ${snapshots.length ? `<table class="data"><thead><tr><th>Sealed</th><th>Profile</th><th>Reason</th><th>Digest</th><th></th></tr></thead><tbody>
          ${snapshots.map((s) => `<tr><td class="sub">${fmtTs(s.sealed_at)}</td><td>${esc(s.profile)}</td><td class="sub">${esc(s.reason)}</td><td class="sub mono-val">${esc(s.manifest_digest.slice(0, 16))}</td>
            <td>${selId && s.id !== selId ? `<button class="btn-mini" data-view-snap="${s.id}">View</button>` : '<span class="badge badge-accent">viewing</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">None yet</div>'}
        <div class="section-title">Compare snapshots</div>
        <div class="toolbar">
          <select id="dp-compare-base" ${snapshots.length < 2 ? 'disabled' : ''} title="Side-by-side baseline">
            <option value="">baseline…</option>
            ${snapshots.filter((s) => s.id !== selId).map((s) => `<option value="${s.id}">${fmtTs(s.sealed_at)} · ${esc(s.profile)}</option>`).join('')}
          </select>
          <span class="sub">selected snapshot is the comparison side</span>
        </div>
        <div id="dp-diff"></div>
        <div class="section-title">Journal (operations on this device)</div>
        ${d.journal.length ? `<table class="data"><tbody>${d.journal.map((j) =>
          `<tr><td>${esc(j.tool)}</td><td><span class="badge ${{ ok: 'badge-ok', dry_run: 'badge-accent', error: 'badge-bad', blocked: 'badge-warn' }[j.status] || 'badge-muted'}">${esc(j.status)}</span>${j.error ? ` <span class="sub">${esc(j.error)}</span>` : ''}</td><td class="sub">${ago(j.ts)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No journal entries</div>'}`;
      wireHistoryTab();
    }
    wireFetchButtons();
  };

  /* ── Software inventory — full observation, searchable + sortable ───── */
  const renderSoftware = async () => {
    const swBox = $('#sw-inventory');
    if (!swBox?.dataset.obs) return;
    const obs = (await api(`/api/v1/observations/${swBox.dataset.obs}?detail=full`)).observation;
    const items = obs?.payload?.items ?? [];
    const hasInstallDate = items.some((i) => i.installedAt ?? i.installDate);
    const st = { q: '', page: 1, pageSize: 25, group: 'all', sort: 'name', dir: 1 };
    const dateOf = (i) => i.installedAt ?? i.installDate ?? null;
    const filtered = () => {
      let rows = st.group === 'apps' ? items.filter((i) => !isComponent(i)) : st.group === 'comps' ? items.filter(isComponent) : items;
      if (st.q) rows = rows.filter((i) => JSON.stringify(i).toLowerCase().includes(st.q.toLowerCase()));
      const key = { name: 'name', publisher: 'publisher', version: 'version', installed: null }[st.sort];
      rows = [...rows].sort((a, b) => {
        const av = st.sort === 'installed' ? (dateOf(a) ?? 0) : String(a[key] ?? '');
        const bv = st.sort === 'installed' ? (dateOf(b) ?? 0) : String(b[key] ?? '');
        return st.dir * (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv)));
      });
      return rows;
    };
    const renderSw = () => {
      const rows = filtered();
      const pages = Math.max(1, Math.ceil(rows.length / st.pageSize));
      const slice = rows.slice((st.page - 1) * st.pageSize, st.page * st.pageSize);
      const th = (key, label) => `<th class="sortable" data-sw-sort="${key}" tabindex="0">${label}${st.sort === key ? (st.dir === 1 ? ' ▲' : ' ▼') : ''}</th>`;
      swBox.innerHTML = `
        <div class="toolbar">
          <input type="search" id="sw-q" placeholder="Search all items…" value="${esc(st.q)}" />
          <div class="seg" role="radiogroup" aria-label="Item group">
            ${[['all', 'All'], ['apps', 'Applications'], ['comps', 'Components']].map(([g, l]) =>
              `<button class="seg-btn" data-sw-group="${g}" role="radio" aria-checked="${st.group === g}">${l}</button>`).join('')}
          </div>
          ${st.q || st.group !== 'all' ? '<button class="btn-mini" id="sw-clear">Clear filters</button>' : ''}
          <span class="sub">${rows.length} shown · ${items.length} total${obs.completeness !== 'complete' ? ` · ${esc(obs.completeness)} — not the full inventory` : ''}</span>
        </div>
        ${slice.length ? `<table class="data"><thead><tr>${th('name', 'Name')}${th('publisher', 'Publisher')}${th('version', 'Version')}${hasInstallDate ? th('installed', 'Installed') : ''}</tr></thead><tbody>
          ${slice.map((i, ix) => `<tr data-sw-row="${ix}" title="Right-click for actions"><td>${esc(i.name ?? '—')}${isComponent(i) ? ' <span class="sub">·component</span>' : ''}</td>
            <td class="sub">${esc(i.publisher ?? '—')}</td><td class="sub">${esc(i.version ?? '—')}</td>
            ${hasInstallDate ? `<td class="sub">${fmtTs(dateOf(i))}</td>` : ''}</tr>`).join('')}
        </tbody></table>` : `<div class="empty">No items match — ${st.q ? 'search is local to this inventory' : 'adjust the group filter'}</div>`}
        <div class="pager">
          <button id="sw-prev" ${st.page <= 1 ? 'disabled' : ''}>← Prev</button>
          <span>Page ${st.page} / ${pages} · ${rows.length} item(s)</span>
          <button id="sw-next" ${st.page >= pages ? 'disabled' : ''}>Next →</button>
        </div>`;
      let deb;
      $('#sw-q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value; st.page = 1; renderSw(); }, 250); });
      swBox.querySelectorAll('[data-sw-group]').forEach((b) => b.addEventListener('click', () => { st.group = b.dataset.swGroup; st.page = 1; renderSw(); }));
      swBox.querySelectorAll('[data-sw-sort]').forEach((h) => {
        const go = () => { if (st.sort === h.dataset.swSort) st.dir *= -1; else { st.sort = h.dataset.swSort; st.dir = 1; } st.page = 1; renderSw(); };
        h.addEventListener('click', go); h.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      });
      $('#sw-clear')?.addEventListener('click', () => { st.q = ''; st.group = 'all'; st.page = 1; renderSw(); });
      $('#sw-prev')?.addEventListener('click', () => { st.page--; renderSw(); });
      $('#sw-next')?.addEventListener('click', () => { st.page++; renderSw(); });
      // Right-click → silent-uninstall action. Routes into the drawer's
      // plan → approve → execute flow; nothing runs without approval.
      const isCommand = state.meta?.principal?.profile === 'command';
      swBox.querySelectorAll('[data-sw-row]').forEach((tr) =>
        tr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const item = slice[Number(tr.dataset.swRow)];
          showCtxMenu(e.clientX, e.clientY, [{
            label: isCommand ? `Uninstall "${item.name ?? ''}" silently…` : 'Uninstall silently (command profile only)',
            disabled: !isCommand,
            hint: isCommand ? 'Creates a plan — you review and approve before anything runs' : 'This server is running the read-only reporting profile',
            onClick: () => ctx.openDeviceDrawer(id, { psPrefill: { runbookId: 'maint/uninstall-software', runbookParams: { displayName: item.name ?? '' } } }),
          }]);
        }));
    };
    renderSw();
  };

  /* ── History-tab wiring ─────────────────────────────────────────────── */
  const wireHistoryTab = () => {
    body.querySelectorAll('[data-view-snap]').forEach((b) =>
      b.addEventListener('click', () => { state.deviceSnapId = b.dataset.viewSnap; ctx.nav(); }));
    $('#dp-compare-base')?.addEventListener('change', async (e) => {
      const baseId = e.target.value;
      const box = $('#dp-diff');
      if (!baseId || !selId) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="sub">Comparing…</div>';
      try {
        const { comparison } = await api('/api/v1/compare', {
          method: 'POST', body: JSON.stringify({ baselineId: baseId, comparisonId: selId }),
        });
        box.innerHTML = `<div class="section-title">Baseline ${fmtTs(comparison.baselineSealedAt)} → selected ${fmtTs(comparison.comparisonSealedAt)}
            ${comparison.cached ? '<span class="badge badge-muted">cached</span>' : ''}</div>
          ${comparisonHtml(comparison)}`;
      } catch (e2) { box.innerHTML = `<div class="empty">Compare failed: ${esc(e2.message)}</div>`; }
    });
  };

  /* Per-resource Fetch/Refresh — collects just that resource; other
     resources on the NEXT snapshot link prior observations as 'reused'. */
  const wireFetchButtons = () => {
    body.querySelectorAll('[data-dp-fetch]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const type = btn.dataset.dpFetch;
        btn.disabled = true; btn.textContent = 'Collecting…';
        try {
          await api(`/api/v1/devices/${id}/capture`, { method: 'POST', body: JSON.stringify({ resources: [type] }) });
          state.deviceSnapId = null; // show the fresh snapshot
        } catch (e) { toast(`Fetch failed: ${e.message}`); }
        ctx.nav();
      }));
  };

  /* ── Chrome wiring ──────────────────────────────────────────────────── */
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.deviceTab = b.dataset.tab;
    ctx.nav(); // hash carries tab → addressable + back/forward works
  }));
  $('#dp-latest')?.addEventListener('click', () => { state.deviceSnapId = null; ctx.nav(); });
  $('#dp-collect').addEventListener('click', async () => {
    $('#dp-collect').textContent = 'Collecting…';
    try {
      await api(`/api/v1/devices/${id}/capture`, { method: 'POST', body: JSON.stringify({ profile: 'standard' }) });
      state.deviceSnapId = null;
    } catch (e) { toast(`Capture failed: ${e.message}`); }
    ctx.nav();
  });
  $('#dp-snap')?.addEventListener('change', () => { state.deviceSnapId = $('#dp-snap').value; ctx.nav(); });

  await renderTab();
}
