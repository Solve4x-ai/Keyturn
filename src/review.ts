/**
 * REVIEW-1 — organization Review Center.
 *
 * Durable, org-scoped review records: observations, risks, improvements,
 * questions, decisions, and human context — over retained evidence. This
 * service performs LOCAL collaboration writes only. Nothing here executes,
 * plans, or dispatches endpoint actions; the trusted plan/approval flow in
 * operations.ts remains the sole path for new commands.
 *
 * Provenance model (§7): actor_kind says WHO acted (human_ui | harness |
 * ai | rule | system); provenance says HOW the statement reached us
 * (direct = authenticated UI action, delegated = harness relaying an
 * explicit user instruction, reported = harness relaying user context,
 * system = deterministic rule/service). A reported statement is stored
 * honestly as reported — never upgraded to a confirmed human decision.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { EntityStore } from './entity-store.js';

export class ReviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export type ItemType = 'observation' | 'risk' | 'improvement';
export type Workflow = 'new' | 'triage' | 'awaiting_context' | 'reviewed' | 'closed';
export type Assessment = 'unassessed' | 'proposed' | 'confirmed' | 'inconclusive' | 'not_applicable';
export type Disposition =
  | 'none' | 'investigate' | 'monitor' | 'accept_risk' | 'pursue_improvement'
  | 'defer' | 'dismiss' | 'duplicate' | 'superseded' | 'verified_resolved' | 'unverified_closure';
export type ReviewState = 'current' | 'reassessment_needed' | 'review_due';
export type Provenance = 'direct' | 'delegated' | 'reported' | 'system';
export type ActorKind = 'human_ui' | 'harness' | 'ai' | 'rule' | 'system';

const WORKFLOWS = new Set(['new', 'triage', 'awaiting_context', 'reviewed', 'closed']);
const ASSESSMENTS = new Set(['unassessed', 'proposed', 'confirmed', 'inconclusive', 'not_applicable']);
const DISPOSITIONS = new Set(['none', 'investigate', 'monitor', 'accept_risk', 'pursue_improvement', 'defer', 'dismiss', 'duplicate', 'superseded', 'verified_resolved', 'unverified_closure']);
const ITEM_TYPES = new Set(['observation', 'risk', 'improvement']);
const ANSWER_TYPES = new Set(['text', 'yes_no_unknown', 'entity', 'owner', 'date']);
const ANNOTATION_TYPES = new Set(['lifecycle', 'ownership', 'intent', 'exception', 'context']);
const LINK_TYPES = new Set(['entity', 'observation', 'operation', 'annotation', 'relationship']);
const OP_LINK_KINDS = new Set(['proposed', 'approved', 'executed', 'verification']);
// Terminal dispositions close the item; the rest keep it in the tracked set.
const CLOSING_DISPOSITIONS = new Set(['accept_risk', 'defer', 'dismiss', 'duplicate', 'superseded', 'verified_resolved', 'unverified_closure']);
// A recorded decision requires direct UI action or an explicitly delegated
// instruction. A reported statement is context, not a decision.
const DECISION_PROVENANCES = new Set(['direct', 'delegated']);

const UNKNOWN_ANSWER = /^\s*(i don'?t know|unknown|not sure|no idea|idk)\s*[.!?]?\s*$/i;

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);
const SEV_W: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const CONF_W: Record<string, number> = { high: 3, medium: 2, low: 1 };
/** Weighted triage rank: how bad if true × how sure the evidence is. 0 when unrated. */
function priorityScore(severity: string | null | undefined, confidence: string | null | undefined): number {
  return (SEV_W[severity ?? ''] ?? 0) * (CONF_W[confidence ?? ''] ?? 0);
}
/** Free-text impact maps onto structured severity when it names a level. */
function severityFromImpact(impact: string | null | undefined): string | null {
  const v = String(impact ?? '').toLowerCase();
  return SEVERITIES.has(v) ? v : null;
}

/**
 * Per-rule interpretation for auto-imported findings: what it might mean
 * (consequence), what is genuinely unknown, questions worth a human answer,
 * and the rule's triage rating (severity × confidence → priority score).
 * Confidence reflects the strength of the *evidence* that something needs
 * attention — not certainty that the specific harm will occur.
 * Rules not listed still import — they just get the generic consequence
 * derived from the finding's own detail text.
 */
