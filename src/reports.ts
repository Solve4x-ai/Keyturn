/**
 * M6 — windowed management reporting (plan §11/§14-M6).
 *
 * A report answers "what did we do and what changed" over a caller-chosen
 * window (default: last quarter, ~90 days; `sinceDays` 1–400 or explicit
 * ISO `since`/`until`).
 *
 * Honesty rules (plan §11):
 * - "verified" means a receipt reconciled — never inferred from dispatch.
 * - Observed software removals come from real observation diffs; devices
 *   lacking a baseline before/inside the window are disclosed as gaps,
 *   never silently omitted or fabricated.
 * - Attempted-but-unconfirmed work is reported as attempted.
 * - Everything is esc()'d markdown-safe at render time.
 */
import type { EntityStore } from './entity-store.js';
import { stableKey } from './snapshots.js';

const QUARTER_MS = 91 * 24 * 60 * 60_000;
const MAX_WINDOW_MS = 400 * 24 * 60 * 60_000;

export interface ReportWindow {
  sinceMs: number;
  untilMs: number;
  sinceIso: string;
  untilIso: string;
  label: string;
}

export function resolveWindow(opts: { sinceDays?: number | undefined; since?: string | undefined; until?: string | undefined }): ReportWindow {
  const untilMs = opts.until ? Date.parse(opts.until) : Date.now();
  if (!Number.isFinite(untilMs)) throw new Error('invalid until date — use ISO 8601');
  let sinceMs: number;
  let label: string;
  if (opts.since) {
    sinceMs = Date.parse(opts.since);
    if (!Number.isFinite(sinceMs)) throw new Error('invalid since date — use ISO 8601');
    label = 'custom range';
  } else {
    const days = opts.sinceDays ?? 91;
    if (!Number.isFinite(days) || days < 1 || days > 400) throw new Error('sinceDays must be 1-400');
    sinceMs = untilMs - days * 24 * 60 * 60_000;
    label = `last ${days} days${days === 91 ? ' (quarter)' : ''}`;
  }
  if (sinceMs >= untilMs) throw new Error('since must be before until');
  if (untilMs - sinceMs > MAX_WINDOW_MS) throw new Error('window exceeds 400 days');
  return { sinceMs, untilMs, sinceIso: new Date(sinceMs).toISOString(), untilIso: new Date(untilMs).toISOString(), label };
}

function iso(ms: number | null | undefined): string {
  return typeof ms === 'number' ? new Date(ms).toISOString() : '—';
}

