/* Device + organization inspector (right-side panel).
   Nonmodal on ≥1100px viewports (no dim backdrop — the table stays usable
   alongside it); modal presentation below that. Escape always closes and
   focus returns to the opener. Opening the drawer never triggers upstream
   collection — everything shown is local data (§9). */

import { api, state, $, esc, ago, fmtTs, fmtBool, toast, ctx } from './core.js';
import {
  RESOURCE_LABELS, STANDARD_RESOURCES, resBadge, staleBadge, glanceHtml,
  previewLine, comparisonHtml, completenessBadge,
} from './components.js';

let drawerOpener = null;
const narrowMq = matchMedia('(max-width: 1099px)');

export function openDrawer(title, html) {
  drawerOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#drawer-title').innerHTML = title;
  $('#drawer-body').innerHTML = html;
  const drawer = $('#drawer');
  // aria-modal reflects actual presentation: modal only when the backdrop
  // is rendered (narrow screens).
  drawer.setAttribute('aria-modal', narrowMq.matches ? 'true' : 'false');
  drawer.hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer-close').focus();
}

export function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  drawerOpener?.focus?.();
  drawerOpener = null;
}

export function drawerIsOpen() { return !$('#drawer').hidden; }

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerIsOpen()) closeDrawer(); });
narrowMq.addEventListener('change', () => {
  if (drawerIsOpen()) $('#drawer').setAttribute('aria-modal', narrowMq.matches ? 'true' : 'false');
});

export function openEntityDrawer(entityType, entityId) {
  if (entityId === null || entityId === undefined) return;
  if (entityType === 'device') return openDeviceDrawer(entityId);
  if (entityType === 'organization') { location.hash = `#/org/${entityId}`; return; }
  toast(`No drawer for ${entityType} entities yet`);
}

