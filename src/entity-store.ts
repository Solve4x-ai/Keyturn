/**
 * Typed access layer over the local SQLite store (src/storage.ts).
 * Syncs NinjaOne entity lists into local tables, recording field-level
 * diffs into entity_changes so "what changed since X" is answerable.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, redactArgs, type ConnectionBinding } from './storage.js';

/**
 * Persistence allowlist (invariant 10) — the only fields this layer may
 * store, per entity type. `raw_json` columns still exist in the schema but
 * are no longer populated: raw upstream blobs must not be persisted.
 */
export const PERSIST_ALLOWLISTS = {
  device: ['device_id', 'system_name', 'display_name', 'dns_name', 'name_norm', 'org_id', 'location_id', 'node_class', 'offline', 'last_contact'],
  organization: ['org_id', 'name', 'description'],
  location: ['name'],
  policy: ['name'],
} as const;

/**
 * Typed saved-filter allowlists (M1) — which param keys (and value kinds) a
 * saved filter may carry per entity type. Unknown keys/types are rejected at
 * save time so stored presets can't smuggle unexpected dispatch params.
 */
export const FILTER_PARAM_TYPES: Record<string, Record<string, 'string' | 'number' | 'any'>> = {
  devices: {
    df: 'string', organization: 'string', organizationId: 'number', detail: 'string',
    pageSize: 'number', maxPages: 'number', maxItems: 'number', limit: 'number', since: 'any',
  },
  organizations: { detail: 'string', pageSize: 'number', after: 'number', limit: 'number' },
  tickets: {
    boardId: 'number', status: 'string', organizationId: 'number', detail: 'string',
    pageSize: 'number', maxPages: 'number', maxItems: 'number', limit: 'number',
  },
  alerts: { deviceFilter: 'string', sourceType: 'string', since: 'any', detail: 'string', limit: 'number' },
};

export interface SyncReport {
  entityType: string;
  synced: number;
  added: number;
  changed: number;
  removed: number;
  durationMs: number;
}

export interface ChangeRow {
  seq: number;
  entity_type: string;
  entity_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_at: number;
}

