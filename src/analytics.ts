/**
 * Analytics — windowed, read-only aggregates over the local store for the
 * Analytics page. Same honesty rules as the HUD: counts come from retained
 * records only; durations are reported only where a receipt recorded them;
 * a window with no data returns empty series, never interpolated values.
 */
import type { EntityStore } from './entity-store.js';

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
const toMs = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
};
const quantile = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
};

export function buildAnalytics(store: EntityStore, opts: { days?: number | undefined; orgId?: number | undefined; now?: number } = {}) {
  const db = store.database;
  const now = opts.now ?? Date.now();
  const days = Math.min(Math.max(Math.round(opts.days ?? 30), 1), 400);
  const orgId = opts.orgId;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const windowStart = start.getTime() - (days - 1) * DAY;

  const deviceOrg = new Map<number, number>();
  const deviceLabel = new Map<number, string>();
  const devices = db.prepare('SELECT device_id, system_name, display_name, org_id, node_class, offline, last_contact FROM entities_device').all() as Row[];
  for (const d of devices) {
    deviceOrg.set(num(d.device_id), num(d.org_id));
    deviceLabel.set(num(d.device_id), String(d.system_name ?? d.display_name ?? d.device_id));
  }
  const inScope = (deviceId: unknown) => orgId === undefined || deviceOrg.get(num(deviceId)) === orgId;
  const dayKey = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const emptyDays = () => Array.from({ length: days }, (_, i) => windowStart + i * DAY);
  const iso = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ── Operations ───────────────────────────────────────────────────────
  const connId = store.connId;
  const ops = (db
    .prepare(`SELECT id, target_type, target_id, status, runbook_id, operation, result_json, created_at, updated_at FROM operations WHERE created_at >= ?${connId ? ' AND (connection_id = ? OR connection_id IS NULL)' : ''}`)
    .all(...([windowStart, ...(connId ? [connId] : [])] as never[])) as Row[])
    .filter((o) => o.target_type !== 'device' || inScope(o.target_id));
  const opDaily = new Map(emptyDays().map((d) => [d, { verified: 0, failed: 0, other: 0 }]));
  const byRunbook = new Map<string, { total: number; verified: number; failed: number; durations: number[] }>();
  const byTarget = new Map<number, { total: number; failed: number }>();
  for (const o of ops) {
    const bucket = opDaily.get(dayKey(num(o.created_at)));
    const st = String(o.status);
    const outcome = st === 'verified' ? 'verified' : st === 'failed' || st === 'unknown' ? 'failed' : 'other';
    if (bucket) bucket[outcome]++;
    const key = String(o.runbook_id ?? o.operation);
    const rb = byRunbook.get(key) ?? { total: 0, verified: 0, failed: 0, durations: [] };
    rb.total++;
    if (outcome === 'verified') rb.verified++;
    if (outcome === 'failed') rb.failed++;
    try {
      const r = o.result_json ? JSON.parse(String(o.result_json)) : null;
      if (r && typeof r.durationMs === 'number' && r.durationMs > 0) rb.durations.push(r.durationMs);
    } catch { /* receipt without a duration */ }
    byRunbook.set(key, rb);
    if (o.target_type === 'device') {
      const t = byTarget.get(num(o.target_id)) ?? { total: 0, failed: 0 };
      t.total++;
      if (outcome === 'failed') t.failed++;
      byTarget.set(num(o.target_id), t);
    }
  }
  const allDurations = [...byRunbook.values()].flatMap((r) => r.durations).sort((a, b) => a - b);

  // ── Changes ──────────────────────────────────────────────────────────
  const changes = (db
    .prepare(`SELECT entity_type, entity_id, field, detected_at FROM entity_changes WHERE field != 'last_contact' AND detected_at >= ?`)
    .all(windowStart) as Row[])
    .filter((c) => c.entity_type !== 'device' || inScope(c.entity_id));
  const chDaily = new Map(emptyDays().map((d) => [d, 0]));
  const byField = new Map<string, number>();
  for (const c of changes) {
    const k = dayKey(num(c.detected_at));
    if (chDaily.has(k)) chDaily.set(k, chDaily.get(k)! + 1);
    const f = `${c.entity_type}.${c.field}`;
    byField.set(f, (byField.get(f) ?? 0) + 1);
  }

  // ── Review flow ──────────────────────────────────────────────────────
  let review: Record<string, unknown> = { available: false };
  try {
    const rOrg = orgId !== undefined ? ' AND org_id = ?' : '';
    const rArgs = orgId !== undefined ? [orgId] : [];
    const items = db.prepare(`SELECT item_type, category, severity, workflow, disposition, created_at, closed_at FROM review_items WHERE 1=1${rOrg}`).all(...(rArgs as never[])) as Row[];
    const flow = new Map(emptyDays().map((d) => [d, { opened: 0, closed: 0 }]));
    for (const i of items) {
      const o = flow.get(dayKey(num(i.created_at))); if (o) o.opened++;
      if (i.closed_at) { const c = flow.get(dayKey(num(i.closed_at))); if (c) c.closed++; }
    }
    const open = items.filter((i) => i.workflow !== 'closed');
    const decisions = db.prepare(`SELECT disposition, COUNT(*) AS n FROM review_decisions WHERE 1=1${rOrg} GROUP BY disposition`).all(...(rArgs as never[])) as Row[];
    review = {
      available: true,
      total: items.length,
      open: open.length,
      closed: items.length - open.length,
      flow: [...flow].map(([d, v]) => ({ date: iso(d), ...v })),
      openBySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((s) => [s, open.filter((i) => i.severity === s).length])),
      openByType: Object.fromEntries(['risk', 'improvement', 'observation'].map((t) => [t, open.filter((i) => i.item_type === t).length])),
      decisions: decisions.map((d) => ({ disposition: d.disposition, count: num(d.n) })).sort((a, b) => b.count - a.count),
    };
  } catch { /* review tables absent */ }

  // ── Fleet contact distribution (as of last sync) ────────────────────
  const scopedDevices = devices.filter((d) => orgId === undefined || num(d.org_id) === orgId);
  const contact = { lt1h: 0, lt24h: 0, lt7d: 0, lt30d: 0, gt30d: 0, never: 0 };
  for (const d of scopedDevices) {
    const ms = toMs(d.last_contact);
    if (ms === null) contact.never++;
    else if (now - ms < 3_600_000) contact.lt1h++;
    else if (now - ms < DAY) contact.lt24h++;
    else if (now - ms < 7 * DAY) contact.lt7d++;
    else if (now - ms < 30 * DAY) contact.lt30d++;
    else contact.gt30d++;
  }
  const byClass = new Map<string, { total: number; offline: number }>();
  for (const d of scopedDevices) {
    const k = String(d.node_class ?? 'UNKNOWN');
    const c = byClass.get(k) ?? { total: 0, offline: 0 };
    c.total++; if (num(d.offline)) c.offline++;
    byClass.set(k, c);
  }

  // ── Infrastructure knowledge + coverage ─────────────────────────────
  const infraWhere = orgId !== undefined ? 'WHERE org_id = ?' : '';
  const infraArgs = orgId !== undefined ? [orgId] : [];
  const infra = db.prepare(`SELECT category, COUNT(*) AS n FROM infra_entities ${infraWhere} GROUP BY category ORDER BY n DESC`).all(...(infraArgs as never[])) as Row[];
  const coverage = db.prepare(`SELECT status, COUNT(*) AS n FROM collection_coverage ${infraWhere} GROUP BY status`).all(...(infraArgs as never[])) as Row[];

  // ── Journal (tool usage) ────────────────────────────────────────────
  const journal = db.prepare('SELECT tool, status, COUNT(*) AS n FROM operation_journal WHERE ts >= ? GROUP BY tool, status').all(windowStart) as Row[];
  const byTool = new Map<string, { total: number; ok: number; error: number; blocked: number }>();
  for (const j of journal) {
    const t = byTool.get(String(j.tool)) ?? { total: 0, ok: 0, error: 0, blocked: 0 };
    t.total += num(j.n);
    if (j.status === 'ok') t.ok += num(j.n);
    if (j.status === 'error') t.error += num(j.n);
    if (j.status === 'blocked') t.blocked += num(j.n);
    byTool.set(String(j.tool), t);
  }

  const terminal = ops.filter((o) => ['verified', 'failed', 'unknown', 'partial', 'canceled'].includes(String(o.status)));
  return {
    schemaVersion: 1,
    generatedAt: now,
    window: { days, start: windowStart, end: now },
    scope: { orgId: orgId ?? null },
    operations: {
      total: ops.length,
      verified: ops.filter((o) => o.status === 'verified').length,
      failed: ops.filter((o) => ['failed', 'unknown'].includes(String(o.status))).length,
      successRate: terminal.length ? ops.filter((o) => o.status === 'verified').length / terminal.length : null,
      durationMs: { p50: quantile(allDurations, 0.5), p95: quantile(allDurations, 0.95), samples: allDurations.length },
      daily: [...opDaily].map(([d, v]) => ({ date: iso(d), ...v })),
      byRunbook: [...byRunbook].map(([runbook, r]) => {
        const s = [...r.durations].sort((a, b) => a - b);
        return { runbook, total: r.total, verified: r.verified, failed: r.failed, successRate: r.total ? r.verified / r.total : null, p50Ms: quantile(s, 0.5) };
      }).sort((a, b) => b.total - a.total).slice(0, 12),
      topTargets: [...byTarget].map(([id, t]) => ({ deviceId: id, label: deviceLabel.get(id) ?? `device ${id}`, ...t })).sort((a, b) => b.total - a.total).slice(0, 8),
    },
    changes: {
      total: changes.length,
      daily: [...chDaily].map(([d, n]) => ({ date: iso(d), changes: n })),
      byField: [...byField].map(([field, n]) => ({ field, count: n })).sort((a, b) => b.count - a.count).slice(0, 10),
    },
    review,
    fleet: {
      total: scopedDevices.length,
      contact,
      byClass: [...byClass].map(([nodeClass, c]) => ({ nodeClass, ...c })).sort((a, b) => b.total - a.total),
    },
    infrastructure: {
      byCategory: infra.map((r) => ({ category: String(r.category), count: num(r.n) })),
      coverage: coverage.map((r) => ({ status: String(r.status), count: num(r.n) })),
    },
    tools: [...byTool].map(([tool, t]) => ({ tool, ...t })).sort((a, b) => b.total - a.total).slice(0, 10),
  };
}