export async function openOrgDrawer(id) {
  const d = await api(`/api/v1/organizations/${id}`);
  if (!d.org) return toast('Organization not found in local inventory');
  const org = d.org;
  const kv = [
    ['Name', org.name], ['ID', org.org_id], ['Description', org.description ?? '—'],
    ['Devices (local)', d.deviceCount], ['Offline', d.offlineCount],
  ];
  const changesHtml = d.changes.length
    ? `<table class="data"><tbody>${d.changes.map((c) =>
        `<tr><td>${esc(c.field)}</td><td>${esc(`${c.old_value ?? '∅'} → ${c.new_value ?? '∅'}`)}</td><td class="sub">${fmtTs(c.detected_at)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No recorded changes</div>';
  openDrawer(esc(org.name || `Organization ${id}`), `
    <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <button class="btn secondary" id="org-devices">View devices</button>
    <div class="section-title">Changes (local history)</div>${changesHtml}
  `);
  $('#org-devices').addEventListener('click', () => {
    closeDrawer();
    state.view = 'devices'; state.orgId = org.org_id; state.offline = null; state.q = ''; state.page = 1;
    ctx.render();
  });
}

export async function openDeviceDrawer(id, opts = {}) {
  const d = await api(`/api/v1/devices/${id}`);
  if (!d.device) return toast('Device not found in local inventory');
  const dev = d.device;
  const kv = [
    ['System name', dev.system_name], ['Display name', dev.display_name], ['DNS name', dev.dns_name],
    ['ID', dev.device_id], ['Organization', `${d.orgName ?? '—'} (${dev.org_id ?? '—'})`],
    ['Node class', dev.node_class],
    // Endpoint status is the device's own report — separate from app
    // connectivity (header) and data freshness (sync age).
    ['Reported status', dev.offline ? 'offline' : 'online'],
    ['Last contact', fmtTs(dev.last_contact)], ['Seen in local cache', fmtTs(dev.seen_at)],
  ];
  // Meaningful changes exclude routine last_contact check-ins; the tick count
  // stays visible so the suppression is honest.
  const meaningful = d.changes.filter((c) => c.field !== 'last_contact');
  const tickCount = d.changes.length - meaningful.length;
  const changesHtml = meaningful.length
    ? `<table class="data"><tbody>${meaningful.map((c) =>
        `<tr><td>${esc(c.field === '__appeared__' ? 'First observed locally' : c.field)}</td><td>${esc(`${c.old_value ?? '∅'} → ${c.new_value ?? '∅'}`)}</td><td class="sub">${fmtTs(c.detected_at)}</td></tr>`).join('')}</tbody></table>`
      + (tickCount ? `<div class="sub" style="margin-top:6px">${tickCount} routine check-in(s) hidden — last_contact ticks are normal</div>` : '')
    : '<div class="empty">No recorded changes</div>'
      + (tickCount ? `<div class="sub" style="margin-top:6px">${tickCount} routine check-in(s) hidden</div>` : '');
  const isCommand = state.meta?.principal?.profile === 'command';
  const runSection = isCommand ? `
    <div class="section-title">Run PowerShell <span class="badge badge-warn">requires approval</span></div>
    ${opts.psPrefill ? '<div class="banner">Pre-filled from the software inventory — the reviewed runbook is selected below; check params, then Plan → Approve &amp; execute.</div>' : ''}
    <div class="toolbar">
      <select id="rb-select"><option value="">Reviewed runbook…</option></select>
      <span class="sub">or a custom command below</span>
    </div>
    <div id="rb-params"></div>
    <div id="rb-plan-card"></div>
    <div class="toolbar" style="align-items:flex-start">
      <textarea id="ps-cmd" style="flex:1;min-height:64px" placeholder="PowerShell command…">${esc(opts.psPrefill?.command ?? 'ipconfig')}</textarea>
      <input type="text" id="ps-timeout" value="${esc(opts.psPrefill?.timeoutSeconds ?? 120)}" style="width:70px" title="Timeout seconds (1-900)" />
      <button class="btn" id="ps-plan">Plan</button>
    </div>
    <div id="ps-plan-card"></div>
    <div id="ps-pending"></div>
    <div id="ps-receipt"></div>` : '';

  openDrawer(esc(dev.display_name || dev.system_name || `Device ${id}`), `
    <div class="dev-head">
      <span class="badge ${dev.offline ? 'badge-bad' : 'badge-ok'}">${dev.offline ? 'offline' : 'online'}</span>
      <span class="sub">${esc(d.orgName ?? '—')} · last contact ${fmtTs(dev.last_contact)}</span>
      <button class="btn secondary" id="open-details" style="margin-left:auto">Open device details</button>
    </div>
    <div id="glance"></div>
    <div class="section-title">Collection</div>
    <div class="toolbar">
      <button class="btn" id="snap-collect">Collect device details</button>
      <select id="snap-profile" title="Collection scope">
        <option value="quick">quick — identity, network, user, policy</option>
        <option value="standard" selected>standard — + software, patches, storage, alerts</option>
        <option value="full">full — + patch install history</option>
      </select>
    </div>
    <div class="toolbar">
      <select id="snap-select"><option value="">latest snapshot</option></select>
      <span id="snap-age" class="sub"></span>
      <select id="snap-compare-to" hidden><option value="">baseline…</option></select>
      <button class="btn secondary" id="snap-compare" disabled title="Needs two snapshots">Compare</button>
    </div>
    <div id="snap-banner"></div>
    <div id="snap-cards"></div>
    <div id="snap-diff"></div>
    <details class="identity-details"><summary>Identity details</summary>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </details>
    ${runSection}
    <div class="section-title">Changes (local history)</div>${changesHtml}
    <div class="section-title">Journal (operations on this device)</div>
    ${d.journal.length ? `<table class="data"><tbody>${d.journal.map((j) =>
      `<tr><td>${esc(j.tool)}</td><td><span class="badge ${{ ok: 'badge-ok', dry_run: 'badge-accent', error: 'badge-bad', blocked: 'badge-warn' }[j.status] || 'badge-muted'}">${esc(j.status)}</span>${j.error ? ` <span class="sub">${esc(j.error)}</span>` : ''}</td><td class="sub">${ago(j.ts)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No journal entries</div>'}
  `);
  $('#open-details').addEventListener('click', () => {
    closeDrawer();
    state.view = 'device'; state.deviceId = dev.device_id;
    // Carry the snapshot being viewed so the details page opens on the same
    // sealed version the user had selected in the drawer.
    state.deviceSnapId = snapState.selected?.id ?? null;
    ctx.nav();
  });
  if (isCommand) {
    let plan = null;
    let approval = null;
    // Pending plans queue — stdio clients (e.g. Codex) land here for the
    // human to approve; approving opens a bounded session for this device.
    const renderPending = async () => {
      const box = $('#ps-pending');
      if (!box) return;
      const { plans } = await api('/api/v1/plans');
      const pending = plans.filter((p) => p.target_id === dev.device_id && !p.approval_id);
      box.innerHTML = pending.length
        ? `<div class="section-title">Pending approval <span class="badge badge-warn">${pending.length}</span></div>` +
          pending.map((p) => `
            <div class="evidence-item">
              <div class="sub">from ${esc(p.principal || 'unknown')} · expires ${fmtTs(p.expires_at)}</div>
              <dl class="kv" style="margin:8px 0">
                ${p.operation === 'set_health_status'
                  ? `<dt>health</dt><dd class="mono-val">${esc(p.args?.field)} → ${esc(p.args?.status)}</dd><dt>note</dt><dd>${esc(p.args?.description || '—')}</dd>`
                  : `<dt>command</dt><dd><pre class="term">${esc(p.args?.command ?? '')}</pre></dd><dt>timeout</dt><dd>${esc(p.args?.timeoutSeconds ?? 120)}s</dd>`}
                <dt>hash</dt><dd class="sub">${esc(String(p.plan_hash || '').slice(0, 24))}…</dd>
              </dl>
              <button class="btn" data-approve-plan="${p.id}">Approve &amp; execute</button>
            </div>`).join('')
        : '';
      box.querySelectorAll('[data-approve-plan]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          btn.disabled = true; btn.textContent = 'Dispatching…';
          const ap = await api(`/api/v1/plans/${btn.dataset.approvePlan}/approve`, { method: 'POST', body: '{}' });
          const op = await api(`/api/v1/plans/${btn.dataset.approvePlan}/execute`, { method: 'POST', body: JSON.stringify({ approvalId: ap.id }) });
          renderReceipt(op);
          renderPending();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Approve & execute';
          box.innerHTML += `<div class="error-box">${esc(e.message)}</div>`;
        }
      }));
    };
    renderPending().catch(() => {});

    // Runbook picker — reviewed scripts, params bound server-side as data.
    const rbSel = $('#rb-select');
    api('/api/v1/runbooks').then(({ runbooks }) => {
      rbSel.innerHTML = '<option value="">Reviewed runbook…</option>' +
        (runbooks || []).map((r) => `<option value="${esc(r.id)}">${esc(r.title)} <span class="sub">(${esc(r.id)} v${r.version})</span></option>`).join('');
      // Context-menu entry points (e.g. right-click → uninstall) pre-select
      // the reviewed runbook and pre-fill its params.
      if (opts.psPrefill?.runbookId) {
        rbSel.value = opts.psPrefill.runbookId;
        rbSel.dispatchEvent(new Event('change'));
        const wanted = opts.psPrefill.runbookParams || {};
        setTimeout(() => {
          document.querySelectorAll('#rb-params [data-rb-param]').forEach((inp) => {
            const v = wanted[inp.dataset.rbParam];
            if (v !== undefined && v !== null) inp.value = String(v);
          });
        }, 50);
      }
    }).catch(() => {});
    rbSel.addEventListener('change', async () => {
      const paramsBox = $('#rb-params');
      const cardBox = $('#rb-plan-card');
      paramsBox.innerHTML = ''; cardBox.innerHTML = '';
      if (!rbSel.value) return;
      const { runbook: rb } = await api(`/api/v1/runbooks/${encodeURIComponent(rbSel.value)}`);
      const inputs = Object.entries(rb.params || {}).map(([name, p]) => {
        const req = p.required ? ' <span class="badge badge-warn">required</span>' : '';
        const control = p.type === 'enum'
          ? `<select data-rb-param="${esc(name)}">${(p.enum || []).map((v) => `<option ${v === p.default ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
          : p.type === 'boolean'
            ? `<select data-rb-param="${esc(name)}"><option value="">(default)</option><option value="true">true</option><option value="false">false</option></select>`
            : `<input type="${p.type === 'integer' ? 'number' : 'text'}" data-rb-param="${esc(name)}" placeholder="${esc(p.default !== undefined ? String(p.default) : '')}" />`;
        return `<div class="toolbar" style="align-items:center"><label style="min-width:150px" class="sub">${esc(name)}${req}</label>${control}<span class="sub">${esc(p.description || '')}</span></div>`;
      }).join('');
      paramsBox.innerHTML = `
        <div class="sub" style="margin:4px 0">${esc(rb.purpose)} — ${esc(rb.classification)} · ${esc(rb.disruption)}</div>
        ${inputs}<div class="toolbar"><button class="btn" id="rb-plan">Create plan</button></div>`;
      $('#rb-plan').addEventListener('click', async () => {
        try {
          const params = {};
          paramsBox.querySelectorAll('[data-rb-param]').forEach((inp) => {
            if (inp.value !== '') params[inp.dataset.rbParam] = inp.type === 'number' ? Number(inp.value) : inp.type === 'select-one' && (inp.value === 'true' || inp.value === 'false') ? inp.value === 'true' : inp.value;
          });
          const plan = await api('/api/v1/plans', {
            method: 'POST',
            body: JSON.stringify({ operation: 'run_device_powershell', targetType: 'device', targetId: dev.device_id, args: { runbookId: rb.id, runbookVersion: rb.version, params } }),
          });
          cardBox.innerHTML = `
            <div class="evidence-item">
              <div class="sub">immutable plan · ${esc(rb.id)} v${rb.version} · expires ${fmtTs(plan.expiresAt)}</div>
              <details class="identity-details"><summary>Resolved script (params bound as data)</summary><pre class="term">${esc(plan.args?.command ?? '')}</pre></details>
              <button class="btn" id="rb-approve">Approve &amp; execute</button>
            </div>`;
          $('#rb-approve').addEventListener('click', async () => {
            try {
              $('#rb-approve').disabled = true; $('#rb-approve').textContent = 'Dispatching…';
              const ap = await api(`/api/v1/plans/${plan.id}/approve`, { method: 'POST', body: '{}' });
              const op = await api(`/api/v1/plans/${plan.id}/execute`, { method: 'POST', body: JSON.stringify({ approvalId: ap.id }) });
              renderReceipt(op, dev.device_id);
              cardBox.innerHTML += `<div class="sub">Operation <a href="#/operation/${esc(op.id)}">${esc(String(op.id).slice(0, 8))}…</a> dispatched</div>`;
            } catch (e) { cardBox.innerHTML += `<div class="error-box">${esc(e.message)}</div>`; }
          });
        } catch (e) { cardBox.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
      });
    });

    $('#ps-plan').addEventListener('click', async () => {
      try {
        const command = $('#ps-cmd').value.trim();
        const timeoutSeconds = Number($('#ps-timeout').value) || 120;
        plan = await api('/api/v1/plans', {
          method: 'POST',
          body: JSON.stringify({ operation: 'run_device_powershell', targetType: 'device', targetId: dev.device_id, args: { command, timeoutSeconds } }),
        });
        $('#ps-plan-card').innerHTML = `
          <div class="evidence-item">
            <div class="sub">immutable plan · expires ${fmtTs(plan.expiresAt)}</div>
            <dl class="kv" style="margin:8px 0">
              <dt>operation</dt><dd>${esc(plan.operation)}</dd>
              <dt>target</dt><dd>${esc(plan.targetType)} ${plan.targetId} — ${esc(dev.display_name || dev.system_name)}</dd>
              <dt>command</dt><dd>${esc(command)}</dd>
              <dt>timeout</dt><dd>${plan.args.timeoutSeconds}s</dd>
              <dt>hash</dt><dd class="sub">${esc(plan.planHash.slice(0, 24))}…</dd>
            </dl>
            <button class="btn" id="ps-approve">Approve &amp; execute</button>
          </div>`;
        $('#ps-approve').addEventListener('click', async () => {
          try {
            approval = await api(`/api/v1/plans/${plan.id}/approve`, { method: 'POST', body: '{}' });
            $('#ps-approve').disabled = true;
            $('#ps-approve').textContent = 'Dispatching…';
            const op = await api(`/api/v1/plans/${plan.id}/execute`, { method: 'POST', body: JSON.stringify({ approvalId: approval.id }) });
            renderReceipt(op, dev.device_id);
          } catch (e) {
            $('#ps-plan-card').innerHTML += `<div class="error-box">${esc(e.message)}</div>`;
          }
        });
      } catch (e) {
        $('#ps-plan-card').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      }
    });
  }

  // ── Snapshots ──────────────────────────────────────────────────────────
  // Cached drawer data renders instantly; collection fires only on explicit
  // clicks — opening the drawer never triggers upstream fan-out (§9).
  const snapState = { list: [], selected: null, latest: null, collecting: new Set() };

  const renderSnapCards = (snap) => {
    const isHistorical = snapState.latest && snap.id !== snapState.latest.id;
    $('#snap-banner').innerHTML = isHistorical
      ? `<div class="banner-warn">Viewing snapshot assembled ${fmtTs(snap.sealed_at)} — historical evidence, not current state. Refresh creates a new snapshot.</div>`
      : '';
    const byType = new Map((snap?.resources || []).map((r) => [r.resource_type, r]));
    $('#glance').innerHTML = glanceHtml(byType);
    $('#snap-cards').innerHTML = STANDARD_RESOURCES.map((type) => {
      const r = byType.get(type);
      const collecting = snapState.collecting.has(type);
      return `
      <div class="snap-card" data-res="${type}">
        <div class="snap-card-head">
          <strong>${esc(RESOURCE_LABELS[type] ?? type)}</strong>
          ${resBadge(r, { collecting })}
          ${completenessBadge(r)}
          ${staleBadge(r)}
          <span style="margin-left:auto">
            <button class="btn-mini" data-fetch="${type}" ${collecting ? 'disabled' : ''}>${r ? 'Refresh' : 'Fetch'}</button>
          </span>
        </div>
        ${collecting ? '<div class="sub">Collection in progress…</div>' : `
          <div class="sub snap-preview">${previewLine(type, r)}</div>
          <div class="sub">
            ${r?.item_count != null ? `${r.item_count} item(s) · ` : ''}
            ${r ? `fetched ${r.fetched_at ? ago(r.fetched_at) : '—'}` : ''}
            ${r?.source_observed_at ? ` · source observed ${ago(r.source_observed_at)}` : r ? ' · source time n/a' : ''}
            ${r?.safe_error ? ` · ${esc(r.safe_error)}` : ''}
            ${r?.state === 'reused' ? ` · referenced from earlier observation` : ''}
          </div>`}
      </div>`;
    }).join('');
    $('#snap-cards').querySelectorAll('[data-fetch]').forEach((btn) =>
      btn.addEventListener('click', () => collectResources([btn.dataset.fetch])));
  };

  const renderSelect = () => {
    $('#snap-select').innerHTML =
      `<option value="">latest snapshot</option>` +
      snapState.list.map((s) => `<option value="${s.id}" ${snapState.selected?.id === s.id ? 'selected' : ''}>${fmtTs(s.sealed_at)} · ${esc(s.profile)} · ${esc(s.reason)}</option>`).join('');
    $('#snap-age').textContent = snapState.selected ? `sealed ${ago(snapState.selected.sealed_at)}` : '';
    const canCompare = snapState.list.length >= 2 && snapState.selected;
    const cmpBtn = $('#snap-compare');
    cmpBtn.disabled = !canCompare;
    cmpBtn.title = canCompare ? 'Compare selected snapshot to a baseline' : 'Needs two snapshots to compare';

  };

  const loadSnapshots = async () => {
    const data = await api(`/api/v1/devices/${id}/snapshots?limit=20`);
    snapState.list = data.snapshots || [];
    snapState.latest = snapState.list[0] ?? null;
    if (snapState.latest && !snapState.selected) {
      const detail = await api(`/api/v1/snapshots/${snapState.latest.id}`);
      snapState.selected = detail.snapshot;
    } else if (snapState.selected) {
      const still = snapState.list.find((s) => s.id === snapState.selected.id);
      if (!still) snapState.selected = snapState.latest;
      if (snapState.selected) {
        const detail = await api(`/api/v1/snapshots/${snapState.selected.id}`);
        snapState.selected = detail.snapshot;
      }
    }
    renderSelect();
    renderSnapCards(snapState.selected);
  };

  const collectResources = async (resources) => {
    const body = resources ? { resources } : { profile: $('#snap-profile').value };
    const label = resources ? resources : ['__all__'];
    label.forEach((t) => snapState.collecting.add(t));
    if (!resources) $('#snap-collect').textContent = 'Collecting…';
    else renderSnapCards(snapState.selected);
    try {
      const r = await api(`/api/v1/devices/${id}/capture`, { method: 'POST', body: JSON.stringify(body) });
      snapState.selected = null; // show the fresh snapshot
      await loadSnapshots();
      if (r.coverage?.status && r.coverage.status !== 'completed') {
        toast(`Capture ${r.coverage.status} — some resources unavailable`);
      }
    } catch (e) {
      toast(`Capture failed: ${e.message}`);
    } finally {
      label.forEach((t) => snapState.collecting.delete(t));
      $('#snap-collect').textContent = 'Collect device details';
      renderSnapCards(snapState.selected);
    }
  };

  $('#snap-collect').addEventListener('click', () => collectResources(null));

  $('#snap-select').addEventListener('change', async (e) => {
    const sid = e.target.value || snapState.latest?.id;
    if (!sid) return;
    const detail = await api(`/api/v1/snapshots/${sid}`);
    snapState.selected = detail.snapshot;
    renderSelect();
    renderSnapCards(detail.snapshot);
  });

  $('#snap-compare').addEventListener('click', async () => {
    const sel = $('#snap-compare-to');
    if (sel.hidden) {
      sel.innerHTML = '<option value="">baseline…</option>' +
        snapState.list.filter((s) => s.id !== snapState.selected?.id)
          .map((s) => `<option value="${s.id}">${fmtTs(s.sealed_at)} · ${esc(s.profile)}</option>`).join('');
      sel.hidden = false;
      return;
    }
    const baselineId = sel.value;
    if (!baselineId || !snapState.selected) return toast('Pick a baseline snapshot');
    $('#snap-diff').innerHTML = '<div class="sub">Comparing…</div>';
    const { comparison } = await api('/api/v1/compare', {
      method: 'POST', body: JSON.stringify({ baselineId, comparisonId: snapState.selected.id }),
    });
    $('#snap-diff').innerHTML = `
      <div class="section-title">Comparison — ${esc(comparison.baselineId.slice(0, 8))} → ${esc(comparison.comparisonId.slice(0, 8))}</div>
      ${comparisonHtml(comparison, { compact: true })}`;
  });

  // Distinct unavailable state — actionable, with a Retry control.
  loadSnapshots().catch((e) => {
    $('#snap-cards').innerHTML = `
      <div class="error-box">
        Snapshot service unavailable — ${esc(e.message)}
        <details><summary>diagnostics</summary><div class="sub">GET /api/v1/devices/${id}/snapshots failed. Check the local server build matches the database schema.</div></details>
        <button class="btn secondary" id="snap-retry">Retry</button>
      </div>`;
    $('#snap-retry')?.addEventListener('click', () => {
      $('#snap-cards').innerHTML = '<div class="sub">Retrying…</div>';
      loadSnapshots().catch(() => { $('#snap-cards').innerHTML = '<div class="error-box">Still unavailable — restart the local server.</div>'; });
    });
  });
}

// Operation receipt — polls the reconcile endpoint until terminal state.
// accepted ≠ verified is shown honestly; unknown stays unknown.
async function renderReceipt(op) {
  const el = $('#ps-receipt');
  if (!el) return;
  const badge = { verified: 'badge-ok', failed: 'badge-bad', accepted: 'badge-accent', dispatching: 'badge-accent', unknown: 'badge-warn' }[op.status] || 'badge-muted';
  el.innerHTML = `
    <div class="section-title">Receipt</div>
    <div class="evidence-item">
      <span class="badge ${badge}">${esc(op.status)}</span>
      <span class="sub">runId ${esc((op.upstream_ref || '').slice(0, 8))}… · ${fmtTs(op.created_at)}</span>
      ${op.result ? `<dl class="kv" style="margin-top:8px">
        <dt>exit code</dt><dd>${esc(op.result.exitCode ?? '—')}</dd>
        ${op.result.stdout !== null && op.result.stdout !== undefined ? `<dt>stdout</dt><dd><pre class="term">${esc(op.result.stdout)}</pre></dd>` : ''}
        ${op.result.stderr ? `<dt>stderr</dt><dd><pre class="term">${esc(op.result.stderr)}</pre></dd>` : ''}
      </dl>` : `<div class="sub" style="margin-top:6px">Accepted upstream — waiting for runner result…</div>`}
      <div class="sub" style="margin-top:6px">${op.events.map((e) => `${e.kind} ${fmtTs(e.at)}`).join(' · ')}</div>
    </div>`;
  if (op.status === 'accepted' || op.status === 'dispatching') {
    setTimeout(async () => {
      if ($('#ps-receipt') !== el || !drawerIsOpen()) return; // drawer closed
      try {
        const next = await api(`/api/v1/operations/${op.id}`);
        renderReceipt(next);
      } catch { /* keep last known state */ }
    }, 5000);
  }
}