const FINDING_RULE_META: Record<string, { consequence: string; knownsUnknowns?: string; severity?: string; confidence?: string; questions: Array<{ question: string; whyItMatters?: string; answerType?: string }> }> = {
  'dhcp-server-unauthorized': {
    severity: 'high', confidence: 'high',
    consequence: 'An unauthorized DHCP server cannot issue leases — Active scopes are configuration, not service. Clients on these scopes are either served by authorized servers or failing silently.',
    knownsUnknowns: 'Known: role installed, scopes configured, authorization absent. Unknown: whether scopes were intended to migrate to another server, and who currently answers clients.',
    questions: [
      { question: 'Is this server intended to serve DHCP on this network?', whyItMatters: 'Decides between authorizing it or standing the scopes down.', answerType: 'yes_no_unknown' },
      { question: 'Were these scopes migrated to an authorized server already?', whyItMatters: 'Duplicate configured scopes can mask which server actually serves clients.', answerType: 'yes_no_unknown' },
    ],
  },
  'dhcp-authorized-orphan': {
    severity: 'medium', confidence: 'medium',
    consequence: 'AD retains an authorization for a server with no observed device — stale housekeeping debt, or a live DHCP server nobody is tracking (rogue-DHCP indicator).',
    knownsUnknowns: 'Known: authorization record exists. Unknown: whether the named server still exists and whether it holds scopes.',
    questions: [
      { question: 'Is this server retired?', whyItMatters: 'A retired server’s authorization is safe cleanup; a live one needs investigation.', answerType: 'yes_no_unknown' },
    ],
  },
  'dhcp-scope-no-failover': {
    severity: 'medium', confidence: 'high',
    consequence: 'A scope with no failover relationship is a single point of failure for client addressing — DHCP outage means no new or renewed leases.',
    questions: [
      { question: 'Is redundancy provided another way (split scope, second server, short lease times)?', answerType: 'yes_no_unknown' },
    ],
  },
  'gpo-enabled-unlinked': {
    severity: 'low', confidence: 'high',
    consequence: 'An enabled GPO linked to no container applies nowhere — dead configuration, or a staging step that was never finished.',
    questions: [
      { question: 'Was this GPO intentionally left unlinked?', whyItMatters: 'Intentional staging is fine to keep; forgotten work should be linked or cleaned up.', answerType: 'yes_no_unknown' },
    ],
  },
  'default-gpo-disabled': {
    severity: 'medium', confidence: 'low',
    consequence: 'A default-named GPO reporting all settings disabled may mean stripped baseline policy — or deliberate minimalism. Effective settings need RSoP/gpresult to confirm.',
    questions: [
      { question: 'Are the disabled sections on this default GPO intentional?', answerType: 'yes_no_unknown' },
    ],
  },
  'firewall-gpo-enabled': {
    severity: 'medium', confidence: 'medium',
    consequence: 'The name suggests firewall disablement; if applied broadly it weakens endpoint posture. Actual configured settings and link scope determine real exposure.',
    questions: [
      { question: 'Is firewall disablement scoped to a controlled subset (e.g. management VLAN)?', answerType: 'yes_no_unknown' },
    ],
  },
  'dns-zone-nonsecure-dynupdate': {
    severity: 'high', confidence: 'high',
    consequence: 'Nonsecure dynamic updates allow unauthenticated DNS record writes — a record-poisoning path inside the network.',
    questions: [
      { question: 'Does a legacy device or appliance still require nonsecure updates?', answerType: 'yes_no_unknown' },
    ],
  },
  'fsmo-conflict': {
    severity: 'high', confidence: 'medium',
    consequence: 'Two sources reported different FSMO holders in the same window — replication lag, a recent transfer, or a split-brain indicator.',
    questions: [
      { question: 'Was a role transfer or DC change in progress around that time?', answerType: 'yes_no_unknown' },
    ],
  },
  'dns-static-in-dhcp-pool': {
    severity: 'high', confidence: 'high',
    consequence: 'A static DNS record pointing into a dynamic DHCP pool silently re-targets the name to whichever client holds the lease — the answer changes as the pool churns. Classic cause of intermittent application behavior.',
    knownsUnknowns: 'Known: the record is static and its target is inside an observed dynamic range. Unknown: what the name is supposed to resolve to, and which clients depend on it.',
    questions: [
      { question: 'What is this record supposed to resolve to?', whyItMatters: 'Determines whether the record needs a correct static target or should be deleted as fossil.', answerType: 'text' },
      { question: 'Should this pool address be excluded or reserved so the record target stays stable?', answerType: 'yes_no_unknown' },
    ],
  },
};
const asStr = (v: unknown): string | null => (v == null ? null : String(v));
const asNum = (v: unknown): number | null => (v == null ? null : Number(v));

export interface EvidenceRef {
  linkType: 'entity' | 'observation' | 'operation' | 'annotation' | 'relationship';
  entityId?: string | undefined;
  observationId?: string | undefined;
  operationId?: string | undefined;
  annotationId?: string | undefined;
  fieldPath?: string | undefined;
  note?: string | undefined;
}

export interface ProposeInput {
  orgId: number;
  connectionId?: string | null | undefined;
  itemType: ItemType;
  category?: string | undefined;
  title: string;
  summary?: string | undefined;
  rationale?: string | undefined;
  consequence?: string | undefined;
  knownsUnknowns?: string | undefined;
  impact?: string | undefined;
  urgency?: string | undefined;
  severity?: string | undefined;
  confidence?: string | undefined;
  subject?: Record<string, unknown> | undefined;
  evidence?: EvidenceRef[] | undefined;
  questions?: Array<{ question: string; whyItMatters?: string | undefined; answerType?: string | undefined }> | undefined;
  sourceKind: ActorKind;
  sourceId?: string | undefined;
  sourceVersion?: string | undefined;
  actor?: string | undefined;
  provenance: Provenance;
  idempotencyKey?: string | undefined;
}

export class ReviewService {
  constructor(private readonly store: EntityStore) {}
  private get db() { return this.store.database; }

  // ── Reads ──────────────────────────────────────────────────────────