/** Windowed operations + software-change report over the evidence model. */
export function buildOperationsReport(
  store: EntityStore,
  window: ReportWindow,
  orgId?: number,
): Record<string, unknown> {
  const db = store.database;

  // ── Section 1: work performed (operations in window) ──────────────────
  const opRows = db
    .prepare(
      `SELECT o.id, o.operation, o.status, o.runbook_id, o.runbook_version, o.target_type, o.target_id, o.target_count,
              o.created_at, o.updated_at, o.result_json, p.args_canonical
         FROM operations o LEFT JOIN operation_plans p ON p.id = o.plan_id
        WHERE o.created_at BETWEEN ? AND ? ORDER BY o.created_at`,
    )
    .all(window.sinceMs, window.untilMs) as Array<Record<string, unknown>>;

  const work: Array<Record<string, unknown>> = [];
  const gap = { attempted: 0, verified: 0, failed: 0, skipped: 0, canceled: 0, unknown: 0, partial: 0 };
  for (const op of opRows) {
    const args = op.args_canonical ? JSON.parse(String(op.args_canonical)) as Record<string, unknown> : {};
    const isBatch = op.target_type === 'selection';
    const targets = isBatch
      ? (db.prepare('SELECT device_id, status, safe_error, result_json, updated_at FROM operation_targets WHERE operation_id = ?').all(String(op.id)) as Array<Record<string, unknown>>)
      : [{
          device_id: op.target_id, status: op.status, safe_error: null,
          result_json: op.result_json, updated_at: op.updated_at,
        }];
    for (const t of targets) {
      const dev = store.getDeviceById(Number(t.device_id));
      if (orgId !== undefined && Number(dev?.org_id) !== orgId) continue;
      const status = String(t.status);
      if (status in gap) gap[status as keyof typeof gap] += 1;
      const parsed = t.result_json ? (JSON.parse(String(t.result_json)) as Record<string, unknown>).parsed : null;
      work.push({
        deviceId: t.device_id,
        device: dev?.display_name ?? `device ${t.device_id}`,
        orgId: dev?.org_id ?? null,
        org: typeof dev?.org_id === 'number' ? store.orgName(dev.org_id as number) : null,
        runbook: op.runbook_id ? `${op.runbook_id} v${op.runbook_version}` : 'custom command',
        operationId: op.id,
        batch: isBatch,
        status,
        verifiedSoftware: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).verified ?? null : null,
        finishedAt: iso(Number(t.updated_at)),
      });
    }
  }

  // ── Section 2: observed software change (observation diffs) ───────────
  // Per device: baseline = last software_inventory observation at-or-before
  // window start; comparison = last inside the window. No baseline → the
  // device lands in coverageGaps, never silently excluded.
  const devices = orgId !== undefined
    ? store.listDevices({ orgId, pageSize: 500 }).rows
    : store.listDevices({ pageSize: 500 }).rows;
  const softwareChanges: Array<Record<string, unknown>> = [];
  const coverageGaps: Array<Record<string, unknown>> = [];
  for (const dev of devices) {
    const did = Number(dev.device_id);
    const obs = db
      .prepare(
        `SELECT o.fetched_at, o.completeness, o.collection_status, p.canonical_json
           FROM device_resource_observations o
           LEFT JOIN device_resource_payloads p ON p.id = o.payload_id
          WHERE o.device_id = ? AND o.resource_type = 'software_inventory' AND o.collection_status = 'succeeded'
          ORDER BY o.fetched_at`,
      )
      .all(did) as Array<Record<string, unknown>>;
    if (obs.length === 0) {
      coverageGaps.push({ deviceId: did, device: dev.display_name ?? `device ${did}`, reason: 'no software_inventory observations on record' });
      continue;
    }
    const baseline = [...obs].reverse().find((o) => Number(o.fetched_at) <= window.sinceMs) ?? obs[0];
    const latest = [...obs].reverse().find((o) => Number(o.fetched_at) <= window.untilMs);
    if (!baseline || !latest || baseline === latest) {
      coverageGaps.push({ deviceId: did, device: dev.display_name ?? `device ${did}`, reason: 'single observation only — nothing to diff within window' });
      continue;
    }
    const bItems = (JSON.parse(String(baseline.canonical_json ?? '{}')) as { items?: Array<Record<string, unknown>> }).items ?? [];
    const cItems = (JSON.parse(String(latest.canonical_json ?? '{}')) as { items?: Array<Record<string, unknown>> }).items ?? [];
    const bKeys = new Map(bItems.map((i) => [stableKey(i) ?? JSON.stringify(i), i]));
    const cKeys = new Map(cItems.map((i) => [stableKey(i) ?? JSON.stringify(i), i]));
    const removed = bItems.filter((i) => !cKeys.has(stableKey(i) ?? JSON.stringify(i))).map((i) => i.name ?? i.Name ?? JSON.stringify(i).slice(0, 80));
    const added = cItems.filter((i) => !bKeys.has(stableKey(i) ?? JSON.stringify(i))).map((i) => i.name ?? i.Name ?? JSON.stringify(i).slice(0, 80));
    softwareChanges.push({
      deviceId: did,
      device: dev.display_name ?? `device ${did}`,
      baselineAt: iso(Number(baseline.fetched_at)),
      comparedAt: iso(Number(latest.fetched_at)),
      baselineInsideWindow: Number(baseline.fetched_at) > window.sinceMs,
      removed,
      added,
      removedCount: removed.length,
      addedCount: added.length,
    });
  }

  // ── Section 3: coverage honesty ───────────────────────────────────────
  const coveredDevices = new Set(softwareChanges.map((c) => c.deviceId));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window,
    scope: { orgId: orgId ?? 'all', orgName: orgId !== undefined ? store.orgName(orgId) : null },
    summary: {
      deviceTargets: work.length,
      ...gap,
      softwareObserved: { devicesDiffed: softwareChanges.length, devicesRemoved: softwareChanges.filter((c) => (c.removedCount as number) > 0).length, coverageGaps: coverageGaps.length },
      fleetSize: devices.length,
      devicesWithSoftwareEvidence: coveredDevices.size,
    },
    work,
    softwareChanges,
    coverageGaps,
    disclosures: [
      'verified means an upstream receipt reconciled — dispatch alone never counts.',
      'Observed software removals come from real inventory diffs; unattributed changes are not claimed as work performed.',
      'Devices without a baseline observation are listed in coverageGaps — coverage is never fabricated.',
      `Baseline may sit inside the window when no earlier observation exists (baselineInsideWindow flag).`,
    ],
  };
  return report;
}

/**
 * REVIEW-1 R5 — full organization report: operations work + infrastructure
 * state/changes + review outcomes, all windowed, all evidence-backed.
 * Review outcomes distinguish proposed/confirmed/accepted/deferred/
 * dismissed/verified-resolved — never flattened (plan §14).
 */
