/**
 * M5B — frozen device selections (plan §9).
 *
 * A selection is an explicitly materialized set: the member ids stored at
 * creation ARE the truth. Re-evaluating a filter creates a NEW selection —
 * an approved plan's membership can never silently expand.
 *
 * Scope rules: one organization per selection (cross-org requests are
 * separate selections/plans until deliberately supported). Selections
 * expire — an expired handle can't seed a new plan; existing plans keep
 * their embedded membership for audit either way.
 *
 * A handle is a reference, not authorization: dispatch re-validates org
 * membership, online state, and applicability per target (operations.ts).
 */
import { randomUUID } from 'node:crypto';
import type { EntityStore } from './entity-store.js';
import type { RuntimeSecurity } from './security-profile.js';
import { OpError } from './operations.js';

export const SELECTION_TTL_MS = 60 * 60_000; // 1h — drift label, not authority
const MAX_MEMBERS = 1000;
const PREVIEW = 5;

export interface SelectionCriteria {
  orgId?: number | undefined;
  offline?: boolean | undefined;
  q?: string | undefined;
  deviceIds?: number[] | undefined;
}

export class SelectionService {
  constructor(private readonly store: EntityStore, private readonly security: RuntimeSecurity) {}

  private get db() {
    return this.store.database;
  }

  /**
   * Materialize a frozen device set from criteria or an explicit id list.
   * Exclusions (ids requested but absent from cache/scope) are recorded
   * with reasons — never silently dropped, never substituted.
   */
  create(criteria: SelectionCriteria, creator: string): Record<string, unknown> {
    // Org scope check at materialization: a handle can't quietly span the
    // allowlist boundary (dispatch re-validates too, but fail early).
    const allowed = this.security.policy.allowedOrganizationIds;
    if (criteria.orgId !== undefined && allowed && allowed.length > 0 && !allowed.includes(criteria.orgId)) {
      throw new OpError('forbidden', `Organization ${criteria.orgId} is outside the allowed set`);
    }
    const exclusions: Array<{ deviceId?: number; reason: string }> = [];
    let memberIds: number[];

    if (Array.isArray(criteria.deviceIds) && criteria.deviceIds.length > 0) {
      memberIds = [];
      for (const raw of criteria.deviceIds) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) {
          exclusions.push({ reason: `invalid device id "${String(raw)}"` });
          continue;
        }
        if (memberIds.includes(id)) continue;
        const dev = this.store.getDeviceById(id);
        if (!dev) { exclusions.push({ deviceId: id, reason: 'not in local cache — run sync_entities first' }); continue; }
        if (allowed && allowed.length > 0 && !allowed.includes(Number(dev.org_id))) {
          exclusions.push({ deviceId: id, reason: `org ${dev.org_id} outside allowed set` });
          continue;
        }
        if (criteria.orgId !== undefined && Number(dev.org_id) !== criteria.orgId) {
          exclusions.push({ deviceId: id, reason: `in org ${dev.org_id}, outside selection org ${criteria.orgId}` });
          continue;
        }
        memberIds.push(id);
      }
    } else {
      // Filter evaluation against the local cache — pages through the
      // full matching set so the member list is complete, not truncated.
      const ids: number[] = [];
      let page = 1;
      for (;;) {
        const { rows, total } = this.store.listDevices({
          orgId: criteria.orgId,
          offline: criteria.offline,
          q: criteria.q,
          page, pageSize: 200,
        });
        for (const r of rows) {
          // Members outside the allowlist are excluded with a reason —
          // recorded, never silently dropped or substituted.
          if (allowed && allowed.length > 0 && !allowed.includes(Number(r.org_id))) {
            exclusions.push({ deviceId: Number(r.device_id), reason: `org ${r.org_id} outside allowed set` });
            continue;
          }
          ids.push(Number(r.device_id));
        }
        if (ids.length >= total || rows.length === 0) break;
        page += 1;
        if (page > 25) break; // hard bound — never materialize unbounded sets
      }
      memberIds = ids;
    }

    if (memberIds.length === 0) throw new OpError('empty_selection', 'Selection matched zero devices — nothing to freeze');
    if (memberIds.length > MAX_MEMBERS) throw new OpError('selection_too_large', `Selection matched ${memberIds.length} devices — cap is ${MAX_MEMBERS}; narrow the filter`);

    const id = randomUUID();
    const now = Date.now();
    const orgId = criteria.orgId ?? this.singleOrg(memberIds);
    this.db
      .prepare(
        `INSERT INTO selections (id, connection_id, creator, entity_type, source_query_json, org_id, member_ids_json, member_count, exclusions_json, evaluated_at, expires_at, created_at)
         VALUES (?, ?, ?, 'device', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.store.connId, creator, JSON.stringify(criteria), orgId, JSON.stringify(memberIds), memberIds.length, JSON.stringify(exclusions), now, now + SELECTION_TTL_MS, now);
    return this.describe(id)!;
  }

  /** A set spanning orgs is only valid when the caller scoped one org. */
  private singleOrg(memberIds: number[]): number | null {
    const orgs = new Set(memberIds.map((id) => Number(this.store.getDeviceById(id)?.org_id ?? -1)));
    return orgs.size === 1 ? [...orgs][0]! : null;
  }

  get(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM selections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  members(id: string): number[] {
    const row = this.get(id);
    if (!row) throw new OpError('selection_not_found', `Selection ${id} not found`);
    return JSON.parse(String(row.member_ids_json)) as number[];
  }

  /** Compact view for model/UI consumption: ids are NOT returned inline. */
  describe(id: string): Record<string, unknown> | null {
    const row = this.get(id);
    if (!row) return null;
    const memberIds = JSON.parse(String(row.member_ids_json)) as number[];
    return {
      id: row.id,
      entityType: row.entity_type,
      orgId: row.org_id,
      orgName: typeof row.org_id === 'number' ? this.store.orgName(row.org_id as number) : null,
      memberCount: row.member_count,
      preview: memberIds.slice(0, PREVIEW).map((did) => ({ id: did, label: this.store.getDeviceById(did)?.display_name ?? null })),
      exclusions: JSON.parse(String(row.exclusions_json ?? '[]')),
      criteria: JSON.parse(String(row.source_query_json)),
      evaluatedAt: row.evaluated_at,
      expiresAt: row.expires_at,
      expired: Number(row.expires_at) < Date.now(),
      driftNote: 'Membership is frozen at evaluation time — devices added/changed since are not included.',
    };
  }

  list(limit = 20): Array<Record<string, unknown>> {
    return (this.db
      .prepare('SELECT id, org_id, member_count, evaluated_at, expires_at, created_at, source_query_json FROM selections ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>)
      .map((r) => ({
        id: r.id,
        orgId: r.org_id,
        orgName: typeof r.org_id === 'number' ? this.store.orgName(r.org_id as number) : null,
        memberCount: r.member_count,
        criteria: JSON.parse(String(r.source_query_json)),
        evaluatedAt: r.evaluated_at,
        expiresAt: r.expires_at,
        expired: Number(r.expires_at) < Date.now(),
      }));
  }
}
