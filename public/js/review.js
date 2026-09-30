// REVIEW-1 — Review Center.
// Route: #/review/<orgId>/<tab> — tabs: inbox | questions | risks |
// improvements | decisions | context. Interpretation and decisions over
// retained evidence — never a queue of alarming claims, and no action here
// executes anything on an endpoint (plan §2/§12).
import { api, state, $, esc, ago, fmtTs, toast, ctx } from './core.js';
import { icon } from './icons.js';
import { pageHeader, statCard } from './components.js';
import { requireOrg } from './scope.js';

const TABS = [
  ['inbox', 'Inbox', 'inbox'],
  ['questions', 'Questions', 'help'],
  ['risks', 'Risks', 'warn'],
  ['improvements', 'Improvements', 'bulb'],
  ['decisions', 'Decisions', 'decide'],
  ['context', 'Context', 'note'],
];

const TYPE_LABEL = { observation: 'Observation', risk: 'Risk', improvement: 'Improvement' };
const DISP_LABEL = {
  none: 'open', investigate: 'investigate', monitor: 'monitor', accept_risk: 'accepted risk',
  pursue_improvement: 'pursue', defer: 'deferred', dismiss: 'dismissed', duplicate: 'duplicate',
  superseded: 'superseded', verified_resolved: 'verified resolved', unverified_closure: 'closed (unverified)',
};

const assessBadge = (a) => {
  switch (a) {
    case 'confirmed': return '<span class="badge badge-ok">confirmed</span>';
    case 'proposed': return '<span class="badge badge-accent">proposed</span>';
    case 'inconclusive': return '<span class="badge badge-warn">inconclusive</span>';
    case 'not_applicable': return '<span class="badge badge-muted">n/a</span>';
    default: return '<span class="badge badge-muted">unassessed</span>';
  }
};

/* ── Questions & answers — human-readable type labels + attribution ── */
const ANSWER_TYPE_LABEL = {
  yes_no_unknown: 'Yes / No / Unknown', text: 'Free text', entity: 'Entity ref', owner: 'Person', date: 'Date',
};
const qStatusBadge = (s) => `<span class="badge ${s === 'answered' ? 'badge-ok' : s === 'needs_clarification' ? 'badge-warn' : 'badge-muted'}">${esc(String(s).replace('_', ' '))}</span>`;
const kindBadge = (k) => {
  const label = { ai: 'AI', human_ui: 'human', harness: 'agent', rule: 'rule', system: 'system' }[k] ?? k ?? '?';
  const cls = k === 'human_ui' ? 'badge-ok' : k === 'ai' || k === 'harness' ? 'badge-accent' : 'badge-muted';
  return `<span class="badge ${cls}" title="who answered">${esc(label)}</span>`;
};
const normBadge = (a) => {
  let n = null;
  try { n = a.normalized_json ? JSON.parse(a.normalized_json) : null; } catch { n = null; }
  const v = n?.value;
  if (!v) return '';
  const cls = v === 'yes' ? 'badge-ok' : v === 'no' ? 'badge-warn' : 'badge-muted';
  return ` <span class="badge ${cls}">${esc(String(v))}</span>`;
};
const answerLine = (a) => `<div class="ans-line">
  <div class="wrap">${esc(a.answer_text)}${normBadge(a)}${a.is_current ? '' : ' <span class="badge badge-warn">superseded/conflicting</span>'}</div>
  <div class="sub">${kindBadge(a.actor_kind)} ${esc(a.actor ?? '—')} ${provBadge(a.provenance)} · ${fmtTs(a.created_at)}</div>
</div>`;
const answerForm = (q) => `
  <div class="ans-form" data-q="${q.id}">
    <input type="text" class="ans-text" placeholder="Write an answer…" />
    <div class="ans-foot">
      <input type="text" class="ans-name" placeholder="your name" title="recorded as who answered" />
      <span class="ans-actions">
        ${q.answer_type === 'yes_no_unknown' ? '<button class="btn-mini ans-quick" data-v="yes">Yes</button><button class="btn-mini ans-quick" data-v="no">No</button><button class="btn-mini ans-quick" data-v="unknown">Unknown</button>' : ''}
        <button class="btn ans-submit">Answer</button>
      </span>
    </div>
  </div>`;
