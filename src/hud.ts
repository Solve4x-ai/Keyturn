/**
 * Mission Control HUD — one bounded, read-only aggregate over the local store.
 *
 * Everything here is derived from retained local data; nothing calls
 * NinjaOne and nothing can dispatch. Honesty rules carried from the design
 * system: online/offline is "as of the last device sync" (freshness is
 * returned alongside and must be shown with it); server roles come only
 * from collected infrastructure evidence, never from hostname guesses;
 * zero and unknown stay distinct (null = not collected).
 */
import type { EntityStore } from './entity-store.js';

type Row = Record<string, unknown>;

export interface HudInputs {
  orgId?: number | undefined;
  /** Pending (unconsumed, unexpired) plans — from OperationService.listPlans(). */
  pendingPlans?: Row[];
  now?: number;
}

const DAY = 86_400_000;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
/** NinjaOne lastContact is epoch seconds; local timestamps are ms. */
const toMs = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
};

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ROLE_CATEGORIES: Record<string, string> = {
  'domain-controller': 'DC',
  'dns-server': 'DNS',
  'dhcp-server': 'DHCP',
};

export function buildHud(store: EntityStore, input: HudInputs = {}) {
  const db = store.database;
  const now = input.now ?? Date.now();
  const orgId = input.orgId;
  const orgWhere = orgId !== undefined ? 'WHERE d.org_id = ?' : '';
  const orgArgs = orgId !== undefined ? [orgId] : [];

  // ── Fleet ────────────────────────────────────────────────────────────
  const devices = db
    .prepare(
      `SELECT d.device_id, d.system_name, d.display_name, d.dns_name, d.org_id, d.node_class, d.offline, d.last_contact, o.name AS org_name
       FROM entities_device d LEFT JOIN entities_org o ON o.org_id = d.org_id ${orgWhere}`,
    )
    .all(...(orgArgs as never[])) as Row[];

  const isServer = (d: Row) => String(d.node_class ?? '').includes('SERVER');
  const online = devices.filter((d) => !num(d.offline));
  const servers = devices.filter(isServer);
  const workstations = devices.filter((d) => !isServer(d));

  // Offline aging: how long since each offline device last checked in.
  const aging = { lt1h: 0, lt24h: 0, lt7d: 0, gt7d: 0, unknown: 0 };
  for (const d of devices.filter((x) => num(x.offline))) {
    const ms = toMs(d.last_contact);
    if (ms === null) aging.unknown++;
    else if (now - ms < 3_600_000) aging.lt1h++;
    else if (now - ms < DAY) aging.lt24h++;
    else if (now - ms < 7 * DAY) aging.lt7d++;
    else aging.gt7d++;
  }

  const byClass = new Map<string, { total: number; online: number }>();
  for (const d of devices) {
    const k = String(d.node_class ?? 'UNKNOWN');
    const c = byClass.get(k) ?? { total: 0, online: 0 };
    c.total++;
    if (!num(d.offline)) c.online++;
    byClass.set(k, c);
  }

  // ── Server roles — evidence-backed only ─────────────────────────────
  const roleRows = db
    .prepare(
      `SELECT category, stable_key, display_name FROM infra_entities
       WHERE category IN ('domain-controller','dns-server','dhcp-server')${orgId !== undefined ? ' AND org_id = ?' : ''}`,
    )
    .all(...(orgArgs as never[])) as Row[];
  const rolesByHost = new Map<string, Set<string>>();
  for (const r of roleRows) {
    const host = String(r.stable_key ?? r.display_name ?? '').toLowerCase().split('.')[0];
    if (!host) continue;
    const set = rolesByHost.get(host) ?? new Set<string>();
    set.add(ROLE_CATEGORIES[String(r.category)] ?? String(r.category));
    rolesByHost.set(host, set);
  }

  // Open review items that name a device in their subject.
  const openItemsByDevice = new Map<number, number>();
  try {
    const subj = db
      .prepare(`SELECT subject_json FROM review_items WHERE workflow != 'closed'${orgId !== undefined ? ' AND org_id = ?' : ''}`)
      .all(...(orgArgs as never[])) as Row[];
    for (const s of subj) {
      try {
        const parsed = JSON.parse(String(s.subject_json ?? 'null'));
        const ids: unknown[] = [parsed?.deviceId, ...(Array.isArray(parsed?.deviceIds) ? parsed.deviceIds : [])];
        for (const id of ids) if (typeof id === 'number') openItemsByDevice.set(id, (openItemsByDevice.get(id) ?? 0) + 1);
      } catch { /* subject is free-form; skip */ }
    }
  } catch { /* review tables absent on old stores */ }

  const serverTiles = servers
    .map((d) => {
      const host = String(d.system_name ?? '').toLowerCase();
      return {
        deviceId: num(d.device_id),
        name: String(d.system_name ?? d.display_name ?? `device ${d.device_id}`),
        displayName: d.display_name ?? null,
        orgId: d.org_id ?? null,
        orgName: d.org_name ?? null,
        offline: !!num(d.offline),
        lastContact: toMs(d.last_contact),
        roles: [...(rolesByHost.get(host) ?? [])].sort(),
        openItems: openItemsByDevice.get(num(d.device_id)) ?? 0,
      };
    })
    // Offline first, then role-bearing (infrastructure) servers, then name.
    .sort((a, b) => Number(b.offline) - Number(a.offline) || b.roles.length - a.roles.length || a.name.localeCompare(b.name));

  // ── Organizations ────────────────────────────────────────────────────
  const orgs = db.prepare('SELECT org_id, name FROM entities_org ORDER BY name').all() as Row[];
  const riskCounts = new Map<number, { open: number; critical: number; high: number }>();
  try {
    const rs = db
      .prepare(`SELECT org_id, severity, COUNT(*) AS n FROM review_items WHERE workflow != 'closed' AND item_type = 'risk' GROUP BY org_id, severity`)
      .all() as Row[];
    for (const r of rs) {
      const k = num(r.org_id);
      const c = riskCounts.get(k) ?? { open: 0, critical: 0, high: 0 };
      c.open += num(r.n);
      if (r.severity === 'critical') c.critical += num(r.n);
      if (r.severity === 'high') c.high += num(r.n);
      riskCounts.set(k, c);
    }
  } catch { /* review tables absent */ }
  const allDevices = orgId === undefined ? devices : (db.prepare('SELECT org_id, offline, node_class FROM entities_device').all() as Row[]);
  const orgTiles = orgs.map((o) => {
    const ds = allDevices.filter((d) => num(d.org_id) === num(o.org_id));
    return {
      orgId: num(o.org_id),
      name: String(o.name ?? `Org ${o.org_id}`),
      devices: ds.length,
      offline: ds.filter((d) => num(d.offline)).length,
      servers: ds.filter(isServer).length,
      risks: riskCounts.get(num(o.org_id)) ?? { open: 0, critical: 0, high: 0 },
    };
  });

  // ── Freshness ────────────────────────────────────────────────────────
  const sync = db.prepare('SELECT entity_type, last_sync_at, item_count FROM sync_state').all() as Row[];
  const deviceSync = sync.find((s) => s.entity_type === 'devices');
  const deviceSyncAt = deviceSync ? toMs(deviceSync.last_sync_at) : null;

  // ── Operations ───────────────────────────────────────────────────────
  const connId = store.connId;
  const opScope = connId ? 'WHERE (connection_id = ? OR connection_id IS NULL)' : '';
  const opArgs = connId ? [connId] : [];
  const ops = db
    .prepare(`SELECT id, operation, target_type, target_id, status, runbook_id, runbook_version, target_count, created_at, updated_at FROM operations ${opScope} ORDER BY created_at DESC LIMIT 2000`)
    .all(...(opArgs as never[])) as Row[];
  const deviceLabel = new Map<number, string>();
  for (const d of db.prepare('SELECT device_id, system_name, display_name FROM entities_device').all() as Row[]) {
    deviceLabel.set(num(d.device_id), String(d.system_name ?? d.display_name ?? d.device_id));
  }
  const deviceOrg = new Map<number, number>();
  for (const d of db.prepare('SELECT device_id, org_id FROM entities_device').all() as Row[]) deviceOrg.set(num(d.device_id), num(d.org_id));
  const scopedOps = orgId === undefined ? ops : ops.filter((o) => o.target_type !== 'device' || deviceOrg.get(num(o.target_id)) === orgId);

  const DAYS = 14;
  const series: Array<{ date: string; verified: number; failed: number; other: number }> = [];
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  for (let i = DAYS - 1; i >= 0; i--) {
    const start = dayStart.getTime() - i * DAY;
    const bucket = scopedOps.filter((o) => num(o.created_at) >= start && num(o.created_at) < start + DAY);
    series.push({
      date: new Date(start).toISOString().slice(0, 10),
      verified: bucket.filter((o) => o.status === 'verified').length,
      failed: bucket.filter((o) => ['failed', 'unknown'].includes(String(o.status))).length,
      other: bucket.filter((o) => !['verified', 'failed', 'unknown'].includes(String(o.status))).length,
    });
  }
  const last = (days: number) => scopedOps.filter((o) => now - num(o.created_at) < days * DAY);
  const opWindow = (days: number) => {
    const w = last(days);
    const terminal = w.filter((o) => ['verified', 'failed', 'unknown', 'partial', 'canceled'].includes(String(o.status)));
    const verified = w.filter((o) => o.status === 'verified').length;
    return {
      total: w.length,
      verified,
      failed: w.filter((o) => ['failed', 'unknown'].includes(String(o.status))).length,
      inFlight: w.filter((o) => ['accepted', 'dispatching', 'submitting', 'queued', 'canary_paused'].includes(String(o.status))).length,
      successRate: terminal.length ? verified / terminal.length : null,
    };
  };
  const recentOps = scopedOps.slice(0, 8).map((o) => ({
    id: o.id,
    status: o.status,
    label: o.runbook_id ? `${o.runbook_id}${o.runbook_version ? ` v${o.runbook_version}` : ''}` : String(o.operation),
    target: o.target_type === 'selection' ? `batch · ${o.target_count ?? '?'} devices` : (deviceLabel.get(num(o.target_id)) ?? `device ${o.target_id}`),
    createdAt: num(o.created_at),
  }));

  // ── Review / intelligence ────────────────────────────────────────────
  let review = { open: 0, risks: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>, openQuestions: 0, byCategory: [] as Array<{ category: string; open: number }> };
  let topRisks: Row[] = [];
  try {
    const rOrg = orgId !== undefined ? ' AND org_id = ?' : '';
    const open = db.prepare(`SELECT id, org_id, item_type, category, title, severity, confidence, priority_score, updated_at FROM review_items WHERE workflow != 'closed'${rOrg}`).all(...(orgArgs as never[])) as Row[];
    const cats = new Map<string, number>();
    for (const i of open) cats.set(String(i.category ?? 'uncategorized'), (cats.get(String(i.category ?? 'uncategorized')) ?? 0) + 1);
    review = {
      open: open.length,
      risks: open.filter((i) => i.item_type === 'risk').length,
      bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((s) => [s, open.filter((i) => i.severity === s).length])),
      openQuestions: num((db.prepare(`SELECT COUNT(*) AS n FROM review_questions WHERE status IN ('open','needs_clarification')${rOrg}`).get(...(orgArgs as never[])) as Row).n),
      byCategory: [...cats].map(([category, n]) => ({ category, open: n })).sort((a, b) => b.open - a.open),
    };
    topRisks = open
      .filter((i) => i.item_type === 'risk' && (i.severity === 'critical' || i.severity === 'high'))
      .sort((a, b) => (SEV_RANK[String(a.severity)] ?? 9) - (SEV_RANK[String(b.severity)] ?? 9) || num(b.priority_score) - num(a.priority_score))
      .slice(0, 12);
  } catch { /* review tables absent */ }

  // ── Attention queue — ranked, each item links somewhere real ────────
  type Att = { kind: string; severity: 'critical' | 'high' | 'medium' | 'low'; title: string; sub: string; href: string; at: number | null };
  const attention: Att[] = [];
  const plans = (input.pendingPlans ?? []).filter((p) => orgId === undefined || p.target_type !== 'device' || deviceOrg.get(num(p.target_id)) === orgId);
  for (const p of plans) {
    const args = (p.args ?? {}) as Row;
    const rb = args.runbook as Row | undefined;
    attention.push({
      kind: 'approval', severity: 'high',
      title: `Approval needed: ${rb ? String(rb.id) : String(p.operation)}`,
      sub: `${String(p.device_label ?? deviceLabel.get(num(p.target_id)) ?? `device ${p.target_id}`)} · from ${String(p.principal ?? 'unknown')}`,
      href: `#/plan/${String(p.id)}`, at: num(p.created_at) || null,
    });
  }
  for (const s of serverTiles.filter((t) => t.offline)) {
    attention.push({
      kind: 'server_offline', severity: 'critical',
      title: `Server offline: ${s.name}`,
      sub: `${s.roles.length ? `${s.roles.join(' · ')} · ` : ''}${s.orgName ?? ''}`,
      href: `#/device/${s.deviceId}/overview`, at: s.lastContact,
    });
  }
  for (const o of last(1).filter((x) => ['failed', 'unknown'].includes(String(x.status)))) {
    attention.push({
      kind: 'op_failed', severity: 'high',
      title: `Operation ${o.status}: ${o.runbook_id ?? o.operation}`,
      sub: o.target_type === 'selection' ? `batch · ${o.target_count ?? '?'} devices` : (deviceLabel.get(num(o.target_id)) ?? `device ${o.target_id}`),
      href: `#/operation/${String(o.id)}`, at: num(o.created_at),
    });
  }
  for (const r of topRisks.filter((x) => x.severity === 'critical')) {
    attention.push({ kind: 'risk', severity: 'critical', title: String(r.title), sub: `critical risk · ${r.category ?? 'uncategorized'}`, href: `#/review/${num(r.org_id)}/item?i=${String(r.id)}`, at: num(r.updated_at) || null });
  }
  if (deviceSyncAt === null || now - deviceSyncAt > DAY) {
    attention.push({
      kind: 'stale_sync', severity: 'medium',
      title: deviceSyncAt === null ? 'Device inventory never synced' : 'Device inventory is stale',
      sub: 'Online/offline status is as of the last sync — refresh to see current state',
      href: '#/overview', at: deviceSyncAt,
    });
  }
  const highRisks = topRisks.filter((x) => x.severity === 'high').length;
  if (highRisks) {
    attention.push({ kind: 'risks_high', severity: 'medium', title: `${highRisks} high-severity risk${highRisks === 1 ? '' : 's'} open`, sub: 'Proposed by review analysis — awaiting your decision', href: `#/review/${orgId ?? orgTiles[0]?.orgId ?? ''}/risks`, at: null });
  }
  if (review.openQuestions) {
    attention.push({ kind: 'questions', severity: 'low', title: `${review.openQuestions} open question${review.openQuestions === 1 ? '' : 's'}`, sub: 'Answers sharpen AI findings', href: `#/review/${orgId ?? orgTiles[0]?.orgId ?? ''}/questions`, at: null });
  }
  attention.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || num(b.at) - num(a.at));

  // ── Activity stream — merged, newest first ──────────────────────────
  const stream: Array<{ source: string; kind: string; title: string; at: number; href: string | null }> = [];
  const evRows = db
    .prepare(
      `SELECT e.kind, e.at, e.operation_id, o.runbook_id, o.operation, o.target_id, o.target_type FROM operation_events e JOIN operations o ON o.id = e.operation_id
       ORDER BY e.at DESC LIMIT 40`,
    )
    .all() as Row[];
  for (const e of evRows) {
    if (orgId !== undefined && e.target_type === 'device' && deviceOrg.get(num(e.target_id)) !== orgId) continue;
    stream.push({
      source: 'operation', kind: String(e.kind),
      title: `${String(e.runbook_id ?? e.operation)} → ${e.target_type === 'selection' ? 'batch' : (deviceLabel.get(num(e.target_id)) ?? e.target_id)}`,
      at: num(e.at), href: `#/operation/${String(e.operation_id)}`,
    });
  }
  try {
    const rv = db
      .prepare(`SELECT e.event_type, e.actor, e.created_at, e.item_id, e.org_id, i.title FROM review_events e JOIN review_items i ON i.id = e.item_id${orgId !== undefined ? ' WHERE e.org_id = ?' : ''} ORDER BY e.created_at DESC LIMIT 30`)
      .all(...(orgArgs as never[])) as Row[];
    for (const e of rv) {
      stream.push({ source: 'review', kind: String(e.event_type), title: String(e.title), at: num(e.created_at), href: `#/review/${num(e.org_id)}/item?i=${String(e.item_id)}` });
    }
  } catch { /* review tables absent */ }
  const ch = db
    .prepare(`SELECT c.entity_type, c.entity_id, c.field, c.new_value, c.detected_at FROM entity_changes c WHERE c.field != 'last_contact' ORDER BY c.seq DESC LIMIT 30`)
    .all() as Row[];
  for (const c of ch) {
    if (orgId !== undefined && c.entity_type === 'device' && deviceOrg.get(num(c.entity_id)) !== orgId) continue;
    const label = c.entity_type === 'device' ? (deviceLabel.get(num(c.entity_id)) ?? c.entity_id) : `${c.entity_type} ${c.entity_id}`;
    stream.push({ source: 'change', kind: String(c.field), title: `${label}: ${c.field} → ${String(c.new_value ?? '∅').slice(0, 60)}`, at: num(c.detected_at), href: c.entity_type === 'device' ? `#/device/${num(c.entity_id)}/overview` : null });
  }
  stream.sort((a, b) => b.at - a.at);

  return {
    schemaVersion: 1,
    generatedAt: now,
    scope: { orgId: orgId ?? null },
    freshness: {
      deviceSyncAt,
      ageMs: deviceSyncAt === null ? null : now - deviceSyncAt,
      stale: deviceSyncAt === null || now - deviceSyncAt > DAY,
      sync: sync.map((s) => ({ entityType: s.entity_type, lastSyncAt: toMs(s.last_sync_at), itemCount: num(s.item_count) })),
    },
    fleet: {
      total: devices.length,
      online: online.length,
      offline: devices.length - online.length,
      servers: { total: servers.length, online: servers.filter((d) => !num(d.offline)).length },
      workstations: { total: workstations.length, online: workstations.filter((d) => !num(d.offline)).length },
      byClass: [...byClass].map(([nodeClass, c]) => ({ nodeClass, ...c })).sort((a, b) => b.total - a.total),
      offlineAging: aging,
    },
    servers: serverTiles,
    orgs: orgTiles,
    operations: { d1: opWindow(1), d7: opWindow(7), d30: opWindow(30), series, recent: recentOps },
    approvals: { pending: plans.length },
    review: { ...review, topRisks: topRisks.map((r) => ({ id: r.id, orgId: num(r.org_id), title: r.title, severity: r.severity, category: r.category ?? null, confidence: r.confidence ?? null })) },
    attention: attention.slice(0, 25),
    attentionTotal: attention.length,
    stream: stream.slice(0, 30),
    // The SNMPv3 edge agent (switches/firewalls/printers) is planned but not
    // built. Reported honestly so the UI never implies network visibility.
    networkEdge: { status: 'not_connected', devices: null },
  };
}
