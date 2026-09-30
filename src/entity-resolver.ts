/**
 * Name-or-ID entity resolution on top of the local entity store.
 *
 * Match ladder: numeric passthrough → exact (case-insensitive) → prefix →
 * substring → normalized fuzzy. Ambiguous input always throws with a compact
 * candidate list — resolution never guesses. Cache is synced lazily when
 * stale; `refresh` forces a tenant fetch.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { NinjaOneAPI } from './ninja-api.js';
import { EntityStore, normalizeName } from './entity-store.js';
import type { SyncReport } from './entity-store.js';

export type EntityKind = 'device' | 'organization' | 'location' | 'policy';

export interface ResolvedEntity {
  id: number;
  orgId: number | null;
  label: string;
  source: 'cache' | 'api';
  record: Record<string, unknown>;
}

const MINUTE = 60 * 1000;
const envTtl = (name: string, fallbackMin: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw * MINUTE : fallbackMin * MINUTE;
};

const DEFAULT_TTLS: Record<string, number> = {
  devices: envTtl('NINJA_CACHE_DEVICES_TTL_MIN', 15),
  organizations: envTtl('NINJA_CACHE_ORGS_TTL_MIN', 24 * 60),
  policies: envTtl('NINJA_CACHE_POLICIES_TTL_MIN', 24 * 60),
  locations: envTtl('NINJA_CACHE_LOCATIONS_TTL_MIN', 24 * 60),
};

const MAX_SYNC_PAGES = 500;
const SYNC_PAGE_SIZE = 1000;

function deviceLabel(d: Record<string, unknown>): string {
  return String(d.system_name ?? d.systemName ?? d.display_name ?? d.displayName ?? `id ${d.device_id ?? d.id}`);
}

function orgLabel(o: Record<string, unknown>): string {
  return String(o.name ?? `id ${o.org_id ?? o.id}`);
}

export class EntityResolver {
  private api: NinjaOneAPI;
  private store: EntityStore;
  private ttls: Record<string, number>;
  private syncInFlight: Record<string, Promise<SyncReport> | undefined> = {};

  constructor(api: NinjaOneAPI, store: EntityStore, ttls?: Record<string, number>) {
    this.api = api;
    this.store = store;
    this.ttls = { ...DEFAULT_TTLS, ...(ttls || {}) };
  }

  // ── Sync ────────────────────────────────────────────────────────────

  private isStale(entityType: string): boolean {
    const state = this.store.syncState(entityType);
    if (!state) return true;
    return Date.now() - state.last_sync_at > (this.ttls[entityType] ?? 15 * MINUTE);
  }

  /** Serialize concurrent syncs of the same entity type. */
  private runSync(entityType: string, task: () => SyncReport | Promise<SyncReport>): Promise<SyncReport> {
    const existing = this.syncInFlight[entityType];
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(task)
      .finally(() => {
        this.syncInFlight[entityType] = undefined;
      });
    this.syncInFlight[entityType] = pending;
    return pending;
  }

  async syncDevices(): Promise<SyncReport> {
    return this.runSync('devices', async () => {
      const rows: any[] = [];
      let after: number | undefined;
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const response = await this.api.getDevices(undefined, SYNC_PAGE_SIZE, after);
        const list = Array.isArray(response) ? response : (response?.results ?? response?.devices ?? []);
        if (!Array.isArray(list) || list.length === 0) break;
        rows.push(...list);
        const lastId = Number(list[list.length - 1]?.id);
        if (list.length < SYNC_PAGE_SIZE || !Number.isFinite(lastId)) break;
        after = lastId;
      }
      return this.store.syncDevices(rows);
    });
  }

  async syncOrganizations(): Promise<SyncReport> {
    return this.runSync('organizations', async () => {
      const rows: any[] = [];
      let after: number | undefined;
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const response = await this.api.getOrganizations(SYNC_PAGE_SIZE, after);
        const list = Array.isArray(response) ? response : (response?.results ?? response?.organizations ?? []);
        if (!Array.isArray(list) || list.length === 0) break;
        rows.push(...list);
        const lastId = Number(list[list.length - 1]?.id);
        if (list.length < SYNC_PAGE_SIZE || !Number.isFinite(lastId)) break;
        after = lastId;
      }
      return this.store.syncOrganizations(rows);
    });
  }

  async syncPolicies(): Promise<SyncReport> {
    return this.runSync('policies', async () => {
      const response = await this.api.getPolicies();
      const list = Array.isArray(response) ? response : (response?.results ?? response?.policies ?? []);
      return this.store.syncPolicies(Array.isArray(list) ? list : []);
    });
  }

  async syncLocations(): Promise<SyncReport> {
    return this.runSync('locations', async () => {
      await this.ensureFresh('organizations');
      const orgs = this.store.allOrgIds();
      const totals = { synced: 0, added: 0, changed: 0, removed: 0 };
      for (const orgId of orgs) {
        try {
          const response = await this.api.getOrganizationLocations(orgId);
          const list = Array.isArray(response) ? response : (response?.results ?? response?.locations ?? []);
          const report = this.store.syncLocations(orgId, Array.isArray(list) ? list : []);
          totals.synced += report.synced;
          totals.added += report.added;
          totals.changed += report.changed;
          totals.removed += report.removed;
        } catch {
          // An org without readable locations must not fail the whole sync.
        }
      }
      return { entityType: 'locations', ...totals, durationMs: 0 };
    });
  }

  async syncEntities(types?: string[]): Promise<SyncReport[]> {
    const wanted = types?.length ? types : ['devices', 'organizations', 'policies', 'locations'];
    const reports: SyncReport[] = [];
    for (const type of wanted) {
      if (type === 'devices') reports.push(await this.syncDevices());
      else if (type === 'organizations') reports.push(await this.syncOrganizations());
      else if (type === 'policies') reports.push(await this.syncPolicies());
      else if (type === 'locations') reports.push(await this.syncLocations());
      else throw new McpError(ErrorCode.InvalidParams, `Unknown entity type "${type}". Valid: devices, organizations, policies, locations`);
    }
    return reports;
  }

  async ensureFresh(entityType: string, force = false): Promise<void> {
    if (!force && !this.isStale(entityType)) return;
    await this.syncEntities([entityType]);
  }

  // ── Match ladder ────────────────────────────────────────────────────

  /**
   * Rank candidates against a search term. Returns the best-scoring group:
   * 3 = exact (case-insensitive or normalized), 2 = prefix, 1 = substring.
   */
  private rankCandidates<T>(candidates: T[], term: string, names: (c: T) => Array<string | null | undefined>): T[] {
    const needle = term.toLowerCase();
    const normNeedle = normalizeName(term);
    let best = 0;
    let winners: T[] = [];
    for (const candidate of candidates) {
      let score = 0;
      for (const raw of names(candidate)) {
        if (!raw) continue;
        const field = raw.toLowerCase();
        const normField = normalizeName(raw);
        if (field === needle || normField === normNeedle) score = Math.max(score, 3);
        else if (field.startsWith(needle) || normField.startsWith(normNeedle)) score = Math.max(score, 2);
        else if (field.includes(needle) || (normNeedle && normField.includes(normNeedle))) score = Math.max(score, 1);
      }
      if (score > best) {
        best = score;
        winners = [candidate];
      } else if (score === best && score > 0) {
        winners.push(candidate);
      }
    }
    return winners;
  }

  private ambiguousError(kind: EntityKind, term: string, candidates: Array<Record<string, unknown>>): McpError {
    const preview = candidates.slice(0, 10).map((c) => {
      if (kind === 'device') {
        const id = c.device_id ?? c.id;
        return `  id=${id} ${deviceLabel(c)} (org ${this.store.orgName(Number(c.org_id ?? c.organizationId)) ?? c.org_id ?? c.organizationId ?? '?'}${c.offline ? ', offline' : ''})`;
      }
      const id = c.org_id ?? c.location_id ?? c.policy_id ?? c.id;
      return `  id=${id} ${String(c.name ?? '?')}`;
    });
    const suffix = candidates.length > 10 ? `\n  …and ${candidates.length - 10} more` : '';
    return new McpError(
      ErrorCode.InvalidParams,
      `Ambiguous ${kind} "${term}" — ${candidates.length} matches. Re-call with an explicit numeric ID:\n${preview.join('\n')}${suffix}`,
    );
  }

  // ── Public resolvers ────────────────────────────────────────────────

  /** All candidate device rows for a term: SQL substring first, normalized full-scan fallback. */
  private async collectDeviceCandidates(term: string, opts: { refresh?: boolean | undefined; orgId?: number | undefined } = {}): Promise<Array<Record<string, unknown>>> {
    await this.ensureFresh('devices', opts.refresh === true);
    const candidates = this.store.deviceNameCandidates(term, opts.orgId);
    if (candidates.length > 0) return candidates;
    const normNeedle = normalizeName(term);
    if (!normNeedle) return candidates;
    return this.store.deviceNormCandidates(normNeedle, opts.orgId);
  }

  /** Sorted candidate list for browse-style search (all matches, best first). */
  async searchDevices(term: string, opts: { refresh?: boolean | undefined; orgId?: number | undefined; limit?: number | undefined } = {}): Promise<Array<Record<string, unknown>>> {
    const candidates = await this.collectDeviceCandidates(term, opts);
    const needle = term.toLowerCase();
    const normNeedle = normalizeName(term);
    const score = (d: Record<string, unknown>): number => {
      let s = 0;
      for (const raw of [d.system_name, d.display_name, d.dns_name]) {
        if (!raw) continue;
        const field = String(raw).toLowerCase();
        const normField = normalizeName(raw);
        if (field === needle || normField === normNeedle) s = Math.max(s, 3);
        else if (field.startsWith(needle) || normField.startsWith(normNeedle)) s = Math.max(s, 2);
        else s = Math.max(s, 1);
      }
      return s;
    };
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    return candidates
      .map((d) => ({ d, s: score(d) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((entry) => entry.d);
  }

  async resolveDevice(query: string | number, opts: { refresh?: boolean | undefined; orgId?: number | undefined } = {}): Promise<ResolvedEntity> {
    if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
      const id = Number(query);
      const cached = this.store.getDeviceById(id);
      if (cached) {
        return { id, orgId: num(cached.org_id), label: deviceLabel(cached), source: 'cache', record: cached };
      }
      const fresh = await this.api.getDevice(id);
      this.store.syncDevices([fresh]);
      return { id, orgId: num(fresh?.organizationId), label: String(fresh?.systemName ?? fresh?.displayName ?? `id ${id}`), source: 'api', record: fresh };
    }

    const term = String(query).trim();
    if (!term) throw new McpError(ErrorCode.InvalidParams, 'Device name must not be empty');

    const candidates = await this.collectDeviceCandidates(term, opts);
    const ranked = this.rankCandidates(candidates, term, (d) => [str(d.system_name), str(d.display_name), str(d.dns_name)]);

    if (ranked.length === 0) {
      if (!opts.refresh && this.isStale('devices') === false) {
        throw new McpError(ErrorCode.InvalidParams, `No device matching "${term}". Cache is fresh — check spelling, or scope with organization.`);
      }
      throw new McpError(ErrorCode.InvalidParams, `No device matching "${term}".`);
    }
    if (ranked.length > 1) throw this.ambiguousError('device', term, ranked);

    const d = ranked[0]!;
    const id = Number(d.device_id ?? d.id);
    return { id, orgId: num(d.org_id ?? d.organizationId), label: deviceLabel(d), source: 'cache', record: d };
  }

  async resolveOrganization(query: string | number, opts: { refresh?: boolean | undefined } = {}): Promise<ResolvedEntity> {
    if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
      const id = Number(query);
      const cached = this.store.getOrgById(id);
      if (cached) return { id, orgId: id, label: orgLabel(cached), source: 'cache', record: cached };
      const fresh = await this.api.getOrganization(id);
      this.store.syncOrganizations([fresh]);
      return { id, orgId: id, label: String(fresh?.name ?? `id ${id}`), source: 'api', record: fresh };
    }

    const term = String(query).trim();
    if (!term) throw new McpError(ErrorCode.InvalidParams, 'Organization name must not be empty');

    await this.ensureFresh('organizations', opts.refresh === true);
    let candidates = this.store.orgNameCandidates(term);
    if (candidates.length === 0) {
      const normNeedle = normalizeName(term);
      if (normNeedle) {
        candidates = (this.store.allOrgs()).filter((o) => normalizeName(o.name).includes(normNeedle));
      }
    }
    const ranked = this.rankCandidates(candidates, term, (o) => [str(o.name)]);

    if (ranked.length === 0) throw new McpError(ErrorCode.InvalidParams, `No organization matching "${term}".`);
    if (ranked.length > 1) throw this.ambiguousError('organization', term, ranked);

    const o = ranked[0]!;
    const id = Number(o.org_id ?? o.id);
    return { id, orgId: id, label: orgLabel(o), source: 'cache', record: o };
  }

  async resolveLocation(query: string | number, opts: { refresh?: boolean | undefined; orgId?: number | undefined } = {}): Promise<ResolvedEntity> {
    if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
      const id = Number(query);
      const row = opts.orgId !== undefined ? this.store.getLocationById(opts.orgId, id) : this.store.getLocationByAnyOrg(id);
      if (row) return { id, orgId: num(row.org_id), label: String(row.name ?? `id ${id}`), source: 'cache', record: row };
      throw new McpError(ErrorCode.InvalidParams, `No location with id=${id} in local cache. Call sync_entities with entities:["locations"].`);
    }

    const term = String(query).trim();
    if (!term) throw new McpError(ErrorCode.InvalidParams, 'Location name must not be empty');

    await this.ensureFresh('locations', opts.refresh === true);
    const candidates = this.store.locationNameCandidates(term, opts.orgId);
    const ranked = this.rankCandidates(candidates, term, (l) => [str(l.name)]);

    if (ranked.length === 0) throw new McpError(ErrorCode.InvalidParams, `No location matching "${term}".`);
    if (ranked.length > 1) throw this.ambiguousError('location', term, ranked);

    const l = ranked[0]!;
    return { id: Number(l.location_id), orgId: num(l.org_id), label: String(l.name), source: 'cache', record: l };
  }

  async resolvePolicy(query: string | number, opts: { refresh?: boolean | undefined } = {}): Promise<ResolvedEntity> {
    if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
      const id = Number(query);
      const cached = this.store.getPolicyById(id);
      if (cached) return { id, orgId: null, label: String(cached.name ?? `id ${id}`), source: 'cache', record: cached };
      const fresh = await this.api.getPolicy(id);
      this.store.syncPolicies([fresh]);
      return { id, orgId: null, label: String(fresh?.name ?? `id ${id}`), source: 'api', record: fresh };
    }

    const term = String(query).trim();
    if (!term) throw new McpError(ErrorCode.InvalidParams, 'Policy name must not be empty');

    await this.ensureFresh('policies', opts.refresh === true);
    const candidates = this.store.policyNameCandidates(term);
    const ranked = this.rankCandidates(candidates, term, (p) => [str(p.name)]);

    if (ranked.length === 0) throw new McpError(ErrorCode.InvalidParams, `No policy matching "${term}".`);
    if (ranked.length > 1) throw this.ambiguousError('policy', term, ranked);

    const p = ranked[0]!;
    return { id: Number(p.policy_id ?? p.id), orgId: null, label: String(p.name), source: 'cache', record: p };
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
