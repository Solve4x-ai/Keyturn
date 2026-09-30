/* Component gallery — fixture-only rendering of the shared component
   vocabulary. NO api() calls: everything below is synthetic so states can
   be reviewed without a tenant. Route: #/gallery */

import { esc, fmtTs } from './core.js';
import {
  resBadge, staleBadge, glanceHtml, previewLine, kvOf, patchBuckets,
  comparisonHtml, completenessBadge,
} from './components.js';

const h = Date.now();
const fixtureRes = {
  available: { state: 'collected', collection_status: 'succeeded', item_count: 4, fetched_at: h - 3 * 60e3, source_observed_at: h - 4 * 60e3, completeness: 'complete' },
  stale: { state: 'reused', collection_status: 'succeeded', item_count: 12, fetched_at: h - 40 * 3600e3, source_observed_at: h - 41 * 3600e3, completeness: 'complete' },
  partial: { state: 'collected', collection_status: 'succeeded', item_count: 88, fetched_at: h - 10 * 60e3, completeness: 'partial', safe_error: 'truncated at source page limit' },
  forbidden: { state: 'collected', collection_status: 'forbidden', fetched_at: h - 2 * 60e3, safe_error: 'HTTP 403 — token lacks scope' },
  failed: { state: 'failed', collection_status: 'failed', fetched_at: h - 2 * 60e3, safe_error: 'upstream timeout after 30s' },
  unsupported: { state: 'collected', collection_status: 'unsupported', fetched_at: h - 2 * 60e3 },
};

const fixtureComparison = {
  counts: { changed: 2, meaningfulChanged: 1, unchanged: 2, not_comparable: 1 },
  resources: [
    { resource: 'network', status: 'changed', meaningful: true, detail: { fields: [{ field: 'interfaces[0].ipAddress', before: '10.0.0.4', after: '10.0.0.9' }] } },
    { resource: 'identity', status: 'changed', meaningful: false, detail: { fields: [{ field: 'lastContact', before: 1730000000, after: 1730003600 }] } },
    { resource: 'storage', status: 'unchanged', detail: {} },
    { resource: 'alerts', status: 'unchanged', detail: { schemaDelta: { onlyInComparison: ['conditionHealthStatus'], onlyInBaseline: [] } } },
    { resource: 'software_patch_state', status: 'not_comparable', reason: 'missing in baseline', detail: {} },
  ],
};

const fixtureByType = new Map([
  ['identity', { ...fixtureRes.available, preview: { os: { name: 'Windows 11 Pro 23H2' } } }],
  ['network', { ...fixtureRes.stale, preview: { ipAddresses: ['10.0.0.9'], interfaces: [{}, {}] } }],
  ['last_user', { ...fixtureRes.available, preview: { items: [{ userName: 'ACME\\avery.long.username@contoso.example.com' }] } }],
  ['policy_assignment', { ...fixtureRes.partial, preview: { observedName: 'Workstation — Standard [Policy with an unusually long display name]' } }],
]);

export function galleryView(el) {
  el.innerHTML = `
    <h2>Component gallery</h2>
    <p class="sub">Fixture-only — no tenant calls. Toggle theme/accent/density from Appearance to verify states in both themes.</p>

    <div class="gallery-group"><h3>Status badges (collection-state machine)</h3>
      <div class="gallery-row">
        ${resBadge(fixtureRes.available)} ${resBadge(null)} ${resBadge(fixtureRes.stale)}
        ${resBadge(fixtureRes.partial)} ${resBadge(fixtureRes.forbidden)} ${resBadge(fixtureRes.failed)}
        ${resBadge(fixtureRes.unsupported)} ${resBadge(null, { collecting: true })}
        ${staleBadge(fixtureRes.stale)} ${completenessBadge(fixtureRes.partial)}
      </div>
    </div>

    <div class="gallery-group"><h3>Buttons &amp; controls</h3>
      <div class="gallery-row">
        <button class="btn">Primary</button>
        <button class="btn secondary">Secondary</button>
        <button class="btn ghost">Ghost</button>
        <button class="btn-mini">Mini action</button>
        <button class="btn" disabled>Disabled</button>
      </div>
      <div class="gallery-row">
        <input type="search" placeholder="Search field…" />
        <select><option>Select control</option></select>
        <div class="seg"><button class="seg-btn" aria-checked="true">One</button><button class="seg-btn" aria-checked="false">Two</button></div>
      </div>
    </div>

    <div class="gallery-group"><h3>At-a-glance strip (fixture)</h3>
      ${glanceHtml(fixtureByType)}
    </div>

    <div class="gallery-group"><h3>Resource cards — difficult states</h3>
      <div class="snap-cards">
        ${['network', 'last_user', 'policy_assignment', 'software_inventory', 'os_patch_state', 'alerts'].map((t, i) => {
          const r = [fixtureRes.available, fixtureRes.stale, fixtureRes.partial, fixtureRes.forbidden, fixtureRes.failed, null][i];
          return `<div class="snap-card"><div class="snap-card-head"><strong>${esc(t)}</strong>
            ${resBadge(r)} ${completenessBadge(r)} ${staleBadge(r)}
            <span style="margin-left:auto"><button class="btn-mini">${r ? 'Refresh' : 'Fetch'}</button></span></div>
            <div class="sub snap-preview">${previewLine(t, { ...r, preview: fixtureByType.get(t)?.preview ?? r?.preview })}</div>
            <div class="sub">${r?.safe_error ? esc(r.safe_error) : r ? `fetched ${fmtTs(r.fetched_at)}` : '—'}</div></div>`;
        }).join('')}
      </div>
    </div>

    <div class="gallery-group"><h3>Table + key/value</h3>
      <div class="gallery-row" style="align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <table class="data"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>
            <tr><td>normal row</td><td class="sub">value</td></tr>
            <tr><td>${esc('a very long device-name-that-should-truncate-or-wrap-gracefully-WIN-EXAMPLE-01')}</td><td class="sub">long</td></tr>
            <tr><td>null field</td><td class="sub">${esc(null)}</td></tr>
          </tbody></table>
        </div>
        <div style="flex:1;min-width:280px">${kvOf({ 'System name': 'S4X-FIXTURE', 'DNS name': null, ID: 42 })}</div>
      </div>
    </div>

    <div class="gallery-group"><h3>Patch buckets + comparison rows</h3>
      ${patchBuckets({ preview: { total: 3, items: [{ status: 'Approved' }, { status: 'Approved' }, { status: 'Pending' }] } })}
      <div class="gallery-frame">${comparisonHtml(fixtureComparison)}</div>
    </div>

    <div class="gallery-group"><h3>Tabs + banners + evidence item</h3>
      <div class="dtabs" role="tablist"><button class="dtab active" role="tab" aria-selected="true">Active tab</button><button class="dtab" role="tab" aria-selected="false">Inactive</button></div>
      <div class="banner">Info banner — non-destructive notice.</div>
      <div class="banner-warn">Warning banner — historical snapshot context.</div>
      <div class="error-box">Error box — distinct unavailable state.</div>
      <div class="evidence-item"><span class="badge badge-accent">HISTORICAL EVIDENCE</span> <strong>Pinned snapshot</strong>
        <div class="sub">pinned ${fmtTs(h - 3600e3)} · data observed ${fmtTs(h - 3700e3)}</div></div>
    </div>`;
}