export interface JournalEntry {
  profile: string;
  tool: string;
  args?: unknown;
  targetDeviceId?: number | null;
  targetOrgId?: number | null;
  dryRun: boolean;
  status: 'ok' | 'dry_run' | 'error' | 'blocked';
  error?: string | null;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Normalize a name for fuzzy matching: lowercase alphanumeric only. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalized search key covering all device name fields (indexed column). */
function deviceNormKey(d: Record<string, unknown>): string {
  return normalizeName([d.systemName ?? d.system_name, d.displayName ?? d.display_name, d.dnsName ?? d.dns_name].filter(Boolean).join(' '));
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class EntityStore {
  private db: DatabaseSync;
  private lastMark = 0;
  private connectionId: string | null;

  constructor(dbOrPath: DatabaseSync | string, binding?: ConnectionBinding) {
    this.db = typeof dbOrPath === 'string' ? openDatabase(dbOrPath, binding) : dbOrPath;
    this.connectionId = binding?.connectionId ?? null;
    this.backfillDeviceNorm();
  }

  /** Populate name_norm for rows written before the column existed. */
  private backfillDeviceNorm(): void {
    const rows = this.db
      .prepare('SELECT device_id AS id, system_name, display_name, dns_name FROM entities_device WHERE name_norm IS NULL')
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    const update = this.db.prepare('UPDATE entities_device SET name_norm = ? WHERE device_id = ?');
    for (const r of rows) {
      update.run(deviceNormKey(r), r.id as number);
    }
  }

  /**
   * Strictly increasing write marker — guarantees rows written by this sync
   * sort after every previous sync even when two syncs share a millisecond.
   */
  private nextMark(): number {
    this.lastMark = Math.max(Date.now(), this.lastMark + 1);
    return this.lastMark;
  }

  /** Raw handle for services layered on the same database (M4 operations). */
  get database(): DatabaseSync {
    return this.db;
  }

  /** The bound connection UUID (null for unbound test/override paths). */
  get connId(): string | null {
    return this.connectionId;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ── Sync state ──────────────────────────────────────────────────────

  syncState(entityType: string): { last_sync_at: number; item_count: number } | null {
    const row = this.db
      .prepare('SELECT last_sync_at, item_count FROM sync_state WHERE entity_type = ?')
      .get(entityType);
    return row ? (row as { last_sync_at: number; item_count: number }) : null;
  }

  private markSynced(entityType: string, count: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (entity_type, last_sync_at, item_count) VALUES (?, ?, ?)
         ON CONFLICT(entity_type) DO UPDATE SET last_sync_at = excluded.last_sync_at, item_count = excluded.item_count`,
      )
      .run(entityType, now, count);
  }

  // ── Change recording ────────────────────────────────────────────────

  private recordChange(entityType: string, entityId: number, field: string, oldValue: unknown, newValue: unknown, now: number): void {
    this.db
      .prepare(
        `INSERT INTO entity_changes (entity_type, entity_id, field, old_value, new_value, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entityType, entityId, field, str(oldValue), str(newValue), now);
  }

  /**
   * Upsert one entity row. Returns 'added' | 'changed' | 'unchanged'.
   * `fields` maps column name → new value; diffs are recorded for tracked cols.
   */
  private upsertEntity(
    table: string,
    keyCols: Record<string, number>,
    fields: Record<string, unknown>,
    entityType: string,
    entityId: number,
    now: number,
  ): 'added' | 'changed' | 'unchanged' {
    const keyNames = Object.keys(keyCols);
    const keyValues = keyNames.map((k) => keyCols[k]!);
    const where = keyNames.map((k) => `${k} = ?`).join(' AND ');
    const existing = this.db
      .prepare(`SELECT * FROM ${table} WHERE ${where}`)
      .get(...keyValues) as Record<string, unknown> | undefined;

    // SQL values cannot be undefined — normalize to null once.
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) cleanFields[k] = v === undefined ? null : v;

    if (!existing) {
      // raw_json stays NULL — persistence is allowlisted (invariant 10); the
      // column is retained for schema compat but must not carry upstream blobs.
      const cols = [...keyNames, ...Object.keys(cleanFields), 'updated_at', 'seen_at'];
      const placeholders = cols.map(() => '?').join(', ');
      this.db
        .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
        .run(...keyValues, ...Object.values(cleanFields).map((v) => v as never), now, now);
      this.recordChange(entityType, entityId, '__appeared__', null, 'present', now);
      return 'added';
    }

    const diffs: Array<[string, unknown, unknown]> = [];
    for (const [col, newVal] of Object.entries(cleanFields)) {
      const oldVal = existing[col];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        diffs.push([col, oldVal, newVal]);
      }
    }

    if (diffs.length === 0) {
      this.db.prepare(`UPDATE ${table} SET seen_at = ? WHERE ${where}`).run(now, ...keyValues);
      return 'unchanged';
    }

    const setCols = [...Object.keys(cleanFields).map((c) => `${c} = ?`), 'updated_at = ?', 'seen_at = ?'].join(', ');
    this.db
      .prepare(`UPDATE ${table} SET ${setCols} WHERE ${where}`)
      .run(...Object.values(cleanFields).map((v) => v as never), now, now, ...keyValues);
    for (const [col, oldVal, newVal] of diffs) {
      this.recordChange(entityType, entityId, col, oldVal, newVal, now);
    }
    return 'changed';
  }

  /**
   * Entities not touched by a complete sync are recorded as __disappeared__
   * and removed — entity tables hold current state; history lives in
   * entity_changes. A reappearing entity then logs __appeared__ once.
   */
  private sweepMissing(
    table: string,
    entityType: string,
    idCol: string,
    syncStarted: number,
    now: number,
    scope?: { col: string; val: number },
  ): number {
    const missing = this.db
      .prepare(`SELECT ${idCol} AS id FROM ${table} WHERE seen_at < ?${scope ? ` AND ${scope.col} = ?` : ''}`)
      .all(...(scope ? [syncStarted, scope.val] : [syncStarted])) as Array<{ id: number }>;
    for (const row of missing) {
      this.recordChange(entityType, row.id, '__disappeared__', 'present', null, now);
      this.db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`).run(row.id);
    }
    return missing.length;
  }

  // ── Entity syncs ────────────────────────────────────────────────────

  /**
   * Sync device rows. `scopeOrgId` marks this as a partial (org-scoped) scan:
   * the sweep then only removes missing rows inside that org — entities in
   * other scopes are never touched (invariant 9: one partial scan is not
   * deletion). sync_state records the scope key separately from the
   * full-fleet 'devices' key.
   */
  syncDevices(devices: Array<Record<string, unknown>>, opts: { scopeOrgId?: number } = {}): SyncReport {
    const started = this.nextMark();
    let added = 0;
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const d of devices) {
        const id = num(d.id);
        if (id === null) continue;
        const fields = {
          system_name: str(d.systemName),
          display_name: str(d.displayName),
          dns_name: str(d.dnsName),
          name_norm: deviceNormKey(d),
          org_id: num(d.organizationId),
          location_id: num(d.locationId),
          node_class: str(d.nodeClass),
          offline: d.offline === undefined ? null : d.offline ? 1 : 0,
          last_contact: num(d.lastContact),
        };
        const outcome = this.upsertEntity('entities_device', { device_id: id }, fields, 'device', id, started);
        if (outcome === 'added') added++;
        else if (outcome === 'changed') changed++;
      }
      const scope = opts.scopeOrgId === undefined ? undefined : { col: 'org_id', val: opts.scopeOrgId };
      const removed = this.sweepMissing('entities_device', 'device', 'device_id', started, Date.now(), scope);
      this.markSynced(scope ? `devices:org:${opts.scopeOrgId}` : 'devices', devices.length, started);
      this.db.exec('COMMIT');
      return { entityType: scope ? `devices:org:${opts.scopeOrgId}` : 'devices', synced: devices.length, added, changed, removed, durationMs: Date.now() - started };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncOrganizations(orgs: Array<Record<string, unknown>>): SyncReport {
    const started = this.nextMark();
    let added = 0;
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const o of orgs) {
        const id = num(o.id);
        if (id === null) continue;
        const fields = { name: str(o.name), description: str(o.description) };
        const outcome = this.upsertEntity('entities_org', { org_id: id }, fields, 'organization', id, started);
        if (outcome === 'added') added++;
        else if (outcome === 'changed') changed++;
      }
      const removed = this.sweepMissing('entities_org', 'organization', 'org_id', started, Date.now());
      this.markSynced('organizations', orgs.length, started);
      this.db.exec('COMMIT');
      return { entityType: 'organizations', synced: orgs.length, added, changed, removed, durationMs: Date.now() - started };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncPolicies(policies: Array<Record<string, unknown>>): SyncReport {
    const started = this.nextMark();
    let added = 0;
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const p of policies) {
        const id = num(p.id ?? p.policyId);
        if (id === null) continue;
        const fields = { name: str(p.name) };
        const outcome = this.upsertEntity('entities_policy', { policy_id: id }, fields, 'policy', id, started);
        if (outcome === 'added') added++;
        else if (outcome === 'changed') changed++;
      }
      const removed = this.sweepMissing('entities_policy', 'policy', 'policy_id', started, Date.now());
      this.markSynced('policies', policies.length, started);
      this.db.exec('COMMIT');
      return { entityType: 'policies', synced: policies.length, added, changed, removed, durationMs: Date.now() - started };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncLocations(orgId: number, locations: Array<Record<string, unknown>>): SyncReport {
    const started = this.nextMark();
    let added = 0;
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const l of locations) {
        const id = num(l.id);
        if (id === null) continue;
        const fields = { name: str(l.name) };
        const outcome = this.upsertEntity(
          'entities_location',
          { org_id: orgId, location_id: id },
          fields,
          'location',
          id,
          started,
        );
        if (outcome === 'added') added++;
        else if (outcome === 'changed') changed++;
      }
      // Locations are synced per-org; sweep only within that org.
      const missing = this.db
        .prepare('SELECT location_id AS id FROM entities_location WHERE org_id = ? AND seen_at < ?')
        .all(orgId, started) as Array<{ id: number }>;
      for (const row of missing) {
        this.recordChange('location', row.id, '__disappeared__', 'present', null, Date.now());
        this.db.prepare('DELETE FROM entities_location WHERE org_id = ? AND location_id = ?').run(orgId, row.id);
      }
      const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM entities_location').get() as { c: number };
      this.markSynced('locations', countRow.c, started);
      this.db.exec('COMMIT');
      return { entityType: 'locations', synced: locations.length, added, changed, removed: missing.length, durationMs: Date.now() - started };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ── Lookups ─────────────────────────────────────────────────────────

  getDeviceById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM entities_device WHERE device_id = ?').get(id) as Record<string, unknown> | undefined;
  }

  getOrgById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM entities_org WHERE org_id = ?').get(id) as Record<string, unknown> | undefined;
  }

  getPolicyById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM entities_policy WHERE policy_id = ?').get(id) as Record<string, unknown> | undefined;
  }

  getLocationById(orgId: number, locationId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM entities_location WHERE org_id = ? AND location_id = ?')
      .get(orgId, locationId) as Record<string, unknown> | undefined;
  }

  /** Location IDs are only unique within an org; returns the row when unambiguous. */
  getLocationByAnyOrg(locationId: number): Record<string, unknown> | undefined {
    const rows = this.db
      .prepare('SELECT * FROM entities_location WHERE location_id = ?')
      .all(locationId) as Array<Record<string, unknown>>;
    return rows.length === 1 ? rows[0] : undefined;
  }

  allOrgs(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM entities_org').all() as Array<Record<string, unknown>>;
  }

  allOrgIds(): number[] {
    const rows = this.db.prepare('SELECT org_id FROM entities_org').all() as Array<{ org_id: number }>;
    return rows.map((r) => r.org_id);
  }

  orgName(orgId: number | null | undefined): string | null {
    if (orgId === null || orgId === undefined) return null;
    const row = this.getOrgById(orgId);
    return row ? str(row.name) : null;
  }

  /** Substring candidates across all device name fields, for the match ladder. */
  deviceNameCandidates(term: string, orgId?: number): Array<Record<string, unknown>> {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    const base = `SELECT * FROM entities_device
      WHERE (lower(system_name) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\' OR lower(dns_name) LIKE ? ESCAPE '\\')`;
    return (orgId !== undefined
      ? this.db.prepare(`${base} AND org_id = ?`).all(like, like, like, orgId)
      : this.db.prepare(`${base}`).all(like, like, like)) as Array<Record<string, unknown>>;
  }

  /** Normalized-name candidates via the indexed name_norm column. */
  deviceNormCandidates(normNeedle: string, orgId?: number): Array<Record<string, unknown>> {
    const like = `%${escapeLike(normNeedle)}%`;
    return (orgId !== undefined
      ? this.db.prepare('SELECT * FROM entities_device WHERE name_norm LIKE ? AND org_id = ?').all(like, orgId)
      : this.db.prepare('SELECT * FROM entities_device WHERE name_norm LIKE ?').all(like)) as Array<Record<string, unknown>>;
  }

  orgNameCandidates(term: string): Array<Record<string, unknown>> {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    return this.db
      .prepare(`SELECT * FROM entities_org WHERE lower(name) LIKE ? ESCAPE '\\'`)
      .all(like) as Array<Record<string, unknown>>;
  }

  locationNameCandidates(term: string, orgId?: number): Array<Record<string, unknown>> {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    const base = `SELECT * FROM entities_location WHERE lower(name) LIKE ? ESCAPE '\\'`;
    return (orgId !== undefined
      ? this.db.prepare(`${base} AND org_id = ?`).all(like, orgId)
      : this.db.prepare(base).all(like)) as Array<Record<string, unknown>>;
  }

  policyNameCandidates(term: string): Array<Record<string, unknown>> {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    return this.db
      .prepare(`SELECT * FROM entities_policy WHERE lower(name) LIKE ? ESCAPE '\\'`)
      .all(like) as Array<Record<string, unknown>>;
  }

  allDevices(orgId?: number): Array<Record<string, unknown>> {
    return (orgId !== undefined
      ? this.db.prepare('SELECT * FROM entities_device WHERE org_id = ?').all(orgId)
      : this.db.prepare('SELECT * FROM entities_device').all()) as Array<Record<string, unknown>>;
  }

  // ── Change history ──────────────────────────────────────────────────

  getChanges(opts: { entityType?: string | undefined; entityId?: number | undefined; field?: string | undefined; since?: number | undefined; limit?: number | undefined }): ChangeRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.entityType) {
      clauses.push('entity_type = ?');
      params.push(opts.entityType);
    }
    if (opts.entityId !== undefined) {
      clauses.push('entity_id = ?');
      params.push(opts.entityId);
    }
    if (opts.field) {
      clauses.push('field = ?');
      params.push(opts.field);
    }
    if (opts.since !== undefined) {
      clauses.push('detected_at >= ?');
      params.push(opts.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    return this.db
      .prepare(`SELECT * FROM entity_changes ${where} ORDER BY detected_at DESC, seq DESC LIMIT ${limit}`)
      .all(...(params as never[])) as unknown as ChangeRow[];
  }

  // ── Saved filters ───────────────────────────────────────────────────

  saveFilter(name: string, entityType: string, params: Record<string, unknown>): void {
    const allowed = FILTER_PARAM_TYPES[entityType];
    if (!allowed) {
      throw new Error(
        `Unknown filter entity type "${entityType}" — expected one of: ${Object.keys(FILTER_PARAM_TYPES).join(', ')}`,
      );
    }
    for (const [key, value] of Object.entries(params)) {
      const kind = allowed[key];
      if (!kind) {
        throw new Error(`Saved-filter param "${key}" is not allowed for ${entityType} filters`);
      }
      const ok =
        kind === 'any'
          ? ['string', 'number', 'boolean'].includes(typeof value)
          : kind === 'number'
            ? typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))
            : typeof value === kind;
      if (!ok) {
        throw new Error(`Saved-filter param "${key}" must be a ${kind} value`);
      }
    }
    this.db
      .prepare(
        `INSERT INTO saved_filters (name, entity_type, params_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET entity_type = excluded.entity_type, params_json = excluded.params_json`,
      )
      .run(name, entityType, JSON.stringify(params), Date.now());
  }

  getFilter(name: string): { name: string; entity_type: string; params: Record<string, unknown>; created_at: number } | null {
    const row = this.db.prepare('SELECT * FROM saved_filters WHERE name = ?').get(name) as
      | { name: string; entity_type: string; params_json: string; created_at: number }
      | undefined;
    if (!row) return null;
    return { name: row.name, entity_type: row.entity_type, params: JSON.parse(row.params_json), created_at: row.created_at };
  }

  listFilters(entityType?: string): Array<{ name: string; entity_type: string; params: Record<string, unknown>; created_at: number }> {
    const rows = (entityType
      ? this.db.prepare('SELECT * FROM saved_filters WHERE entity_type = ? ORDER BY name').all(entityType)
      : this.db.prepare('SELECT * FROM saved_filters ORDER BY entity_type, name').all()) as Array<{
      name: string;
      entity_type: string;
      params_json: string;
      created_at: number;
    }>;
    return rows.map((r) => ({ name: r.name, entity_type: r.entity_type, params: JSON.parse(r.params_json), created_at: r.created_at }));
  }

  deleteFilter(name: string): boolean {
    const result = this.db.prepare('DELETE FROM saved_filters WHERE name = ?').run(name);
    return Number(result.changes) > 0;
  }

  // ── Operation journal ───────────────────────────────────────────────

  logOperation(entry: JournalEntry): void {
    const redacted = entry.args !== undefined ? JSON.stringify(redactArgs(entry.args)) : null;
    this.db
      .prepare(
        `INSERT INTO operation_journal (ts, profile, connection_id, tool, args_redacted, target_device_id, target_org_id, dry_run, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.profile,
        this.connectionId,
        entry.tool,
        redacted,
        entry.targetDeviceId ?? null,
        entry.targetOrgId ?? null,
        entry.dryRun ? 1 : 0,
        entry.status,
        entry.error ? String(entry.error).slice(0, 1000) : null,
      );
  }

  getJournal(opts: { since?: number | undefined; tool?: string | undefined; limit?: number | undefined }): Array<Record<string, unknown>> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      clauses.push('ts >= ?');
      params.push(opts.since);
    }
    if (opts.tool) {
      clauses.push('tool = ?');
      params.push(opts.tool);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare(`SELECT * FROM operation_journal ${where} ORDER BY ts DESC, seq DESC LIMIT ${limit}`)
      .all(...(params as never[])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...r,
      args_redacted: typeof r.args_redacted === 'string' ? JSON.parse(r.args_redacted) : r.args_redacted,
      dry_run: Boolean(r.dry_run),
    }));
  }

  // ── UI read queries (server-paginated, allowlisted columns only) ──────

  listDevices(opts: { orgId?: number | undefined; q?: string | undefined; offline?: boolean | undefined; kind?: string | undefined; sort?: string | undefined; dir?: string | undefined; page?: number | undefined; pageSize?: number | undefined } = {}): { rows: Array<Record<string, unknown>>; total: number; page: number; pageSize: number } {
    const page = Math.max(opts.page ?? 1, 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.orgId !== undefined) {
      clauses.push('d.org_id = ?');
      params.push(opts.orgId);
    }
    // Device kind is a fixed whitelist mapped to node_class patterns.
    if (opts.kind === 'server') clauses.push("d.node_class LIKE '%SERVER%'");
    else if (opts.kind === 'workstation') clauses.push("(d.node_class IS NULL OR d.node_class NOT LIKE '%SERVER%')");
    if (opts.offline !== undefined) {
      clauses.push('d.offline = ?');
      params.push(opts.offline ? 1 : 0);
    }
    if (opts.q) {
      const like = `%${escapeLike(opts.q.toLowerCase())}%`;
      clauses.push(`(lower(d.system_name) LIKE ? ESCAPE '\\' OR lower(d.display_name) LIKE ? ESCAPE '\\' OR lower(d.dns_name) LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM entities_device d ${where}`).get(...(params as never[])) as { c: number }).c;
    // Sort keys are a fixed whitelist — never raw user input in ORDER BY.
    const SORTS: Record<string, string> = {
      name: 'd.system_name COLLATE NOCASE',
      display: 'd.display_name COLLATE NOCASE',
      org: 'o.name COLLATE NOCASE',
      status: 'd.offline',
      last_contact: 'd.last_contact',
      class: 'd.node_class',
    };
    const orderCol = SORTS[opts.sort ?? 'name'] ?? SORTS.name;
    const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
    // Allowlisted columns only — raw_json must never leave the store (invariant 10).
    const cols = PERSIST_ALLOWLISTS.device.map((c) => `d.${c}`).join(', ');
    const rows = this.db
      .prepare(
        `SELECT ${cols}, o.name AS org_name FROM entities_device d
         LEFT JOIN entities_org o ON o.org_id = d.org_id
         ${where} ORDER BY ${orderCol} ${dir} NULLS LAST, d.device_id LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[]), pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { rows, total, page, pageSize };
  }

  listOrganizations(): Array<Record<string, unknown>> {
    const cols = PERSIST_ALLOWLISTS.organization.map((c) => `o.${c}`).join(', ');
    return this.db
      .prepare(
        `SELECT ${cols}, (SELECT COUNT(*) FROM entities_device d WHERE d.org_id = o.org_id) AS device_count
         FROM entities_org o ORDER BY o.name COLLATE NOCASE`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  orgDetail(id: number): { org: Record<string, unknown> | null; deviceCount: number; offlineCount: number; changes: ChangeRow[] } {
    const org = this.snapshotFor('organization', id);
    const counts = this.db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(offline),0) AS offline FROM entities_device WHERE org_id = ?')
      .get(id) as { total: number; offline: number };
    return {
      org,
      deviceCount: counts.total,
      offlineCount: counts.offline,
      changes: this.getChanges({ entityType: 'organization', entityId: id, limit: 20 }),
    };
  }

  /** Change rows enriched with live display names for the changes feed. */
  getChangesLabeled(opts: { entityType?: string | undefined; entityId?: number | undefined; field?: string | undefined; since?: number | undefined; limit?: number | undefined } = {}): Array<Record<string, unknown>> {
    return this.getChanges(opts).map((c) => ({ ...c, ...this.entityLabel(c.entity_type, c.entity_id) }));
  }

  deviceDetail(id: number): { device: Record<string, unknown> | null; orgName: string | null; changes: ChangeRow[]; journal: Array<Record<string, unknown>> } {
    const device = this.snapshotFor('device', id);
    // Provenance columns are fetched directly — deliberately NOT via the
    // snapshot allowlist, or seen_at drift would flag every evidence item
    // stale on every sync.
    if (device) {
      const prov = this.db
        .prepare('SELECT seen_at, updated_at FROM entities_device WHERE device_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (prov) Object.assign(device, prov);
    }
    const orgId = device ? (device.org_id as number | null) : null;
    return {
      device,
      orgName: this.orgName(orgId),
      changes: this.getChanges({ entityType: 'device', entityId: id, limit: 20 }),
      journal: this.db
        .prepare('SELECT * FROM operation_journal WHERE target_device_id = ? ORDER BY ts DESC LIMIT 20')
        .all(id) as Array<Record<string, unknown>>,
    };
  }

  overview(): Record<string, unknown> {
    const c = this.counts();
    const offline = (this.db.prepare('SELECT COUNT(*) AS n FROM entities_device WHERE offline = 1').get() as { n: number }).n;
    const changes24h = (this.db
      .prepare('SELECT COUNT(*) AS n FROM entity_changes WHERE detected_at >= ?')
      .get(Date.now() - 86_400_000) as { n: number }).n;
    const syncState = ['devices', 'organizations', 'policies', 'locations'].map((t) => {
      const s = this.syncState(t);
      return { entityType: t, lastSyncAt: s?.last_sync_at ?? null, itemCount: s?.item_count ?? 0 };
    });
    return { ...c, offlineDevices: offline, changesLast24h: changes24h, syncState };
  }

  maxChangeSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM entity_changes').get() as { m: number }).m;
  }

  getChangesAfterSeq(seq: number, limit: number = 100): ChangeRow[] {
    return this.db
      .prepare('SELECT * FROM entity_changes WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(seq, Math.min(Math.max(limit, 1), 500)) as unknown as ChangeRow[];
  }

  /** Evidence snapshot = allowlisted stored fields only (never raw upstream). */
  private snapshotFor(entityType: string, entityId: number): Record<string, unknown> | null {
    const row =
      entityType === 'device'
        ? this.getDeviceById(entityId)
        : entityType === 'organization'
          ? this.getOrgById(entityId)
          : entityType === 'policy'
            ? this.getPolicyById(entityId)
            : null;
    if (!row) return null;
    const allowlist = (PERSIST_ALLOWLISTS as Record<string, readonly string[]>)[entityType] ?? [];
    const out: Record<string, unknown> = {};
    for (const key of allowlist) if (key in row) out[key] = row[key];
    return out;
  }

  /** Display label + org for a change row (display/system name, never raw id). */
  private entityLabel(entityType: string, entityId: number | null): { entity_label: string | null; org_name: string | null } {
    if (entityId === null) return { entity_label: null, org_name: null };
    const row =
      entityType === 'device'
        ? this.getDeviceById(entityId)
        : entityType === 'organization'
          ? this.getOrgById(entityId)
          : entityType === 'policy'
            ? this.getPolicyById(entityId)
            : null;
    if (!row) return { entity_label: null, org_name: null };
    const label = ((row.display_name ?? row.system_name ?? row.name) as string | undefined) ?? null;
    const orgName =
      entityType === 'device'
        ? this.orgName(row.org_id as number | null)
        : entityType === 'organization'
          ? (row.name as string | null)
          : null;
    return { entity_label: label, org_name: orgName };
  }

  listJournalPaged(opts: { page?: number | undefined; pageSize?: number | undefined; tool?: string | undefined } = {}): { rows: Array<Record<string, unknown>>; total: number; page: number; pageSize: number } {
    const page = Math.max(opts.page ?? 1, 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
    const where = opts.tool ? 'WHERE tool = ?' : '';
    const params: unknown[] = opts.tool ? [opts.tool] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM operation_journal ${where}`).get(...(params as never[])) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM operation_journal ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...(params as never[]), pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { rows, total, page, pageSize };
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [label, table] of [
      ['devices', 'entities_device'],
      ['organizations', 'entities_org'],
      ['locations', 'entities_location'],
      ['policies', 'entities_policy'],
      ['changes', 'entity_changes'],
      ['savedFilters', 'saved_filters'],
      ['journalEntries', 'operation_journal'],
    ] as const) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      out[label] = row.c;
    }
    return out;
  }
}