function wireAnswerForms(el, orgId) {
  el.querySelectorAll('.ans-form[data-q]').forEach((f) => {
    const nameEl = f.querySelector('.ans-name');
    nameEl.value = localStorage.getItem('review-answer-name') ?? '';
    const submit = async (quick) => {
      const name = nameEl.value.trim();
      const text = quick ?? f.querySelector('.ans-text').value.trim();
      if (!text) return;
      if (name) localStorage.setItem('review-answer-name', name);
      const m = text.match(/^(yes|no|unknown)\b/i);
      const normalized = m ? { value: m[1].toLowerCase() } : undefined;
      await api(`/api/v1/orgs/${orgId}/review/questions/${f.dataset.q}/answer`, { method: 'POST', body: JSON.stringify({ answer: text, normalized, actor: name || undefined }) });
      toast('Answer recorded');
      ctx.render();
    };
    f.querySelector('.ans-submit').addEventListener('click', () => submit());
    f.querySelectorAll('.ans-quick').forEach((b) => b.addEventListener('click', () => submit(b.dataset.v)));
    f.querySelector('.ans-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}
const wfBadge = (w) => `<span class="badge ${w === 'closed' ? 'badge-muted' : w === 'new' ? 'badge-accent' : 'badge-ok'}">${esc(w.replace('_', ' '))}</span>`;
const rsBadge = (rs) => rs === 'review_due' ? ' <span class="badge badge-warn">review due</span>' : rs === 'reassessment_needed' ? ' <span class="badge badge-warn">reassessment</span>' : '';
const provBadge = (p) => {
  const label = { direct: 'direct', delegated: 'delegated', reported: 'reported', system: 'system' }[p] ?? p;
  return `<span class="badge ${p === 'direct' ? 'badge-ok' : p === 'delegated' ? 'badge-accent' : 'badge-muted'}" title="how this statement reached the record">${esc(label)}</span>`;
};

function tabBar(orgId, active) {
  return `<div class="tabbar" role="tablist">
    ${TABS.map(([k, label, ic]) => `<button class="tab-pill${k === active ? ' active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === active}">${icon(ic)}${label}</button>`).join('')}
  </div>`;
}

function sevBadge(s) {
  if (!s) return '<span class="sub">—</span>';
  const cls = { critical: 'badge-bad', high: 'badge-warn', medium: 'badge-info', low: 'badge-muted' }[s] ?? 'badge-muted';
  return `<span class="badge ${cls}" title="severity: how bad if true">${esc(s)}</span>`;
}
function confBadge(c) {
  if (!c) return '<span class="sub">—</span>';
  const cls = { high: 'badge-ok', medium: 'badge-warn', low: 'badge-muted' }[c] ?? 'badge-muted';
  return `<span class="badge ${cls}" title="confidence: how sure the evidence is">${esc(c)}</span>`;
}

const TYPE_ICON = { risk: 'warn', improvement: 'bulb', observation: 'eye' };
const TYPE_TONE = { risk: 'type-risk', improvement: 'type-imp', observation: 'type-obs' };

function itemRow(i, detailed) {
  return `<tr class="clickable" data-item="${i.id}" tabindex="0">
    <td><span class="type-cell ${TYPE_TONE[i.item_type] ?? 'type-obs'}" title="${esc(TYPE_LABEL[i.item_type] ?? i.item_type)}">${icon(TYPE_ICON[i.item_type] ?? 'eye')}<span class="type-label">${esc(TYPE_LABEL[i.item_type] ?? i.item_type)}</span></span></td>
    <td class="wrap item-cell"><span class="item-name">${esc(i.title)}</span>${i.category ? `<span class="sub">${esc(i.category)}</span>` : ''}</td>
    ${detailed ? `<td>${i.priority_score ? `<span class="badge badge-info" title="severity × confidence">${i.priority_score}</span>` : '<span class="sub">—</span>'}</td>` : ''}
    <td>${sevBadge(i.severity)}</td>
    ${detailed ? `<td>${confBadge(i.confidence)}</td><td>${assessBadge(i.assessment)}</td>` : ''}
    <td>${wfBadge(i.workflow)}</td>
    ${detailed ? `<td><span class="badge ${['accept_risk', 'verified_resolved'].includes(i.disposition) ? 'badge-ok' : i.disposition === 'none' ? 'badge-muted' : 'badge-warn'}">${esc(DISP_LABEL[i.disposition] ?? i.disposition)}</span>${rsBadge(i.review_state)}</td>
    <td class="sub" title="${esc(i.created_by_kind ?? '')}">${esc(i.created_by_kind === 'rule' ? 'rule' : i.created_by_kind ?? '')}</td>` : ''}
    <td class="sub">${ago(i.updated_at)}</td>
    <td class="row-open">${icon('chev-r')}</td>
  </tr>`;
}

async function loadItems(orgId, params = '') {
  const data = await api(`/api/v1/orgs/${orgId}/review/items?limit=200${params}`);
  return data.items || [];
}

function itemList(items, emptyMsg, { detailed = false, sortable = false } = {}) {
  const s = state.reviewSort || { key: 'score', dir: 'desc' };
  const th = (key, label, title = '') => sortable
    ? `<th class="th-sort" data-sort="${key}" tabindex="0"${title ? ` title="${esc(title)}"` : ''}>${label}${s.key === key ? icon(s.dir === 'asc' ? 'chev-u' : 'chev-d', 'sort-ic') : ''}</th>`
    : `<th>${label}</th>`;
  return `<table class="data items-table"><thead><tr>
      <th class="col-type">Type</th><th>Item</th>
      ${detailed ? th('score', 'Score', 'severity × confidence') : ''}
      ${th('severity', 'Severity')}
      ${detailed ? '<th>Confidence</th><th>Assessment</th>' : ''}
      <th>Status</th>
      ${detailed ? '<th>Disposition</th><th>Source</th>' : ''}
      ${th('updated', 'Updated', 'last record update — evidence age is on the item page')}
      <th class="col-open"></th>
    </tr></thead><tbody>
    ${items.map((i) => itemRow(i, detailed)).join('') || `<tr><td colspan="10" class="sub">${emptyMsg}</td></tr>`}
  </tbody></table>`;
}

const sortItems = (items) => {
  const s = state.reviewSort || { key: 'score', dir: 'desc' };
  const val = (i) => s.key === 'severity' ? -sevRank(i) : s.key === 'updated' ? (i.updated_at ?? 0) : (i.priority_score ?? 0);
  return [...items].sort((a, b) => (val(b) - val(a)) * (s.dir === 'asc' ? -1 : 1));
};

function wireSort(el) {
  state.reviewSort ||= { key: 'score', dir: 'desc' };
  el.querySelectorAll('th.th-sort').forEach((th) => {
    const go = () => {
      const s = state.reviewSort;
      if (s.key === th.dataset.sort) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.key = th.dataset.sort; s.dir = 'desc'; }
      ctx.render();
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/* ── Item detail — shared renderers (drawer-free, own page at #/review/<org>/item?i=<id>) ── */
const basisBlock = (x) => {
  const raw = x.evidence_basis_json;
  if (!raw) return '';
  let b = null;
  try { b = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }
  if (!b) return '';
  const parts = [b.summary, b.postState, b.when].filter(Boolean).map((p) => esc(String(p)));
  return `<div class="basis"><span class="badge badge-ok">evidence</span> ${parts.join(' · ')}</div>`;
};
const opRef = (o) => o.operation_id
  ? `<a class="link" href="#/operation/${o.operation_id}">op ${String(o.operation_id).slice(0, 8)}</a>`
  : `<span class="sub">plan ${String(o.plan_id).slice(0, 8)}</span>`;
const decLine = (x) => `<div class="sub">${esc(DISP_LABEL[x.disposition] ?? x.disposition)}${x.rationale ? ` — ${esc(x.rationale)}` : ''}${x.owner ? ` · owner: ${esc(x.owner)}` : ''}${x.review_due_at ? ` · review by ${fmtTs(x.review_due_at)}` : ''} ${provBadge(x.provenance)} ${esc(x.actor ?? '')} <span class="sub">${ago(x.created_at)}</span>${x.superseded_by ? ' <span class="badge badge-muted">superseded</span>' : ''}${basisBlock(x)}</div>`;

function wireItemRows(el, orgId) {
  el.querySelectorAll('tr[data-item]').forEach((row) => {
    const go = () => { state.reviewItemId = row.dataset.item; state.reviewTab = 'item'; ctx.nav(); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/** Full item page — all fields editable, all evidence/context on one screen. */
async function tabItem(el, orgId) {
  const d = await api(`/api/v1/orgs/${orgId}/review/items/${state.reviewItemId}`);
  const i = d.item, rev = d.revision || {};
  const open = i.workflow !== 'closed';
  const ev = (d.evidence || []).map((e) => `<li class="sub">${esc(e.link_type)} ${esc(e.entity_id ?? e.observation_id ?? e.operation_id ?? e.annotation_id ?? '')}${e.field_path ? ` · ${esc(e.field_path)}` : ''}${e.note ? ` — ${esc(e.note)}` : ''} <span class="sub">${ago(e.created_at)}</span></li>`).join('');
  const qs = (d.questions || []).map((q) => `<li class="q-block">${esc(q.question)} ${qStatusBadge(q.status)} <span class="sub">${esc(ANSWER_TYPE_LABEL[q.answer_type] ?? q.answer_type)}</span>
    ${(d.answers || []).filter((a) => a.question_id === q.id).map(answerLine).join('')}
    ${!['answered', 'withdrawn', 'superseded'].includes(q.status) ? answerForm(q) : ''}
  </li>`).join('');
  const decs = (d.decisions || []).map(decLine).join('');
  const linked = (d.operations || []).map((o) => `<li class="sub"><span class="badge badge-muted">${esc(o.link_kind)}</span> ${opRef(o)} <span class="sub">${ago(o.created_at)}</span></li>`).join('');
  const events = (d.events || []).slice(0, 20).map((e) => `<div class="sub">${ago(e.created_at)} · ${esc(e.event_type)} · ${esc(e.actor ?? e.actor_kind)} ${provBadge(e.provenance)}</div>`).join('');
  const sel = (cur, opts) => opts.map((o) => `<option value="${o}" ${o === cur ? 'selected' : ''}>${o}</option>`).join('');
  el.innerHTML = `
    <div class="toolbar" style="gap:6px"><a class="link" href="#/review/${orgId}/inbox">‹ inbox</a>
      <span class="sub">item ${esc(i.id)} · revision ${i.current_revision} · ${esc(i.item_type)}${i.category ? ' · ' + esc(i.category) : ''}</span>
      ${open ? '' : '<span class="badge badge-muted">closed</span>'}</div>
    <h2 class="item-title">${esc(i.title)}</h2>
    <div class="toolbar" style="gap:6px;margin-bottom:10px">
      ${sevBadge(i.severity)} ${confBadge(i.confidence)} ${i.priority_score ? `<span class="badge badge-info" title="severity × confidence">score ${i.priority_score}</span>` : ''}
      ${assessBadge(i.assessment)} ${wfBadge(i.workflow)}
      <span class="badge ${['accept_risk', 'verified_resolved'].includes(i.disposition) ? 'badge-ok' : i.disposition === 'none' ? 'badge-muted' : 'badge-warn'}">${esc(DISP_LABEL[i.disposition] ?? i.disposition)}</span>${rsBadge(i.review_state)}
      <span class="sub">impact ${esc(i.impact ?? '—')} · urgency ${esc(i.urgency ?? '—')}</span>
      <span class="sub">created ${fmtTs(i.created_at)} by ${esc(i.created_by ?? i.created_by_kind ?? '?')} · updated ${ago(i.updated_at)}${i.closed_at ? ` · closed ${ago(i.closed_at)}` : ''}${i.due_at ? ` · due ${fmtTs(i.due_at)}` : ''}</span>
    </div>
    <div class="item-grid">
      <div>
        <div class="section-title">What we noticed</div><div class="wrap">${esc(rev.summary ?? i.title)}</div>
        <div class="section-title">Why it might matter</div><div class="wrap">${esc(rev.consequence ?? '—')}</div>
        <div class="section-title">Known vs unknown</div><div class="sub wrap" style="white-space:pre-wrap">${esc(rev.knowns_unknowns ?? '—')}</div>
        <div class="section-title">Rationale / source</div><div class="sub wrap">${esc(rev.rationale ?? '—')}${rev.source_id ? ` <span class="badge badge-muted">${esc(rev.source_id)}${rev.source_version ? ' v' + esc(rev.source_version) : ''}</span>` : ''}</div>
      </div>
      <div>
        <div class="section-title">Evidence</div><ul class="sub" style="margin:0;padding-left:16px">${ev || '<li class="sub">no linked evidence</li>'}</ul>
        <div class="section-title">Linked work</div><ul class="sub" style="margin:0;padding-left:16px;list-style:none">${linked || '<li class="sub">none — related operations/plans attach here via link</li>'}</ul>
        <div class="section-title">Decisions</div>${decs || '<div class="sub">none recorded</div>'}
      </div>
    </div>
    <div class="section-title">Questions & answers</div>
    <ul class="q-list">${qs || '<li class="sub">none</li>'}</ul>
    <details class="srv-card"><summary><span class="srv-name">Ask a question</span><span class="chev">›</span></summary>
      <div class="srv-body"><div class="ans-form" id="ask-form">
        <input type="text" id="ask-q" class="ans-text" placeholder="Ask a question…" />
        <div class="ans-foot">
          <input type="text" id="ask-why" placeholder="why it matters (optional)" style="flex:1" />
          <span class="ans-actions">
            <select id="ask-type"><option value="text">Free text</option><option value="yes_no_unknown">Yes / No / Unknown</option><option value="entity">Entity ref</option><option value="owner">Person</option><option value="date">Date</option></select>
            <button class="btn" id="ask-save">Ask</button>
          </span>
        </div>
      </div></div>
    </details>
    ${open ? `<div class="toolbar" style="margin-top:10px;gap:6px">
      <span class="sub">Record decision:</span>
      <select id="dec-kind">
        <option value="investigate">investigate</option><option value="monitor">monitor</option>
        <option value="accept_risk">accept risk</option><option value="pursue_improvement">pursue improvement</option>
        <option value="defer">defer</option><option value="dismiss">dismiss</option>
        <option value="verified_resolved">verified resolved</option><option value="unverified_closure">close (unverified)</option>
      </select>
      <input type="text" id="dec-rationale" placeholder="rationale / reason" style="width:220px" />
      <input type="text" id="dec-owner" placeholder="owner (optional)" style="width:120px" />
      <input type="text" id="dec-scope" placeholder="notes / scope (optional)" style="width:160px" />
      <input type="text" id="dec-actor" placeholder="your name" style="width:110px" />
      <button class="btn" id="dec-save">Record</button>
      <span class="sub">a decision never executes anything — related work is linked separately</span>
    </div>` : '<div class="sub">closed — decisions and evidence preserved</div>'}
    <details class="srv-card"${open ? '' : ' open'}><summary><span class="srv-name">Edit fields</span><span class="srv-stats sub">revision ${i.current_revision} → ${i.current_revision + 1}</span><span class="chev">›</span></summary>
      <div class="srv-body"><div class="edit-grid">
        <label>Title<input type="text" id="f-title" value="${esc(i.title)}" /></label>
        <label>Impact<input type="text" id="f-impact" value="${esc(i.impact ?? '')}" placeholder="e.g. high" /></label>
        <label>Urgency<input type="text" id="f-urgency" value="${esc(i.urgency ?? '')}" placeholder="e.g. medium" /></label>
        <label>Severity<select id="f-severity"><option value="">— keep —</option>${sel(i.severity, ['critical', 'high', 'medium', 'low'])}</select></label>
        <label>Confidence<select id="f-confidence"><option value="">— keep —</option>${sel(i.confidence, ['high', 'medium', 'low'])}</select></label>
        <label class="span2">What we noticed (summary)<textarea id="f-summary" rows="3">${esc(rev.summary ?? '')}</textarea></label>
        <label class="span2">Why it might matter (consequence)<textarea id="f-consequence" rows="3">${esc(rev.consequence ?? '')}</textarea></label>
        <label class="span2">Known vs unknown<textarea id="f-knowns" rows="5">${esc(rev.knowns_unknowns ?? '')}</textarea></label>
        <label class="span2">Rationale / source<textarea id="f-rationale" rows="3">${esc(rev.rationale ?? '')}</textarea></label>
        <label>Edited by<input type="text" id="f-actor" placeholder="your name" /></label>
        <div class="span2"><button class="btn" id="f-save">Save revision</button>
          <span class="sub">writes a new immutable revision — prior content is preserved in history</span></div>
      </div></div>
    </details>
    <div class="section-title">History</div>${events || '<div class="sub">no events</div>'}`;
  wireAnswerForms(el, orgId);
  const nameInit = () => { const n = localStorage.getItem('review-answer-name') ?? ''; ['#dec-actor', '#f-actor'].forEach((s) => { const x = el.querySelector(s); if (x && !x.value) x.value = n; }); };
  nameInit();
  $('#ask-save')?.addEventListener('click', async () => {
    const q = $('#ask-q').value.trim();
    if (!q) return;
    await api(`/api/v1/orgs/${orgId}/review/questions`, { method: 'POST', body: JSON.stringify({ itemId: i.id, question: q, whyItMatters: $('#ask-why').value.trim() || undefined, answerType: $('#ask-type').value }) });
    toast('Question added');
    ctx.render();
  });
  $('#dec-save')?.addEventListener('click', async () => {
    const disposition = $('#dec-kind').value;
    const rationale = $('#dec-rationale').value.trim();
    const owner = $('#dec-owner').value.trim();
    const scopeNote = $('#dec-scope').value.trim();
    const actor = $('#dec-actor').value.trim();
    const payload = { disposition, rationale: rationale || undefined, owner: owner || undefined, scopeNote: scopeNote || undefined, actor: actor || undefined };
    if (disposition === 'verified_resolved') {
      const basis = prompt('Evidence basis for verified resolution (what proves it resolved)?');
      if (!basis) return;
      payload.evidenceBasis = { note: basis };
    }
    if (disposition === 'dismiss' && !rationale) { toast('A dismissal needs a reason'); return; }
    if (actor) localStorage.setItem('review-answer-name', actor);
    await api(`/api/v1/orgs/${orgId}/review/items/${i.id}/decision`, { method: 'POST', body: JSON.stringify(payload) });
    toast('Decision recorded');
    ctx.render();
  });
  $('#f-save')?.addEventListener('click', async () => {
    const val = (s) => el.querySelector(s).value.trim();
    const actor = val('#f-actor');
    const changes = { expectedRevision: i.current_revision, actor: actor || undefined };
    if (val('#f-title') !== i.title) changes.title = val('#f-title');
    if (val('#f-summary') !== (rev.summary ?? '')) changes.summary = val('#f-summary');
    if (val('#f-consequence') !== (rev.consequence ?? '')) changes.consequence = val('#f-consequence');
    if (val('#f-knowns') !== (rev.knowns_unknowns ?? '')) changes.knownsUnknowns = val('#f-knowns');
    if (val('#f-rationale') !== (rev.rationale ?? '')) changes.rationale = val('#f-rationale');
    if (val('#f-impact') !== (i.impact ?? '')) changes.impact = val('#f-impact');
    if (val('#f-urgency') !== (i.urgency ?? '')) changes.urgency = val('#f-urgency');
    if (val('#f-severity')) changes.severity = val('#f-severity');
    if (val('#f-confidence')) changes.confidence = val('#f-confidence');
    if (Object.keys(changes).length <= 2) { toast('Nothing changed'); return; }
    if (actor) localStorage.setItem('review-answer-name', actor);
    try {
      await api(`/api/v1/orgs/${orgId}/review/items/${i.id}/revise`, { method: 'POST', body: JSON.stringify(changes) });
      toast('Revision saved');
      ctx.render();
    } catch (e) {
      toast(`Save failed: ${e.message}`);
      if (/revision/.test(e.message)) ctx.render();
    }
  });
}

async function tabInbox(el, orgId) {
  const d = await api(`/api/v1/orgs/${orgId}/review`);
  const c = d.counts || {};
  state.reviewFilter ||= { q: '', type: '', severity: '', workflow: '', assessment: '', reviewState: '' };
  const f = state.reviewFilter;
  const params = `${f.q ? `&q=${encodeURIComponent(f.q)}` : ''}${f.type ? `&type=${f.type}` : ''}${f.severity ? `&severity=${f.severity}` : ''}${f.workflow ? `&workflow=${f.workflow}` : ''}${f.assessment ? `&assessment=${f.assessment}` : ''}${f.reviewState ? `&reviewState=${f.reviewState}` : ''}`;
  const { items, nextCursor } = await api(`/api/v1/orgs/${orgId}/review/items?limit=200${params}`);
  // Default queue is open-only so the count agrees with the Open-items card;
  // closed items appear when the workflow filter explicitly selects them.
  const shown = sortItems(f.workflow ? items : items.filter((i) => i.workflow !== 'closed'));
  const activeFilters = [
    f.q && `search: “${f.q}”`, f.type && `type: ${TYPE_LABEL[f.type] ?? f.type}`,
    f.severity && `severity: ${f.severity}`, f.workflow && `workflow: ${f.workflow.replace('_', ' ')}`,
    f.assessment && `assessment: ${f.assessment}`, f.reviewState && 'review due',
  ].filter(Boolean);
  el.innerHTML = `
    <div class="stat-row">
      ${statCard({ icon: 'inbox', tone: 'accent', value: c.open ?? 0, label: 'Open items', sub: 'not closed', go: true, data: 'all' })}
      ${statCard({ icon: 'eye', tone: 'info', value: c.proposed ?? 0, label: 'Proposed', sub: 'awaiting confirmation', go: true, data: 'proposed' })}
      ${statCard({ icon: 'help', tone: 'warn', value: c.openQuestions ?? 0, label: 'Questions', sub: 'open', go: true, data: 'questions' })}
      ${statCard({ icon: 'clock', tone: 'warn', value: c.dueReviews ?? 0, label: 'Review due', sub: 'reassessment', go: true, data: 'due' })}
      ${statCard({ icon: 'check', tone: 'ok', value: c.acceptedRisks ?? 0, label: 'Accepted risks', sub: 'decisions tab', go: true, data: 'decisions' })}
    </div>
    ${d.dueReviews?.length ? `<div class="panel"><div class="panel-head"><div><div class="panel-title">Needs reassessment / review due</div><div class="sub">decisions age — new evidence may contradict them</div></div></div>${itemList(d.dueReviews, 'none')}</div>` : ''}
    <div class="panel">
      <div class="panel-head">
        <div><div class="panel-title">Open items (${shown.length}${nextCursor ? '+' : ''})</div>
          <div class="sub">items requiring review and decision · sorted by ${esc((state.reviewSort || {}).key ?? 'score')}</div></div>
        <div class="filterbar">
          <input type="search" id="fi-q" class="fi-search" placeholder="Search items…" value="${esc(f.q)}" />
          <select id="fi-type"><option value="">Type</option>${['risk', 'improvement', 'observation'].map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select>
          <select id="fi-sev"><option value="">Severity</option>${SEV_ORDER.map((s) => `<option ${f.severity === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <select id="fi-wf"><option value="">Workflow</option>${['new', 'triage', 'awaiting_context', 'reviewed', 'closed'].map((w) => `<option value="${w}" ${f.workflow === w ? 'selected' : ''}>${w.replace('_', ' ')}</option>`).join('')}</select>
          <button class="btn secondary" id="fi-detail" title="show/hide detail columns">${state.reviewDetailed ? 'Simple' : 'Detailed'}</button>
        </div>
      </div>
      ${activeFilters.length ? `<div class="filter-chips">${activeFilters.map((x) => `<span class="badge badge-accent">${esc(x)}</span>`).join('')}<button class="btn-mini" id="fi-clear">Clear all</button></div>` : ''}
      ${itemList(shown, activeFilters.length ? 'No items match the current filters — clear them to see the full queue.' : 'No review items recorded — a clean queue is not proof of health; check Infrastructure → Coverage for what has never been assessed.', { detailed: !!state.reviewDetailed, sortable: true })}
      ${nextCursor ? '<div class="sub" style="padding:8px 4px">showing first 200 — narrow with filters</div>' : ''}
    </div>`;
  el.querySelectorAll('.stat-card[data-go]').forEach((card) => {
    const go = () => {
      const k = card.dataset.go;
      const blank = { q: '', type: '', severity: '', workflow: '', assessment: '', reviewState: '' };
      if (k === 'questions') { state.reviewTab = 'questions'; return ctx.nav(); }
      if (k === 'decisions') { state.reviewTab = 'decisions'; return ctx.nav(); }
      if (k === 'due') state.reviewFilter = { ...blank, reviewState: 'review_due' };
      if (k === 'proposed') state.reviewFilter = { ...blank, assessment: 'proposed' };
      if (k === 'all') state.reviewFilter = blank;
      ctx.render();
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  let deb;
  $('#fi-q').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(deb); deb = setTimeout(() => { f.q = v.trim(); ctx.render().then(() => { const s = $('#fi-q'); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 300);
  });
  $('#fi-type').addEventListener('change', (e) => { f.type = e.target.value; ctx.render(); });
  $('#fi-sev').addEventListener('change', (e) => { f.severity = e.target.value; ctx.render(); });
  $('#fi-wf').addEventListener('change', (e) => { f.workflow = e.target.value; ctx.render(); });
  $('#fi-detail').addEventListener('click', () => { state.reviewDetailed = !state.reviewDetailed; ctx.render(); });
  $('#fi-clear')?.addEventListener('click', () => { state.reviewFilter = { q: '', type: '', severity: '', workflow: '', assessment: '', reviewState: '' }; ctx.render(); });
  wireSort(el);
  wireItemRows(el, orgId);
}

async function tabQuestions(el, orgId) {
  const { questions } = await api(`/api/v1/orgs/${orgId}/review/questions`);
  const isOpenQ = (q) => ['open', 'needs_clarification'].includes(q.status);
  const needle = (state.reviewQSearch ?? '').trim().toLowerCase();
  const matches = (q) => {
    if (!needle) return true;
    const hay = [q.question, q.why_it_matters, q.item_title, q.item_category,
      ...(q.answers ?? []).flatMap((a) => [a.answer_text, a.actor, a.normalized_json])]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(needle);
  };
  const filtered = questions.filter(matches);
  const openQs = filtered.filter(isOpenQ);
  const resolvedQs = filtered.filter((q) => !isOpenQ(q));
  const catOf = (q) => q.item_category || (q.item_id ? 'uncategorized' : 'general');
  const byCat = [...new Set(openQs.map(catOf))]
    .map((c) => [c, openQs.filter((q) => catOf(q) === c)])
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const qRow = (q) => {
    const answers = q.answers || [];
    const cur = answers.filter((a) => a.is_current);
    const latest = cur[cur.length - 1];
    return `<tr class="clickable q-row" data-q="${q.id}" tabindex="0"><td class="wrap">${esc(q.question)}
      ${q.why_it_matters ? `<div class="sub">${esc(q.why_it_matters)}</div>` : ''}
      ${q.item_title ? `<div class="sub">item: ${q.item_id ? `<a class="link" href="#/review/${orgId}/item?i=${q.item_id}">${esc(q.item_title)}</a>` : esc(q.item_title)}</div>` : ''}
      ${latest ? `<div class="sub">↳ ${esc(latest.answer_text)} — ${esc(latest.actor ?? '?')} · ${ago(latest.created_at)}</div>` : ''}</td>
    <td>${qStatusBadge(q.status)}</td>
    <td class="sub">${esc(ANSWER_TYPE_LABEL[q.answer_type] ?? q.answer_type)}</td>
    <td class="sub">${answers.length || '—'}</td>
    <td class="sub">${ago(q.created_at)}</td></tr>
    <tr class="q-detail" hidden><td colspan="5"><div class="evidence-drawer">
      <div class="section-title">Answers</div>
      ${answers.length ? answers.map(answerLine).join('') : '<div class="sub">no answers yet</div>'}
      ${!['answered', 'withdrawn', 'superseded'].includes(q.status) || answers.length ? `<div class="section-title">${['open', 'needs_clarification'].includes(q.status) ? 'Add an answer' : 'Add a follow-up answer'}</div>${answerForm(q)}` : ''}
    </div></td></tr>`;
  };
  const qTable = (rows) => `<table class="data"><thead><tr><th>Question</th><th>Status</th><th>Type</th><th>Answers</th><th>Asked</th></tr></thead>
    <tbody>${rows.map(qRow).join('')}</tbody></table>`;
  el.innerHTML = `
    <div class="panel-head">
      <div><div class="panel-title">Open questions (${openQs.length})</div>
        <div class="sub">awaiting an answer · ${resolvedQs.length} resolved in the archive below — search reaches both</div></div>
      <div class="filterbar">
        <input type="search" id="q-search" class="fi-search" placeholder="Search questions and answers…" value="${esc(state.reviewQSearch ?? '')}" />
      </div>
    </div>
    ${byCat.length ? byCat.map(([c, rows]) => `<details class="srv-card" open><summary><span class="srv-name">${esc(c)}</span>
        <span class="srv-stats sub">${rows.length} open</span><span class="chev">›</span></summary>
        <div class="srv-body" style="padding:0">${qTable(rows)}</div></details>`).join('')
      : `<div class="srv-card" style="padding:var(--sp-5)"><div class="sub">${needle ? 'No open questions match — resolved matches may be in the archive below.' : 'No open questions for this organization.'}</div></div>`}
    <details class="srv-card"${needle && resolvedQs.length ? ' open' : ''}><summary><span class="srv-name">Resolved answers</span>
      <span class="srv-stats sub">${resolvedQs.length} · answer history — searchable, kept for review</span><span class="chev">›</span></summary>
      <div class="srv-body" style="padding:0">${resolvedQs.length ? qTable(resolvedQs) : '<div class="sub" style="padding:var(--sp-3)">No resolved answers yet — this archive fills as questions get answered.</div>'}</div></details>`;
  let qDeb;
  $('#q-search').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(qDeb); qDeb = setTimeout(() => { state.reviewQSearch = v; ctx.render().then(() => { const s = $('#q-search'); s?.focus(); s?.setSelectionRange(v.length, v.length); }); }, 300);
  });
  $('#q-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.reviewQSearch = ''; ctx.render(); } });
  el.querySelectorAll('tr.q-row').forEach((row) => {
    const tog = () => {
      const next = row.nextElementSibling;
      if (!next?.classList.contains('q-detail')) return;
      next.hidden = !next.hidden;
      row.setAttribute('aria-expanded', String(!next.hidden));
    };
    row.addEventListener('click', (e) => { if (!e.target.closest('a,button,input')) tog(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') tog(); });
  });
  wireAnswerForms(el, orgId);
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const sevRank = (i) => Math.max(0, SEV_ORDER.indexOf(i.severity));
const sevLine = (rows) => SEV_ORDER.map((s) => {
  const n = rows.filter((i) => i.severity === s).length;
  return n ? `${n} ${s}` : null;
}).filter(Boolean).join(' · ');

async function tabRisks(el, orgId) {
  const items = await loadItems(orgId, '&type=risk');
  const open = items.filter((i) => i.workflow !== 'closed');
  const closed = items.filter((i) => i.workflow === 'closed');
  const catOf = (i) => i.category || 'uncategorized';
  const byCat = [...new Set(open.map(catOf))]
    .map((c) => [c, open.filter((i) => catOf(i) === c).sort((a, b) => sevRank(a) - sevRank(b) || (b.priority_score ?? 0) - (a.priority_score ?? 0))])
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const sel = state.reviewRiskCat || null;
  const hud = byCat.map(([c, rows]) => statCard({ icon: 'warn', tone: rows.some((i) => i.severity === 'critical') ? 'bad' : rows.some((i) => i.severity === 'high') ? 'warn' : 'info', value: rows.length, label: c, sub: sevLine(rows), go: true, title: sel === c ? 'Clear filter' : `Show only ${c} risks`, data: `cat:${c}`, active: sel === c })).join('');
  const shown = sel ? byCat.filter(([c]) => c === sel) : byCat;
  el.innerHTML = `
    <div class="sub">Proposed risks are unconfirmed assessments — "confirmed" requires a human decision. Nothing here executes.</div>
    <div class="stat-row">${hud || '<div class="sub">No open risks recorded.</div>'}</div>
    ${sel ? `<div class="toolbar" style="gap:6px"><span class="badge badge-accent">category: ${esc(sel)}</span><button class="btn secondary" id="risk-clear">show all</button></div>` : ''}
    ${shown.map(([c, rows]) => `<details class="srv-card" open><summary><span class="srv-name">${esc(c)}</span>
      <span class="srv-stats sub">${rows.length} open · ${sevLine(rows)}</span><span class="chev">›</span></summary>
      <div class="srv-body">${itemList(rows)}</div></details>`).join('')}
    <div class="section-title">Decided</div>${itemList(closed, 'none')}`;
  el.querySelectorAll('.stat-card[data-go]').forEach((card) => {
    const pick = () => { const cat = card.dataset.go.slice(4); state.reviewRiskCat = sel === cat ? null : cat; ctx.render(); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
  });
  $('#risk-clear')?.addEventListener('click', () => { state.reviewRiskCat = null; ctx.render(); });
  wireItemRows(el, orgId);
}

async function tabImprovements(el, orgId) {
  const items = await loadItems(orgId, '&type=improvement');
  el.innerHTML = `
    <div class="toolbar" style="gap:6px">
      <select id="imp-cat"><option value="">all categories</option>
        ${['security', 'resilience', 'lifecycle', 'consistency', 'monitoring', 'performance', 'backup', 'documentation', 'efficiency', 'cost'].map((c) => `<option ${state.reviewImpCat === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <button class="btn secondary" id="imp-new">+ Propose improvement</button>
    </div>
    <div class="sub">Opportunities, not defects — each carries purpose, benefit, prerequisites, and trade-offs. Selection for work is a planning state, never a dispatch.</div>
    ${itemList(items.filter((i) => !state.reviewImpCat || i.category === state.reviewImpCat), 'No improvements proposed.')}
    `;
  $('#imp-cat').addEventListener('change', (e) => { state.reviewImpCat = e.target.value; ctx.render(); });
  $('#imp-new').addEventListener('click', () => {
    const title = prompt('Improvement title'); if (!title) return;
    const category = prompt('Category (security|resilience|lifecycle|consistency|monitoring|performance|backup|documentation|efficiency|cost)', 'lifecycle') || 'lifecycle';
    const summary = prompt('What would this improve and why?') || '';
    api(`/api/v1/orgs/${orgId}/review/items`, { method: 'POST', body: JSON.stringify({ itemType: 'improvement', title, category, summary }) }).then(() => { toast('Proposed'); ctx.render(); });
  });
  wireItemRows(el, orgId);
}

function accCard(d) {
  const i = d.item || {};
  const dec = (d.decisions || []).filter((x) => x.disposition === 'verified_resolved' && !x.superseded_by).pop()
    ?? (d.decisions || []).filter((x) => !x.superseded_by).pop() ?? {};
  let basis = null;
  try { basis = dec.evidence_basis_json ? (typeof dec.evidence_basis_json === 'string' ? JSON.parse(dec.evidence_basis_json) : dec.evidence_basis_json) : null; } catch { basis = null; }
  const ops = (d.operations || []).map((o) => o.operation_id
    ? `<a class="link" href="#/operation/${o.operation_id}">op ${String(o.operation_id).slice(0, 8)}</a>`
    : `<span class="sub">plan ${String(o.plan_id).slice(0, 8)}</span>`).join(' · ');
  return `<details class="srv-card acc-card" data-item="${i.id}">
    <summary><span class="srv-name">${esc(i.title)}</span>
      <span class="badge badge-ok">resolved</span>
      <span class="srv-stats sub">${i.closed_at ? `closed ${ago(i.closed_at)}` : ago(i.updated_at)}</span><span class="chev">›</span></summary>
    <div class="srv-body">
      ${dec.rationale ? `<div class="acc-line"><span class="acc-k">what was done</span><div class="wrap">${esc(dec.rationale)}</div></div>` : ''}
      ${basis ? `<div class="acc-line"><span class="acc-k">proof</span><div class="wrap">${[basis.summary, basis.postState].filter(Boolean).map((p) => esc(String(p))).join(' · ')}${basis.when ? ` <span class="sub">${esc(String(basis.when))}</span>` : ''}</div></div>` : ''}
      ${dec.scope_note ? `<div class="acc-line"><span class="acc-k">notes</span><div class="wrap sub">${esc(dec.scope_note)}</div></div>` : ''}
      ${ops ? `<div class="acc-line"><span class="acc-k">receipts</span><div>${ops}</div></div>` : ''}
      <div class="acc-line"><span class="acc-k">recorded</span><div class="sub">${esc(dec.actor ?? '—')} ${provBadge(dec.provenance)} · ${fmtTs(dec.created_at)}</div></div>
      <div class="acc-line"><span class="acc-k"></span><div><a class="link" href="#/review/${i.org_id}/item?i=${i.id}">open full record ›</a></div></div>
    </div>
  </details>`;
}

async function tabDecisions(el, orgId) {
  const items = await loadItems(orgId, '&disposition=accept_risk');
  const deferred = await loadItems(orgId, '&disposition=defer');
  const dismissed = await loadItems(orgId, '&disposition=dismiss');
  const resolved = await loadItems(orgId, '&disposition=verified_resolved');
  const unverified = await loadItems(orgId, '&disposition=unverified_closure');
  const details = await Promise.all(resolved.slice(0, 50).map((i) => api(`/api/v1/orgs/${orgId}/review/items/${i.id}`).catch(() => null)));
  const accs = details.filter(Boolean).sort((a, b) => (b.item.closed_at ?? b.item.updated_at) - (a.item.closed_at ?? a.item.updated_at));
  const section = (t, rows) => `<div class="section-title">${t}</div>${itemList(rows, 'none')}`;
  el.innerHTML = `
    <div class="sub">Decisions are durable — contradictory new evidence flags reassessment without rewriting them. Verified resolutions are distinct from unverified administrative closures.</div>
    <div class="section-title">Resolved work (${accs.length}) — what was done, when, and the proof</div>
    ${accs.map(accCard).join('') || '<div class="sub">nothing marked verified resolved yet — resolutions appear here with their evidence basis and linked receipts</div>'}
    ${section(`Accepted risks (${items.length})`, items)}
    ${section(`Deferred (${deferred.length})`, deferred)}
    ${section(`Closed unverified (${unverified.length})`, unverified)}
    ${section(`Dismissed (${dismissed.length})`, dismissed)}`;
  wireItemRows(el, orgId);
}

async function tabContext(el, orgId) {
  const { annotations } = await api(`/api/v1/orgs/${orgId}/review/annotations`);
  el.innerHTML = `
    <div class="toolbar" style="gap:6px"><button class="btn secondary" id="ann-new">+ Add context</button></div>
    <div class="sub">Human-supplied context (lifecycle, ownership, intent, exceptions) — reported vs direct attribution preserved. Context informs interpretation; it is never promoted to collected evidence.</div>
    <table class="data"><thead><tr><th>Type</th><th>Context</th><th>Subjects</th><th>Attribution</th><th>By</th><th>When</th></tr></thead><tbody>
    ${(annotations || []).map((a) => `<tr><td><span class="badge badge-muted">${esc(a.annotation_type)}</span></td>
      <td class="wrap" title="${esc(a.text)}">${esc(a.text)}${a.source_note ? `<div class="sub">${esc(a.source_note)}</div>` : ''}</td>
      <td class="sub">${esc(a.subject_json ? (JSON.parse(a.subject_json).entities || []).join(', ') : '—')}</td>
      <td>${provBadge(a.attribution === 'direct_human' ? 'direct' : 'reported')}</td>
      <td class="sub">${esc(a.actor ?? '—')}</td><td class="sub">${ago(a.created_at)}</td></tr>`).join('')
      || '<tr><td colspan="6" class="sub">no context recorded</td></tr>'}
    </tbody></table>`;
  $('#ann-new').addEventListener('click', () => {
    const text = prompt('Context statement (e.g. "SRV-01 and SRV-02 are decommissioned and powered off")'); if (!text) return;
    const subjects = prompt('Subjects — comma-separated names/keys this applies to') || '';
    const type = prompt('Type (lifecycle|ownership|intent|exception|context)', 'lifecycle') || 'context';
    api(`/api/v1/orgs/${orgId}/review/annotations`, {
      method: 'POST',
      body: JSON.stringify({ annotationType: type, text, subject: subjects ? { entities: subjects.split(',').map((s) => s.trim()).filter(Boolean) } : undefined }),
    }).then(() => { toast('Context recorded'); ctx.render(); });
  });
}

export async function reviewView(el) {
  const org = requireOrg(el, { title: 'Review Center', icon: 'review', sub: 'Findings, questions, and decisions are kept per organization — choose one to review.' });
  if (org == null) return;
  state.reviewOrg = org;
  const tab = state.reviewTab || 'inbox';
  el.innerHTML = `
    ${pageHeader({ icon: 'review', title: 'Review Center', sub: 'Review, interpret, and make decisions over retained evidence — nothing here executes' })}
    ${tabBar(state.reviewOrg, tab)}
    <div id="review-body"><div class="sub">loading…</div></div>`;
  el.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => { state.reviewTab = b.dataset.tab; if (b.dataset.tab !== 'item') state.reviewItemId = null; ctx.nav(); }));
  if (!state.reviewOrg) { $('#review-body').innerHTML = '<div class="sub">No organizations in cache.</div>'; return; }
  const body = $('#review-body');
  try {
    switch (tab) {
      case 'questions': await tabQuestions(body, state.reviewOrg); break;
      case 'risks': await tabRisks(body, state.reviewOrg); break;
      case 'improvements': await tabImprovements(body, state.reviewOrg); break;
      case 'decisions': await tabDecisions(body, state.reviewOrg); break;
      case 'context': await tabContext(body, state.reviewOrg); break;
      case 'item': await tabItem(body, state.reviewOrg); break;
      default: await tabInbox(body, state.reviewOrg);
    }
  } catch (e) {
    body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}