  listItems(orgId: number, f: { type?: string | undefined; workflow?: string | undefined; disposition?: string | undefined; assessment?: string | undefined; category?: string | undefined; severity?: string | undefined; reviewState?: string | undefined; q?: string | undefined; limit?: number | undefined; cursor?: number | undefined } = {}) {
    const where: string[] = ['org_id = ?'];
    const args: unknown[] = [orgId];
    if (f.type) { where.push('item_type = ?'); args.push(f.type); }
    if (f.workflow) { where.push('workflow = ?'); args.push(f.workflow); }
    if (f.severity) { where.push('severity = ?'); args.push(f.severity); }
    if (f.reviewState === 'review_due') { where.push(`due_at IS NOT NULL AND due_at <= ? AND disposition IN ('accept_risk','defer','monitor')`); args.push(Date.now()); }
    else if (f.reviewState) { where.push('review_state = ?'); args.push(f.reviewState); }
    if (f.disposition) { where.push('disposition = ?'); args.push(f.disposition); }
    if (f.assessment) { where.push('assessment = ?'); args.push(f.assessment); }
    if (f.category) { where.push('category = ?'); args.push(f.category); }
    if (f.q) { where.push('title LIKE ?'); args.push(`%${f.q}%`); }
    if (f.cursor) { where.push('rowid > ?'); args.push(f.cursor); }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT rowid AS _row, * FROM review_items WHERE ${where.join(' AND ')} ORDER BY priority_score DESC, updated_at DESC, rowid LIMIT ?`)
      .all(...([...args, limit] as never[])) as Array<Record<string, unknown>>;
    return {
      items: rows.map((r) => this.decorateItem(r)),
      nextCursor: rows.length === limit && rows.length > 0 ? rows[rows.length - 1]!._row : null,
    };
  }

  /**
   * Bounded digest for harnesses/UI: new or materially changed items, open
   * questions, and decisions whose review date has passed. Unchanged
   * accepted risks are NOT re-presented every session (§9).
   */
  digest(orgId: number) {
    const now = Date.now();
    const items = (this.db
      .prepare(`SELECT * FROM review_items WHERE org_id = ? ORDER BY priority_score DESC, updated_at DESC LIMIT 500`)
      .all(orgId) as Array<Record<string, unknown>>).map((r) => this.decorateItem(r, now));
    const open = items.filter((i) => i.workflow !== 'closed');
    const openQuestions = this.db
      .prepare(`SELECT * FROM review_questions WHERE org_id = ? AND status IN ('open','needs_clarification') ORDER BY created_at LIMIT 50`)
      .all(orgId);
    const dueReviews = items.filter((i) => i.review_state === 'review_due' || i.review_state === 'reassessment_needed');
    return {
      orgId,
      generatedAt: new Date(now).toISOString(),
      counts: {
        open: open.length,
        proposed: items.filter((i) => i.assessment === 'proposed' && i.workflow !== 'closed').length,
        openQuestions: (openQuestions as unknown[]).length,
        dueReviews: dueReviews.length,
        acceptedRisks: items.filter((i) => i.disposition === 'accept_risk').length,
      },
      items: open.slice(0, 50).map((i) => this.compactItem(i)),
      questions: openQuestions,
      dueReviews: dueReviews.slice(0, 20).map((i) => this.compactItem(i)),
    };
  }

  getItem(orgId: number, itemId: string, includeHistory = true) {
    const item = this.db.prepare('SELECT * FROM review_items WHERE id = ? AND org_id = ?').get(itemId, orgId) as Record<string, unknown> | undefined;
    if (!item) throw new ReviewError('not_found', `review item ${itemId} not found in org ${orgId}`);
    const revision = this.db.prepare('SELECT * FROM review_item_revisions WHERE item_id = ? AND revision = ?').get(itemId, asNum(item.current_revision));
    const evidence = this.db.prepare('SELECT * FROM review_evidence_links WHERE item_id = ? ORDER BY created_at').all(itemId);
    const questions = this.db.prepare('SELECT * FROM review_questions WHERE item_id = ? ORDER BY created_at').all(itemId) as Array<{ id: string }>;
    const answers = questions.length
      ? this.db.prepare(`SELECT * FROM review_answers WHERE question_id IN (${questions.map(() => '?').join(',')}) ORDER BY created_at`).all(...(questions.map((q) => q.id) as never[]))
      : [];
    const decisions = this.db.prepare('SELECT * FROM review_decisions WHERE item_id = ? ORDER BY created_at').all(itemId);
    const ops = this.db.prepare('SELECT * FROM review_item_ops WHERE item_id = ? ORDER BY created_at').all(itemId);
    const events = includeHistory
      ? this.db.prepare('SELECT id, event_type, actor_kind, actor, provenance, payload_json, created_at FROM review_events WHERE item_id = ? ORDER BY created_at DESC LIMIT 50').all(itemId)
      : [];
    return { item: this.decorateItem(item), revision, evidence, questions, answers, decisions, operations: ops, events };
  }

  listQuestions(orgId: number, status?: string) {
    const where = status ? 'q.org_id = ? AND q.status = ?' : 'q.org_id = ?';
    const args: unknown[] = status ? [orgId, status] : [orgId];
    const questions = this.db.prepare(
      `SELECT q.*, i.title AS item_title, i.category AS item_category FROM review_questions q LEFT JOIN review_items i ON i.id = q.item_id WHERE ${where} ORDER BY q.created_at DESC LIMIT 100`,
    ).all(...args as never[]) as Array<Record<string, unknown>>;
    if (!questions.length) return [];
    const ids = questions.map((q) => String(q.id));
    const answers = this.db.prepare(
      `SELECT * FROM review_answers WHERE question_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`,
    ).all(...ids as never[]) as Array<Record<string, unknown>>;
    const byQ = new Map<string, Array<Record<string, unknown>>>();
    for (const a of answers) {
      const k = String(a.question_id);
      const list = byQ.get(k) ?? [];
      list.push(a);
      byQ.set(k, list);
    }
    return questions.map((q) => ({ ...q, answers: byQ.get(String(q.id)) ?? [] }));
  }

  listOrgAnnotations(orgId: number) {
    return this.db.prepare('SELECT * FROM org_annotations WHERE org_id = ? ORDER BY created_at DESC LIMIT 100').all(orgId);
  }

  // ── Writes (local collaboration state only — never endpoint actions) ──

  proposeItem(input: ProposeInput) {
    this.requireType(ITEM_TYPES, input.itemType, 'itemType');
    if (!input.title?.trim()) throw new ReviewError('invalid_params', 'title is required');
    const evidence = input.evidence ?? [];
    for (const e of evidence) this.validateEvidenceRef(input.orgId, e);
    const now = Date.now();
    const fingerprint = this.fingerprint(input);

    const idemHit = input.idempotencyKey ? this.eventByIdempotency(input.idempotencyKey) : null;
    if (idemHit) return { item: this.getItem(input.orgId, String(idemHit.item_id), false).item, created: false, idempotent: true };

    const existing = this.db.prepare('SELECT * FROM review_items WHERE org_id = ? AND fingerprint = ? AND (connection_id IS ? OR connection_id = ?)').get(input.orgId, fingerprint, input.connectionId ?? null, input.connectionId ?? null) as Record<string, unknown> | undefined;
    if (existing) {
      return { item: this.decorateItem(existing), created: false, duplicate: true };
    }

    const suppressed = this.matchingSuppression(input.orgId, fingerprint, input.sourceId);
    if (input.severity) this.requireType(SEVERITIES, input.severity, 'severity');
    if (input.confidence) this.requireType(CONFIDENCES, input.confidence, 'confidence');
    const severity = input.severity ?? severityFromImpact(input.impact);
    const confidence = input.confidence ?? null;
    const itemId = randomUUID();
    const closed = !!suppressed;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `INSERT INTO review_items (id, connection_id, org_id, fingerprint, item_type, category, title, workflow, assessment, disposition, review_state, impact, urgency, severity, confidence, priority_score, subject_json, current_revision, created_by_kind, created_by, created_at, updated_at, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        itemId, input.connectionId ?? null, input.orgId, fingerprint, input.itemType, input.category ?? null,
        input.title.trim(), closed ? 'closed' : 'new', 'proposed', closed ? 'dismiss' : 'none', 'current',
        input.impact ?? null, input.urgency ?? null, severity, confidence, priorityScore(severity, confidence), input.subject ? JSON.stringify(input.subject) : null,
        1, input.sourceKind, input.actor ?? input.sourceId ?? null, now, now, closed ? now : null,
      );
      this.db.prepare(
        `INSERT INTO review_item_revisions (id, item_id, revision, title, summary, rationale, consequence, knowns_unknowns, proposed_impact, proposed_urgency, proposed_severity, proposed_confidence, source_kind, source_id, source_version, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(), itemId, 1, input.title.trim(), input.summary ?? null, input.rationale ?? null,
        input.consequence ?? null, input.knownsUnknowns ?? null, input.impact ?? null, input.urgency ?? null, severity, confidence,
        input.sourceKind, input.sourceId ?? null, input.sourceVersion ?? null, input.actor ?? null, now,
      );
      this.insertEvent(itemId, input.orgId, input.connectionId ?? null, 'created', input.sourceKind, input.actor ?? null, input.provenance, { title: input.title, sourceId: input.sourceId }, input.idempotencyKey);
      for (const e of evidence) this.insertEvidenceLink(itemId, input.orgId, input.connectionId ?? null, e, input.actor ?? null);
      if (suppressed) {
        this.insertEvent(itemId, input.orgId, input.connectionId ?? null, 'closed', 'system', 'system', 'system', { disposition: 'dismiss', reason: `suppressed: ${suppressed.reason}`, suppressionId: suppressed.id });
      }
      for (const q of input.questions ?? []) this.insertQuestion(itemId, input.orgId, input.connectionId ?? null, q, input.sourceKind, input.actor ?? null);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { item: this.getItem(input.orgId, itemId, false).item, created: !closed, suppressed: closed, suppression: suppressed ?? undefined };
  }

  reviseItem(orgId: number, itemId: string, expectedRevision: number, changes: { title?: string | undefined; summary?: string | undefined; rationale?: string | undefined; consequence?: string | undefined; knownsUnknowns?: string | undefined; impact?: string | undefined; urgency?: string | undefined; severity?: string | undefined; confidence?: string | undefined }, actor: { kind: ActorKind; name?: string | undefined; provenance: Provenance; sourceId?: string | undefined; sourceVersion?: string }) {
    const item = this.mustGetItem(orgId, itemId);
    if (Number(item.current_revision) !== expectedRevision) {
      throw new ReviewError('revision_conflict', `item is at revision ${item.current_revision}, expected ${expectedRevision} — refetch before editing`);
    }
    if (changes.severity) this.requireType(SEVERITIES, changes.severity, 'severity');
    if (changes.confidence) this.requireType(CONFIDENCES, changes.confidence, 'confidence');
    const now = Date.now();
    const cur = this.db.prepare('SELECT * FROM review_item_revisions WHERE item_id = ? AND revision = ?').get(itemId, expectedRevision) as Record<string, unknown>;
    const next = expectedRevision + 1;
    const severity = changes.severity ?? asStr(cur.proposed_severity) ?? severityFromImpact(changes.impact ?? asStr(cur.proposed_impact));
    const confidence = changes.confidence ?? asStr(cur.proposed_confidence);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `INSERT INTO review_item_revisions (id, item_id, revision, title, summary, rationale, consequence, knowns_unknowns, proposed_impact, proposed_urgency, proposed_severity, proposed_confidence, source_kind, source_id, source_version, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(), itemId, next, changes.title ?? asStr(cur.title), changes.summary ?? asStr(cur.summary),
        changes.rationale ?? asStr(cur.rationale), changes.consequence ?? asStr(cur.consequence), changes.knownsUnknowns ?? asStr(cur.knowns_unknowns),
        changes.impact ?? asStr(cur.proposed_impact), changes.urgency ?? asStr(cur.proposed_urgency), severity, confidence,
        actor.kind, actor.sourceId ?? null, actor.sourceVersion ?? null, actor.name ?? null, now,
      );
      this.db.prepare('UPDATE review_items SET title = ?, impact = ?, urgency = ?, severity = ?, confidence = ?, priority_score = ?, current_revision = ?, updated_at = ? WHERE id = ?')
        .run(changes.title ?? asStr(cur.title), changes.impact ?? asStr(cur.proposed_impact), changes.urgency ?? asStr(cur.proposed_urgency), severity, confidence, priorityScore(severity, confidence), next, now, itemId);
      this.insertEvent(itemId, orgId, item.connection_id as string | null, 'revised', actor.kind, actor.name ?? null, actor.provenance, { revision: next, changed: Object.keys(changes) });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getItem(orgId, itemId, false);
  }

  addQuestion(orgId: number, q: { itemId?: string | undefined; question: string; whyItMatters?: string | undefined; answerType?: string | undefined }, actor: { kind: ActorKind; name?: string }) {
    if (q.answerType) this.requireType(ANSWER_TYPES, q.answerType, 'answerType');
    if (q.itemId) this.mustGetItem(orgId, q.itemId);
    const id = this.insertQuestion(q.itemId ?? null, orgId, null, q, actor.kind, actor.name ?? null);
    if (q.itemId) {
      this.insertEvent(q.itemId, orgId, null, 'question_asked', actor.kind, actor.name ?? null, 'reported', { questionId: id });
      // Open questions move the item to awaiting_context when tracked.
      this.db.prepare("UPDATE review_items SET workflow = CASE WHEN workflow IN ('new','triage','reviewed') THEN 'awaiting_context' ELSE workflow END, updated_at = ? WHERE id = ?").run(Date.now(), q.itemId);
    }
    return this.db.prepare('SELECT * FROM review_questions WHERE id = ?').get(id);
  }

  /**
   * Record an answer. "I don't know" is a valid terminal answer — the
   * question closes as answered with normalized {value:'unknown'} and will
   * not resurface unchanged (§7). A conflicting answer keeps the previous
   * row, marks the conflict, and flips the question to needs_clarification.
   */
  answerQuestion(orgId: number, questionId: string, input: { answerText: string; normalized?: Record<string, unknown> | undefined; actorKind: ActorKind; actor?: string | undefined; provenance: Provenance }, idempotencyKey?: string | undefined) {
    const q = this.db.prepare('SELECT * FROM review_questions WHERE id = ? AND org_id = ?').get(questionId, orgId) as Record<string, unknown> | undefined;
    if (!q) throw new ReviewError('not_found', `question ${questionId} not found in org ${orgId}`);
    if (q.status === 'answered') {
      const prior = this.db.prepare('SELECT * FROM review_answers WHERE question_id = ? AND is_current = 1').get(questionId) as Record<string, unknown> | undefined;
      if (prior && String(prior.answer_text).trim().toLowerCase() === input.answerText.trim().toLowerCase()) {
        return { question: q, answer: prior, duplicate: true };
      }
    }
    const now = Date.now();
    const normalized = input.normalized ?? (UNKNOWN_ANSWER.test(input.answerText) ? { value: 'unknown' } : undefined);
    const prior = this.db.prepare('SELECT * FROM review_answers WHERE question_id = ? AND is_current = 1').get(questionId) as Record<string, unknown> | undefined;
    const conflicts = prior && String(prior.answer_text).trim().toLowerCase() !== input.answerText.trim().toLowerCase() && String(prior.normalized_json ?? '') !== JSON.stringify(normalized ?? null);
    const answerId = randomUUID();
    this.db.exec('BEGIN');
    try {
      if (conflicts) {
        this.db.prepare('UPDATE review_answers SET is_current = 0 WHERE question_id = ?').run(questionId);
      }
      this.db.prepare(
        `INSERT INTO review_answers (id, question_id, connection_id, org_id, answer_text, normalized_json, actor_kind, actor, provenance, is_current, conflicts_with, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(answerId, questionId, asStr(q.connection_id), orgId, input.answerText, normalized ? JSON.stringify(normalized) : null, input.actorKind, input.actor ?? null, input.provenance, 1, conflicts ? String(prior!.id) : null, now);
      this.db.prepare('UPDATE review_questions SET status = ? WHERE id = ?').run(conflicts ? 'needs_clarification' : 'answered', questionId);
      if (q.item_id) {
        this.insertEvent(String(q.item_id), orgId, null, 'question_answered', input.actorKind, input.actor ?? null, input.provenance, { questionId, answerId, conflicts: !!conflicts }, idempotencyKey);
        this.db.prepare("UPDATE review_items SET workflow = CASE WHEN workflow = 'awaiting_context' THEN 'triage' ELSE workflow END, updated_at = ? WHERE id = ?").run(now, asStr(q.item_id));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { question: this.db.prepare('SELECT * FROM review_questions WHERE id = ?').get(questionId), answer: this.db.prepare('SELECT * FROM review_answers WHERE id = ?').get(answerId), conflict: !!conflicts };
  }

  /**
   * Human-supplied organization context — lifecycle, ownership, intent.
   * Stored as an annotation, never promoted into machine-collected
   * evidence (§10). Attribution is recorded honestly: a harness relay is
   * 'reported_human', a UI action 'direct_human'.
   */
  addOrgAnnotation(orgId: number, input: { annotationType: string; subject?: Record<string, unknown> | undefined; text: string; attribution: 'direct_human' | 'reported_human'; actor?: string | undefined; sourceNote?: string | undefined }) {
    this.requireType(ANNOTATION_TYPES, input.annotationType, 'annotationType');
    if (!input.text?.trim()) throw new ReviewError('invalid_params', 'text is required');
    if (!['direct_human', 'reported_human'].includes(input.attribution)) {
      throw new ReviewError('invalid_params', 'attribution must be direct_human or reported_human');
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO org_annotations (id, connection_id, org_id, annotation_type, subject_json, text, attribution, actor, source_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, null, orgId, input.annotationType, input.subject ? JSON.stringify(input.subject) : null, input.text.trim(), input.attribution, input.actor ?? null, input.sourceNote ?? null, Date.now());
    return this.db.prepare('SELECT * FROM org_annotations WHERE id = ?').get(id);
  }

  /**
   * Record a human disposition. Requires direct (authenticated UI) or
   * delegated (explicit instruction relayed through a harness) provenance —
   * a reported remark is never a decision. verified_resolved additionally
   * requires an evidence basis; closing without verification is recorded
   * explicitly as unverified_closure (§6).
   */
  recordDecision(orgId: number, itemId: string, input: { disposition: Disposition; rationale?: string | undefined; owner?: string | undefined; scopeNote?: string | undefined; reviewDueAt?: number | undefined; evidenceBasis?: unknown | undefined; actorKind: ActorKind; actor?: string | undefined; provenance: Provenance; canonicalItemId?: string | undefined }, idempotencyKey?: string | undefined) {
    this.requireType(DISPOSITIONS, input.disposition, 'disposition');
    if (input.disposition === 'none') throw new ReviewError('invalid_params', 'use reviseItem to clear fields; disposition none is not a decision');
    if (!DECISION_PROVENANCES.has(input.provenance)) {
      throw new ReviewError('forbidden', 'decisions require direct or delegated provenance — a reported statement is context, not a decision');
    }
    if (input.disposition === 'verified_resolved' && !input.evidenceBasis) {
      throw new ReviewError('invalid_params', 'verified_resolved requires an evidence basis — otherwise use unverified_closure');
    }
    if (['dismiss', 'unverified_closure', 'accept_risk'].includes(input.disposition) && !input.rationale?.trim()) {
      throw new ReviewError('invalid_params', `${input.disposition} requires a recorded rationale`);
    }
    const item = this.mustGetItem(orgId, itemId);
    const now = Date.now();
    const decisionId = randomUUID();
    this.db.exec('BEGIN');
    try {
      const prev = this.db.prepare('SELECT id FROM review_decisions WHERE item_id = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 1').get(itemId) as { id: string } | undefined;
      if (prev) this.db.prepare('UPDATE review_decisions SET superseded_by = ? WHERE id = ?').run(decisionId, prev.id);
      this.db.prepare(
        `INSERT INTO review_decisions (id, item_id, connection_id, org_id, disposition, rationale, owner, scope_note, review_due_at, evidence_basis_json, actor_kind, actor, provenance, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(decisionId, itemId, asStr(item.connection_id), orgId, input.disposition, input.rationale ?? null, input.owner ?? null, input.scopeNote ?? null, input.reviewDueAt ?? null, input.evidenceBasis ? JSON.stringify(input.evidenceBasis) : null, input.actorKind, input.actor ?? null, input.provenance, now);
      const closing = CLOSING_DISPOSITIONS.has(input.disposition);
      const nextAssessment = input.disposition === 'dismiss' ? 'not_applicable'
        : input.disposition === 'accept_risk' || input.disposition === 'verified_resolved' ? 'confirmed'
        : null;
      this.db.prepare('UPDATE review_items SET disposition = ?, workflow = ?, assessment = COALESCE(?, assessment), due_at = ?, closed_at = ?, canonical_item_id = ?, updated_at = ? WHERE id = ?')
        .run(
          input.disposition,
          closing ? 'closed' : 'reviewed',
          nextAssessment,
          input.reviewDueAt ?? null, closing ? now : null,
          input.disposition === 'duplicate' ? input.canonicalItemId ?? null : null,
          now, itemId,
        );
      this.insertEvent(itemId, orgId, item.connection_id as string | null, 'decision_recorded', input.actorKind, input.actor ?? null, input.provenance, { decisionId, disposition: input.disposition, rationale: input.rationale }, idempotencyKey);
      if (closing) this.insertEvent(itemId, orgId, item.connection_id as string | null, 'closed', input.actorKind, input.actor ?? null, input.provenance, { disposition: input.disposition });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getItem(orgId, itemId, false);
  }

  /**
   * New contradictory evidence on a decided item: flag reassessment without
   * touching the recorded decision (§6). The item reappears in digests via
   * review_state, preserving the prior human decision.
   */
  flagReassessment(orgId: number, itemId: string, input: { reason: string; evidence?: EvidenceRef[] | undefined; actorKind: ActorKind; actor?: string }) {
    const item = this.mustGetItem(orgId, itemId);
    this.db.exec('BEGIN');
    try {
      for (const e of input.evidence ?? []) {
        this.validateEvidenceRef(orgId, e);
        this.insertEvidenceLink(itemId, orgId, item.connection_id as string | null, e, input.actor ?? null);
      }
      this.db.prepare("UPDATE review_items SET review_state = 'reassessment_needed', workflow = CASE WHEN workflow = 'closed' THEN 'closed' ELSE 'triage' END, updated_at = ? WHERE id = ?").run(Date.now(), itemId);
      this.insertEvent(itemId, orgId, item.connection_id as string | null, 'reassessment_flagged', input.actorKind, input.actor ?? null, 'system', { reason: input.reason });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getItem(orgId, itemId, false);
  }

  addSuppression(orgId: number, input: { fingerprint?: string | undefined; ruleId?: string | undefined; itemId?: string | undefined; reason: string; actor?: string | undefined; expiresAt?: number | undefined }) {
    if (!input.reason?.trim()) throw new ReviewError('invalid_params', 'reason is required');
    if (!input.fingerprint && !input.ruleId && !input.itemId) throw new ReviewError('invalid_params', 'suppression needs a scope: fingerprint, ruleId, or itemId');
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO review_suppressions (id, connection_id, org_id, scope_json, reason, actor, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, null, orgId, JSON.stringify({ fingerprint: input.fingerprint ?? null, ruleId: input.ruleId ?? null, itemId: input.itemId ?? null }), input.reason.trim(), input.actor ?? null, input.expiresAt ?? null, Date.now());
    return this.db.prepare('SELECT * FROM review_suppressions WHERE id = ?').get(id);
  }

  /**
   * Attach an existing operation/plan as related work. A link is a
   * reference — it neither approves nor dispatches anything (§11).
   */
  linkOperation(orgId: number, itemId: string, input: { operationId?: string | undefined; planId?: string | undefined; linkKind: string; actor?: string }) {
    this.requireType(OP_LINK_KINDS, input.linkKind, 'linkKind');
    if (!input.operationId && !input.planId) throw new ReviewError('invalid_params', 'operationId or planId required');
    const item = this.mustGetItem(orgId, itemId);
    if (input.operationId) {
      const op = this.db.prepare('SELECT id, target_id, target_type FROM operations WHERE id = ?').get(input.operationId) as Record<string, unknown> | undefined;
      if (!op) throw new ReviewError('not_found', `operation ${input.operationId} not found`);
      const opOrg = this.orgForTarget(op);
      if (opOrg !== orgId) throw new ReviewError('forbidden', 'operation belongs to a different organization');
    }
    if (input.planId) {
      const plan = this.db.prepare('SELECT id, target_id, target_type FROM operation_plans WHERE id = ?').get(input.planId) as Record<string, unknown> | undefined;
      if (!plan) throw new ReviewError('not_found', `plan ${input.planId} not found`);
      const planOrg = this.orgForTarget(plan);
      if (planOrg !== orgId) throw new ReviewError('forbidden', 'plan belongs to a different organization');
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO review_item_ops (id, item_id, connection_id, org_id, operation_id, plan_id, link_kind, added_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, itemId, asStr(item.connection_id), orgId, input.operationId ?? null, input.planId ?? null, input.linkKind, input.actor ?? null, Date.now());
    this.insertEvent(itemId, orgId, item.connection_id as string | null, 'linked_operation', 'harness', input.actor ?? null, 'reported', { linkId: id, operationId: input.operationId, planId: input.planId, linkKind: input.linkKind });
    return this.db.prepare('SELECT * FROM review_item_ops WHERE id = ?').get(id);
  }

  /**
   * Import existing infra findings (kind='finding') as proposed review
   * items, preserving original timestamps and source identity. Idempotent
   * via fingerprint = finding:{rule_id}:{annotation_id} — reruns update
   * nothing and invent no human confirmations.
   */
  importFindings(orgId: number): { imported: number; skipped: number; suppressed: number } {
    const rows = this.db
      .prepare("SELECT * FROM infra_annotations WHERE org_id = ? AND kind = 'finding' ORDER BY created_at")
      .all(orgId) as Array<Record<string, unknown>>;
    let imported = 0;
    let skipped = 0;
    let suppressed = 0;
    for (const a of rows) {
      const fingerprint = `finding:${a.rule_id}:${a.id}`;
      const exists = this.db.prepare('SELECT id, current_revision FROM review_items WHERE org_id = ? AND fingerprint = ?').get(orgId, fingerprint) as { id: string; current_revision: number } | undefined;
      if (exists) {
        skipped++;
        // Backfill consequence/questions on items imported before the rule
        // meta existed — revisions are immutable, so enrich via a new
        // revision only if the current one has no consequence.
        const meta = FINDING_RULE_META[String(a.rule_id)];
        if (meta) {
          const rev = this.db.prepare('SELECT consequence FROM review_item_revisions WHERE item_id = ? AND revision = ?').get(exists.id, exists.current_revision) as { consequence: string | null } | undefined;
          if (rev && !rev.consequence) {
            this.db.prepare('UPDATE review_item_revisions SET consequence = ?, knowns_unknowns = ? WHERE item_id = ? AND revision = ?')
              .run(meta.consequence, meta.knownsUnknowns ?? null, exists.id, exists.current_revision);
          }
          const hasQ = this.db.prepare('SELECT 1 FROM review_questions WHERE item_id = ? LIMIT 1').get(exists.id);
          if (!hasQ && meta.questions.length) {
            const entityName = String((this.db.prepare('SELECT display_name FROM infra_entities WHERE id = ?').get(asStr(a.entity_id) ?? '') as { display_name?: string } | undefined)?.display_name ?? 'this item');
            for (const q of meta.questions) {
              this.insertQuestion(exists.id, orgId, asStr(a.connection_id), {
                question: q.question.replace(/\bthis server\b/i, entityName).replace(/\bthis GPO\b/i, entityName).replace(/\bthis zone\b/i, entityName).replace(/\bthis item\b/i, entityName),
                whyItMatters: q.whyItMatters, answerType: q.answerType,
              }, 'rule', 'system');
            }
            this.db.prepare("UPDATE review_items SET workflow = 'awaiting_context' WHERE id = ? AND workflow = 'new'").run(exists.id);
          }
          // Backfill triage rating on items imported before the rule carried one.
          if (meta.severity || meta.confidence) {
            const cur = this.db.prepare('SELECT severity, confidence FROM review_items WHERE id = ?').get(exists.id) as { severity: string | null; confidence: string | null };
            const sev = cur.severity ?? meta.severity ?? null;
            const conf = cur.confidence ?? meta.confidence ?? null;
            if (sev !== cur.severity || conf !== cur.confidence) {
              this.db.prepare('UPDATE review_items SET severity = ?, confidence = ?, priority_score = ? WHERE id = ?')
                .run(sev, conf, priorityScore(sev, conf), exists.id);
            }
          }
        }
        continue;
      }
      // Suppressed rules/fingerprints never surface as items — recorded
      // suppressions are durable; findings stay in infra_annotations.
      if (this.matchingSuppression(orgId, fingerprint, String(a.rule_id ?? ''))) { suppressed++; continue; }
      const itemType: ItemType = /unauthoriz|firewall|nonsecure|orphan|risk/i.test(String(a.rule_id)) ? 'risk' : 'observation';
      const meta = FINDING_RULE_META[String(a.rule_id)];
      const created = Number(a.created_at) || Date.now();
      const itemId = randomUUID();
      this.db.exec('BEGIN');
      try {
        this.db.prepare(
          `INSERT INTO review_items (id, connection_id, org_id, fingerprint, item_type, category, title, workflow, assessment, disposition, review_state, severity, confidence, priority_score, subject_json, current_revision, created_by_kind, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(itemId, asStr(a.connection_id), orgId, fingerprint, itemType, 'infrastructure', String(a.title), 'new', 'proposed', 'none', 'current',
          meta?.severity ?? null, meta?.confidence ?? null, priorityScore(meta?.severity, meta?.confidence),
          JSON.stringify({ entityId: a.entity_id ?? null }), 1, 'rule', String(a.rule_id ?? 'unknown'), created, created);
        this.db.prepare(
          `INSERT INTO review_item_revisions (id, item_id, revision, title, summary, rationale, consequence, knowns_unknowns, proposed_severity, proposed_confidence, source_kind, source_id, source_version, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(randomUUID(), itemId, 1, String(a.title), String(a.detail ?? ''), `deterministic rule ${a.rule_id} v${a.rule_version ?? 1}`,
          meta?.consequence ?? 'Review the finding detail and linked evidence; the producing rule flagged this as worth a human look.',
          meta?.knownsUnknowns ?? null, meta?.severity ?? null, meta?.confidence ?? null,
          'rule', String(a.rule_id ?? 'unknown'), String(a.rule_version ?? 1), 'system', created);
        this.db.prepare(
          `INSERT INTO review_evidence_links (id, item_id, connection_id, org_id, link_type, entity_id, operation_id, annotation_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(randomUUID(), itemId, asStr(a.connection_id), orgId, 'annotation', asStr(a.entity_id) ?? null, asStr(a.operation_id), String(a.id), created);
        this.insertEvent(itemId, orgId, a.connection_id as string | null, 'created', 'rule', 'system', 'system', { importedFrom: 'infra_annotations', annotationId: a.id }, `import:${a.id}`);
        if (meta?.questions?.length) {
          const entityName = String((this.db.prepare('SELECT display_name FROM infra_entities WHERE id = ?').get(asStr(a.entity_id) ?? '') as { display_name?: string } | undefined)?.display_name ?? 'this item');
          for (const q of meta.questions) {
            this.insertQuestion(itemId, orgId, asStr(a.connection_id), {
              question: q.question.replace(/\bthis server\b/i, entityName).replace(/\bthis GPO\b/i, entityName).replace(/\bthis zone\b/i, entityName).replace(/\bthis item\b/i, entityName),
              whyItMatters: q.whyItMatters, answerType: q.answerType,
            }, 'rule', 'system');
          }
          this.db.prepare("UPDATE review_items SET workflow = 'awaiting_context' WHERE id = ?").run(itemId);
        }
        this.db.exec('COMMIT');
        imported++;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return { imported, skipped, suppressed };
  }

  /**
   * Deterministic reassessment pass (§13): a decided item whose linked
   * entities gain a NEW finding after the decision is flagged
   * 'reassessment_needed' — the recorded decision is preserved; the item
   * resurfaces in digests. Runs on the ingestion sweep; bounded to
   * already-collected evidence, idempotent via review_state.
   */
  reassessDecidedItems(orgId: number): { flagged: number } {
    const items = this.db
      .prepare(
        `SELECT i.id, MAX(d.created_at) AS last_decision_at
         FROM review_items i JOIN review_decisions d ON d.item_id = i.id
         WHERE i.org_id = ? AND i.disposition != 'none' AND i.review_state != 'reassessment_needed'
         GROUP BY i.id`,
      )
      .all(orgId) as Array<{ id: string; last_decision_at: number }>;
    let flagged = 0;
    for (const it of items) {
      const hit = this.db
        .prepare(
          `SELECT a.id, a.title FROM infra_annotations a
           WHERE a.org_id = ? AND a.kind = 'finding' AND a.created_at > ?
             AND a.entity_id IN (SELECT entity_id FROM review_evidence_links WHERE item_id = ? AND entity_id IS NOT NULL)
           LIMIT 1`,
        )
        .get(orgId, it.last_decision_at ?? 0, it.id) as { id: string; title: string } | undefined;
      if (hit) {
        this.flagReassessment(orgId, it.id, { reason: `new finding after decision: ${String(hit.title)}`, actorKind: 'system', actor: 'reassessment-sweep' });
        flagged++;
      }
    }
    return { flagged };
  }

  // ── internals ──────────────────────────────────────────────────────

  private mustGetItem(orgId: number, itemId: string): Record<string, unknown> {
    const item = this.db.prepare('SELECT * FROM review_items WHERE id = ? AND org_id = ?').get(itemId, orgId) as Record<string, unknown> | undefined;
    if (!item) throw new ReviewError('not_found', `review item ${itemId} not found in org ${orgId}`);
    return item;
  }

  private fingerprint(input: ProposeInput): string {
    const subject = input.subject ? JSON.stringify(input.subject, Object.keys(input.subject).sort()) : '';
    const basis = [input.orgId, input.itemType, (input.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim(), subject, input.sourceId ?? ''].join('|');
    return createHash('sha256').update(basis).digest('hex').slice(0, 32);
  }

  private matchingSuppression(orgId: number, fingerprint: string, ruleId?: string): { id: string; reason: string } | null {
    const now = Date.now();
    const rows = this.db.prepare('SELECT * FROM review_suppressions WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)').all(orgId, now) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const scope = JSON.parse(String(r.scope_json)) as { fingerprint?: string | undefined; ruleId?: string };
      if (scope.fingerprint === fingerprint || (ruleId && scope.ruleId === ruleId)) return { id: String(r.id), reason: String(r.reason) };
    }
    return null;
  }

  /**
   * Evidence links are validated against same-org rows — a copied foreign
   * ID is not authority (§10). Unresolvable or cross-org refs reject.
   */
  private validateEvidenceRef(orgId: number, e: EvidenceRef) {
    this.requireType(LINK_TYPES, e.linkType, 'linkType');
    switch (e.linkType) {
      case 'entity': {
        if (!e.entityId) throw new ReviewError('invalid_params', 'entity link requires entityId');
        const row = this.db.prepare('SELECT org_id FROM infra_entities WHERE id = ?').get(e.entityId) as { org_id: number } | undefined;
        if (!row) throw new ReviewError('not_found', `entity ${e.entityId} not found`);
        if (row.org_id !== orgId) throw new ReviewError('forbidden', 'entity belongs to a different organization');
        break;
      }
      case 'observation': {
        if (!e.observationId) throw new ReviewError('invalid_params', 'observation link requires observationId');
        const row = this.db.prepare('SELECT e.org_id FROM entity_observations o JOIN infra_entities e ON e.id = o.entity_id WHERE o.id = ?').get(e.observationId) as { org_id: number } | undefined;
        if (!row) throw new ReviewError('not_found', `observation ${e.observationId} not found`);
        if (row.org_id !== orgId) throw new ReviewError('forbidden', 'observation belongs to a different organization');
        break;
      }
      case 'operation': {
        if (!e.operationId) throw new ReviewError('invalid_params', 'operation link requires operationId');
        const row = this.db.prepare('SELECT target_type, target_id FROM operations WHERE id = ?').get(e.operationId) as Record<string, unknown> | undefined;
        if (!row) throw new ReviewError('not_found', `operation ${e.operationId} not found`);
        if (this.orgForTarget(row) !== orgId) throw new ReviewError('forbidden', 'operation belongs to a different organization');
        break;
      }
      case 'annotation': {
        if (!e.annotationId) throw new ReviewError('invalid_params', 'annotation link requires annotationId');
        const row = this.db.prepare('SELECT org_id FROM infra_annotations WHERE id = ?').get(e.annotationId) as { org_id: number } | undefined;
        if (!row) throw new ReviewError('not_found', `annotation ${e.annotationId} not found`);
        if (row.org_id !== orgId) throw new ReviewError('forbidden', 'annotation belongs to a different organization');
        break;
      }
      case 'relationship': {
        if (!e.observationId) throw new ReviewError('invalid_params', 'relationship link requires observationId (relationship_observations.id)');
        const row = this.db.prepare('SELECT e.org_id FROM relationship_observations r JOIN infra_entities e ON e.id = r.from_entity_id WHERE r.id = ?').get(e.observationId) as { org_id: number } | undefined;
        if (!row) throw new ReviewError('not_found', `relationship ${e.observationId} not found`);
        if (row.org_id !== orgId) throw new ReviewError('forbidden', 'relationship belongs to a different organization');
        break;
      }
    }
  }

  private orgForTarget(row: Record<string, unknown>): number | null {
    if (row.target_type === 'device') {
      const dev = this.db.prepare('SELECT org_id FROM entities_device WHERE device_id = ?').get(asNum(row.target_id)) as { org_id: number } | undefined;
      return dev?.org_id ?? null;
    }
    if (row.target_type === 'organization') return Number(row.target_id);
    return null;
  }

  private insertEvent(itemId: string, orgId: number, connectionId: string | null, eventType: string, actorKind: string, actor: string | null, provenance: string, payload: Record<string, unknown>, idempotencyKey?: string | undefined) {
    this.db.prepare(
      `INSERT INTO review_events (id, item_id, connection_id, org_id, event_type, actor_kind, actor, provenance, payload_json, idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), itemId, connectionId, orgId, eventType, actorKind, actor, provenance, JSON.stringify(payload), idempotencyKey ?? null, Date.now());
  }

  private insertEvidenceLink(itemId: string, orgId: number, connectionId: string | null, e: EvidenceRef, actor: string | null) {
    this.db.prepare(
      `INSERT INTO review_evidence_links (id, item_id, connection_id, org_id, link_type, entity_id, observation_id, operation_id, annotation_id, field_path, note, added_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), itemId, connectionId, orgId, e.linkType, e.entityId ?? null, e.observationId ?? null, e.operationId ?? null, e.annotationId ?? null, e.fieldPath ?? null, e.note ?? null, actor, Date.now());
  }

  private insertQuestion(itemId: string | null, orgId: number, connectionId: string | null, q: { question: string; whyItMatters?: string | undefined; answerType?: string | undefined }, actorKind: string, actor: string | null): string {
    if (!q.question?.trim()) throw new ReviewError('invalid_params', 'question text is required');
    if (q.answerType) this.requireType(ANSWER_TYPES, q.answerType, 'answerType');
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO review_questions (id, item_id, connection_id, org_id, question, why_it_matters, answer_type, status, created_by_kind, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, itemId, connectionId, orgId, q.question.trim(), q.whyItMatters ?? null, q.answerType ?? 'text', 'open', actorKind, actor, Date.now());
    return id;
  }

  private eventByIdempotency(key: string): { item_id: string } | undefined {
    return this.db.prepare('SELECT item_id FROM review_events WHERE idempotency_key = ?').get(key) as { item_id: string } | undefined;
  }

  private requireType(set: Set<string>, value: unknown, field: string) {
    if (typeof value !== 'string' || !set.has(value)) {
      throw new ReviewError('invalid_params', `${field} must be one of: ${[...set].join(', ')}`);
    }
  }

  /** Lazily computed review_due: due_at passed on a tracked disposition. */
  private decorateItem(r: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const due = r.due_at && Number(r.due_at) <= now && ['accept_risk', 'defer', 'monitor'].includes(String(r.disposition));
    return { ...r, review_state: due ? 'review_due' : r.review_state };
  }

  private compactItem(i: Record<string, unknown>) {
    return {
      id: i.id, item_type: i.item_type, category: i.category, title: i.title,
      workflow: i.workflow, assessment: i.assessment, disposition: i.disposition,
      review_state: i.review_state, impact: i.impact, urgency: i.urgency,
      severity: i.severity, confidence: i.confidence, priority_score: i.priority_score,
      created_by_kind: i.created_by_kind, updated_at: i.updated_at, due_at: i.due_at,
    };
  }
}