export function buildOrgReport(
  store: EntityStore,
  window: ReportWindow,
  orgId: number,
): Record<string, unknown> {
  const db = store.database;
  const ops = buildOperationsReport(store, window, orgId);

  // ── Infrastructure: current state + change volume in window ──────────
  const catRows = db
    .prepare(
      `SELECT e.category, c.status, COUNT(*) AS n FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
       WHERE e.org_id = ? GROUP BY e.category, c.status`,
    )
    .all(orgId) as Array<{ category: string; status: string; n: number }>;
  const infraCounts: Record<string, Record<string, number>> = {};
  for (const r of catRows) (infraCounts[r.category] ??= {})[r.status] = r.n;

  const obsRows = db
    .prepare(
      `SELECT e.category, COUNT(*) AS n FROM entity_observations o JOIN infra_entities e ON e.id = o.entity_id
       WHERE e.org_id = ? AND o.collected_at BETWEEN ? AND ? GROUP BY e.category`,
    )
    .all(orgId, window.sinceMs, window.untilMs) as Array<{ category: string; n: number }>;

  const covRows = db
    .prepare(
      `SELECT section, status, MAX(collected_at) AS last_at FROM collection_coverage
       WHERE org_id = ? GROUP BY section, status`,
    )
    .all(orgId) as Array<{ section: string; status: string; last_at: number }>;

  // ── Review outcomes: proposals, decisions, questions in window ────────
  const itemsInWindow = db
    .prepare(
      `SELECT item_type, assessment, disposition, workflow, COUNT(*) AS n FROM review_items
       WHERE org_id = ? AND created_at BETWEEN ? AND ? GROUP BY item_type, assessment, disposition, workflow`,
    )
    .all(orgId, window.sinceMs, window.untilMs) as Array<Record<string, unknown>>;
  const decisionsInWindow = db
    .prepare(
      `SELECT disposition, COUNT(*) AS n FROM review_decisions
       WHERE org_id = ? AND created_at BETWEEN ? AND ? GROUP BY disposition`,
    )
    .all(orgId, window.sinceMs, window.untilMs) as Array<{ disposition: string; n: number }>;
  const openQuestions = db
    .prepare(`SELECT COUNT(*) AS n FROM review_questions WHERE org_id = ? AND status IN ('open','needs_clarification')`)
    .get(orgId) as { n: number };
  const reassessed = db
    .prepare(`SELECT COUNT(*) AS n FROM review_events WHERE org_id = ? AND event_type = 'reassessment_flagged' AND created_at BETWEEN ? AND ?`)
    .get(orgId, window.sinceMs, window.untilMs) as { n: number };
  const suppressions = db
    .prepare(`SELECT COUNT(*) AS n FROM review_suppressions WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)`)
    .get(orgId, Date.now()) as { n: number };
  const openItems = db
    .prepare(`SELECT item_type, COUNT(*) AS n FROM review_items WHERE org_id = ? AND workflow != 'closed' GROUP BY item_type`)
    .all(orgId) as Array<{ item_type: string; n: number }>;

  return {
    ...ops,
    schemaVersion: 2,
    reportType: 'org',
    scope: { orgId, orgName: store.orgName(orgId) },
    infrastructure: {
      entityCounts: infraCounts,
      observationsInWindow: Object.fromEntries(obsRows.map((r) => [r.category, r.n])),
      coverage: covRows.map((c) => ({ section: c.section, status: c.status, lastCollected: iso(Number(c.last_at)) })),
    },
    review: {
      itemsCreatedInWindow: itemsInWindow,
      decisionsInWindow: Object.fromEntries(decisionsInWindow.map((d) => [d.disposition, d.n])),
      openQuestionsNow: openQuestions.n,
      reassessmentsInWindow: reassessed.n,
      activeSuppressions: suppressions.n,
      openItemsByType: Object.fromEntries(openItems.map((i) => [i.item_type, i.n])),
    },
    disclosures: [
      ...(ops.disclosures as string[]),
      'Review items marked proposed are unconfirmed machine assessments — they become confirmed only through a recorded human decision.',
      'Accepted risk is a decision, not a remediation; verified_resolved requires an evidence basis — unverified_closure is the honest alternative.',
      'Infrastructure counts are evidence projections: "not observed" requires a complete enumeration; uncollected sections are disclosed in coverage.',
      'As-of questions are answerable by replaying entity_observations — every row is immutable and timestamped.',
    ],
  };
}

/** Markdown rendering for the full org report. */
export function renderOrgReportMarkdown(report: Record<string, unknown>): string {
  const base = renderReportMarkdown(report);
  const md = (s: unknown) => String(s ?? '').replace(/[|`*_[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const infra = report.infrastructure as Record<string, unknown> | undefined;
  const review = report.review as Record<string, unknown> | undefined;
  const lines: string[] = [base];
  if (infra) {
    lines.push('', '## Infrastructure (current evidence)', '');
    const counts = infra.entityCounts as Record<string, Record<string, number>>;
    const catLines = Object.entries(counts).map(([cat, st]) => `- ${md(cat)}: ${Object.entries(st).map(([s, n]) => `${n} ${s}`).join(', ')}`);
    lines.push(...(catLines.length ? catLines : ['_No infrastructure evidence collected._']));
    const obs = infra.observationsInWindow as Record<string, number>;
    if (Object.keys(obs).length) lines.push('', `Observations in window: ${Object.entries(obs).map(([c, n]) => `${md(c)} ×${n}`).join(', ')}`);
  }
  if (review) {
    lines.push('', '## Review outcomes', '');
    const dec = review.decisionsInWindow as Record<string, number>;
    lines.push(`- Decisions in window: ${Object.keys(dec).length ? Object.entries(dec).map(([d, n]) => `${n} ${md(d)}`).join(', ') : 'none'}`);
    lines.push(`- Open questions now: **${review.openQuestionsNow}** · Reassessments flagged: **${review.reassessmentsInWindow}** · Active suppressions: **${review.activeSuppressions}**`);
    const open = review.openItemsByType as Record<string, number>;
    lines.push(`- Open items: ${Object.keys(open).length ? Object.entries(open).map(([t, n]) => `${n} ${md(t)}`).join(', ') : 'none'}`);
  }
  return lines.join('\n');
}

/** Markdown rendering — escaped, plain-language, management-readable. */
export function renderReportMarkdown(report: Record<string, unknown>): string {
  const md = (s: unknown) => String(s ?? '').replace(/[|`*_[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = report.window as ReportWindow;
  const s = report.summary as Record<string, unknown>;
  const scope = report.scope as { orgId: number | string; orgName: string | null };
  const lines: string[] = [
    `# Operations & Software Report`,
    ``,
    `**Window:** ${md(w.sinceIso.slice(0, 10))} → ${md(w.untilIso.slice(0, 10))} (${md(w.label)})`,
    `**Scope:** ${md(scope.orgName ?? scope.orgId)}`,
    `**Generated:** ${md(String(report.generatedAt).slice(0, 19))}`,
    ``,
    `## Summary`,
    ``,
    `- Device targets touched: **${s.deviceTargets}**`,
    `- Verified: **${s.verified}** · Failed: **${s.failed}** · Skipped: **${s.skipped}** · Canceled: **${s.canceled}** · Unknown: **${s.unknown}** · Partial ops: **${s.partial}**`,
    `- Software diffs computed for **${(s.softwareObserved as Record<string, number>).devicesDiffed}** devices; **${(s.softwareObserved as Record<string, number>).devicesRemoved}** show removals`,
    `- Coverage gaps: **${(s.softwareObserved as Record<string, number>).coverageGaps}** device(s) lack comparable evidence`,
    ``,
    `## Work performed`,
    ``,
  ];
  const work = report.work as Array<Record<string, unknown>>;
  if (work.length === 0) {
    lines.push('_No operations ran in this window._');
  } else {
    lines.push('| Device | Action | Status | Verified | Finished |', '|---|---|---|---|---|');
    for (const t of work) {
      lines.push(`| ${md(t.device)} | ${md(t.runbook)} | ${md(t.status)} | ${md(t.verifiedSoftware ?? '—')} | ${md(String(t.finishedAt).slice(0, 16))} |`);
    }
  }
  lines.push(``, `## Software changes observed`, ``);
  const changes = report.softwareChanges as Array<Record<string, unknown>>;
  const withRemovals = changes.filter((c) => (c.removedCount as number) > 0);
  if (withRemovals.length === 0) {
    lines.push('_No removals observed on devices with comparable evidence._');
  } else {
    for (const c of withRemovals) {
      lines.push(`### ${md(c.device)}`, ``, `Baseline ${md(String(c.baselineAt).slice(0, 10))} → ${md(String(c.comparedAt).slice(0, 10))}${c.baselineInsideWindow ? ' _(baseline inside window — earlier state unknown)_' : ''}`, ``);
      for (const name of c.removed as string[]) lines.push(`- removed: ${md(name)}`);
      if ((c.addedCount as number) > 0) lines.push(`- _+${c.addedCount} added (see JSON for detail)_`);
      lines.push(``);
    }
  }
  const gaps = report.coverageGaps as Array<Record<string, unknown>>;
  if (gaps.length) {
    lines.push(`## Coverage gaps`, ``);
    for (const g of gaps) lines.push(`- ${md(g.device)} — ${md(g.reason)}`);
    lines.push(``);
  }
  lines.push(`## Method notes`, ``);
  for (const d of report.disclosures as string[]) lines.push(`- ${md(d)}`);
  return lines.join('\n');
}
