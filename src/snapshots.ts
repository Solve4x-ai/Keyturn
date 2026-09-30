/**
 * M4.5 (commandcenterupdate1.1.md U1–U3): per-resource dated observations,
 * sealed snapshot manifests, deduplicated canonical payloads, deterministic
 * comparison, exact-version evidence pins, and a read-only daily schedule.
 *
 * Guarantees:
 * - Fetch time (fetched_at) is never conflated with source time
 *   (source_observed_at); absent source time stays null, never fabricated.
 * - A 200 with malformed/partial shape is recorded 'malformed', not success.
 * - 403 → 'forbidden', never an empty list. Errors persist safe codes only —
 *   upstream bodies are never stored.
 * - Canonical payloads are allowlisted fields, deduplicated by semantic hash
 *   per connection. Re-fetching identical content reuses the payload row but
 *   still writes a fresh observation (new fetch occurred).
 * - Manifests seal resource→observation references under a digest; pinning
 *   references snapshot id + digest and rejects version skew.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { EntityStore } from './entity-store.js';

export const CANONICALIZER_VERSION = 1;
export const DIFF_VERSION = 2;
export const COLLECTOR_VERSION = 1;
/**
 * Field-set version of the adapter allowlists. v1 = initial guessed fields;
 * v2 = live-validated shapes (docs/adapter-capabilities.md). Compatible
 * versions compare on the shared-field intersection — schema additions are
 * reported as schemaDelta, never as endpoint data changes.
 */
export const ADAPTER_VERSION = 2;

/**
 * Fields that change on every poll without representing endpoint drift —
 * excluded from meaningful-change counts (still shown, flagged routine).
 */
const ROUTINE_FIELDS = new Set(['lastContact', 'last_contact']);

export const RESOURCE_PROFILES: Record<string, string[]> = {
  quick: ['identity', 'network', 'last_user', 'policy_assignment'],
  standard: [
    'identity',
    'network',
    'last_user',
    'policy_assignment',
    'software_inventory',
    'os_patch_state',
    'storage',
    'alerts',
  ],
  full: [
    'identity',
    'network',
    'last_user',
    'policy_assignment',
    'software_inventory',
    'os_patch_state',
    'software_patch_state',
    'storage',
    'alerts',
    'os_patch_history',
    'software_patch_history',
  ],
};

const MAX_ITEMS = 5000;
const MAX_PAGES = 20;
const PAGE_SIZE = 500;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Extract the HTTP status from makeRequest's thrown message, if any. */
export function httpStatusOf(err: unknown): number | null {
  const m = err instanceof Error ? err.message : String(err);
  const hit = m.match(/API request failed: (\d{3})/);
  return hit ? Number(hit[1]) : null;
}

/**
 * Deterministic canonical JSON: object keys sorted; arrays of objects sorted
 * by a stable item key so ordering noise never churns the semantic hash.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    const keyed = items.map((item, i) => ({
      key: stableKey(item) ?? `idx:${i}:${JSON.stringify(item)}`,
      item,
    }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keyed.map((k) => k.item);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Stable item identity for diffs and reports — natural key when present. */
export function stableKey(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  for (const k of ['id', 'uid', 'name', 'deviceName', 'patchId', 'kbArticleId', 'kbNumber', 'macAddress']) {
    if (o[k] !== undefined && o[k] !== null) return `${k}:${String(o[k])}`;
  }
  return null;
}

/** Pick allowlisted keys; absent fields stay absent (never fabricated). */
function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export interface AdapterResult {
  status: 'succeeded' | 'failed' | 'skipped' | 'unsupported' | 'forbidden';
  completeness: 'complete' | 'partial' | 'unknown' | 'not_applicable';
  canonical?: unknown;
  itemCount?: number | undefined;
  returnedCount?: number | undefined;
  pagesFetched?: number | undefined;
  sourceObservedAt?: number | null | undefined;
  safeError?: string | undefined;
  endpoint: string;
  requests?: number | undefined;
}

interface Ctx {
  api: any;
  deviceId: number;
  device: any;
  store: EntityStore;
  requestBudget: number;
  requestsUsed: number;
}

type Adapter = (ctx: Ctx) => Promise<AdapterResult>;

function classifyError(err: unknown): { status: AdapterResult['status']; safeError: string } {
  const code = httpStatusOf(err);
  if (code === 403) return { status: 'forbidden', safeError: 'forbidden_403' };
  if (code === 404) return { status: 'failed', safeError: 'not_found_404' };
  if (code === 429) return { status: 'skipped', safeError: 'rate_limited_429' };
  if (code) return { status: 'failed', safeError: `http_${code}` };
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(msg)) {
    return { status: 'failed', safeError: 'timeout' };
  }
  return { status: 'failed', safeError: 'api_error' };
}

/**
 * Drive /v2/queries/* paging directly so completeness and request counts are
 * honest: complete only when the server stops returning a cursor.
 */
async function pagedQuery(
  ctx: Ctx,
  method: string,
  endpoint: string,
  mapItem: (item: any) => unknown,
): Promise<AdapterResult> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const df = `id = ${ctx.deviceId}`;
  try {
    while (true) {
      if (ctx.requestsUsed >= ctx.requestBudget) {
        return {
          status: items.length ? 'succeeded' : 'skipped',
          completeness: items.length ? 'partial' : 'unknown',
          canonical: { items },
          itemCount: items.length,
          returnedCount: items.length,
          pagesFetched: pages,
          requests: 0,
          safeError: 'budget_exhausted',
          endpoint,
        };
      }
      const resp: any = await ctx.api[method](df, cursor, PAGE_SIZE);
      ctx.requestsUsed++;
      pages++;
      if (!resp || (resp.success === true && !resp.results)) {
        return {
          status: 'failed',
          completeness: items.length ? 'partial' : 'unknown',
          canonical: items.length ? { items } : undefined,
          returnedCount: items.length,
          pagesFetched: pages,
          safeError: 'malformed_response',
          endpoint,
        };
      }
      const results: any[] = Array.isArray(resp.results) ? resp.results : [];
      for (const r of results) items.push(mapItem(r));
      const next = resp.cursor?.name;
      if (!next || results.length < PAGE_SIZE || pages >= MAX_PAGES || items.length >= MAX_ITEMS) {
        const truncated = Boolean(next) && results.length >= PAGE_SIZE;
        return {
          status: 'succeeded',
          completeness: truncated ? 'partial' : 'complete',
          canonical: { items },
          itemCount: items.length,
          returnedCount: items.length,
          pagesFetched: pages,
          endpoint,
        };
      }
      cursor = next;
    }
  } catch (err) {
    const c = classifyError(err);
    return {
      status: c.status,
      completeness: items.length ? 'partial' : 'unknown',
      canonical: items.length ? { items } : undefined,
      returnedCount: items.length,
      pagesFetched: pages,
      safeError: c.safeError,
      endpoint,
    };
  }
}

/** Device-scoped single endpoints: array body = complete list; else malformed. */
async function deviceList(
  ctx: Ctx,
  call: () => Promise<any>,
  endpoint: string,
  mapItem: (item: any) => unknown,
): Promise<AdapterResult> {
  try {
    const resp: any = await call();
    ctx.requestsUsed++;
    if (Array.isArray(resp)) {
      const items = resp.slice(0, MAX_ITEMS).map(mapItem);
      return {
        status: 'succeeded',
        completeness: resp.length > MAX_ITEMS ? 'partial' : 'complete',
        canonical: { items },
        itemCount: items.length,
        returnedCount: items.length,
        pagesFetched: 1,
        endpoint,
      };
    }
    if (resp && Array.isArray(resp.results)) {
      const items = resp.results.slice(0, MAX_ITEMS).map(mapItem);
      return {
        status: 'succeeded',
        completeness: resp.results.length > MAX_ITEMS ? 'partial' : 'complete',
        canonical: { items },
        itemCount: items.length,
        returnedCount: items.length,
        pagesFetched: 1,
        endpoint,
      };
    }
    return { status: 'failed', completeness: 'unknown', safeError: 'malformed_response', endpoint };
  } catch (err) {
    const c = classifyError(err);
    return { status: c.status, completeness: 'unknown', safeError: c.safeError, endpoint };
  }
}

function unavailable(endpoint: string): AdapterResult {
  return {
    status: 'unsupported',
    completeness: 'not_applicable',
    safeError: 'unsupported_resource',
    endpoint,
  };
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;

/** Registry: resource → adapter over verified existing client methods. */
export const ADAPTERS: Record<string, Adapter> = {
  identity: async (ctx) => {
    const d = ctx.device;
    if (!d || typeof d !== 'object') {
      return { status: 'failed', completeness: 'unknown', safeError: 'no_device_record', endpoint: '/v2/device/{id}' };
    }
    const canonical = {
      ...pick(d, [
        'systemName',
        'displayName',
        'dnsName',
        'organizationId',
        'locationId',
        'nodeClass',
        'offline',
        'lastContact',
        'created',
      ]),
      os: d.os ? pick(d.os, ['name', 'manufacturer', 'buildNumber', 'releaseId', 'servicePackMajorVersion']) : undefined,
    };
    return {
      status: 'succeeded',
      completeness: 'complete',
      canonical,
      sourceObservedAt: d.lastContact ? Math.round(d.lastContact * (d.lastContact > 1e12 ? 1 : 1000)) : null,
      endpoint: '/v2/device/{id}',
    };
  },

  network: async (ctx) => {
    const base = {
      ipAddresses: ctx.device?.ipAddresses,
      publicIP: ctx.device?.publicIP,
      publicIPV6: ctx.device?.publicIPV6,
    };
    const inner = await pagedQuery(ctx, 'queryNetworkInterfaces', '/v2/queries/network-interfaces', (r) =>
      // Real shape (validated 2026-09-15, us2): interfaceName/adapterName,
      // singular ipAddress, subnetMask, defaultGateway, dnsServers, mtu, status.
      pick(r, ['interfaceName', 'adapterName', 'macAddress', 'ipAddress', 'subnetMask', 'defaultGateway', 'dnsServers', 'interfaceType', 'linkSpeed', 'mtu', 'status', 'interfaceIndex', 'deviceId']),
    );
    if (inner.status === 'succeeded' || inner.status === 'skipped') {
      const ifaceItems = (inner.canonical as any)?.items ?? [];
      return {
        status: inner.status,
        completeness: inner.completeness,
        canonical: { ...base, interfaces: ifaceItems },
        itemCount: ifaceItems.length,
        returnedCount: inner.returnedCount,
        pagesFetched: inner.pagesFetched,
        safeError: inner.safeError,
        endpoint: inner.endpoint,
      };
    }
    // Interface query failed: still record the device-level IP fields honestly.
    return {
      status: inner.status === 'forbidden' ? 'forbidden' : 'succeeded',
      completeness: 'partial',
      canonical: { ...base, interfaces: null },
      safeError: inner.safeError ?? 'interfaces_unavailable',
      endpoint: inner.endpoint,
    };
  },

  last_user: async (ctx) => {
    // Real shape: { userName, logonTime, deviceId }. logonTime (epoch) is the
    // source's own observation time → surfaced as source_observed_at.
    const res = await pagedQuery(ctx, 'queryLoggedOnUsers', '/v2/queries/logged-on-users', (r) =>
      pick(r, ['userName', 'logonTime', 'deviceId']),
    );
    const t = num((res.canonical as any)?.items?.[0]?.logonTime);
    if (t) res.sourceObservedAt = t > 1e12 ? t : Math.round(t * 1000);
    return res;
  },

  policy_assignment: async (ctx) => {
    const d = ctx.device;
    const policyId = num(d?.policyId ?? d?.policy?.id ?? d?.nodeClassPolicyId);
    const rolePolicyId = num(d?.rolePolicyId);
    if (policyId == null && rolePolicyId == null) {
      return {
        status: 'succeeded',
        completeness: 'not_applicable',
        canonical: { policyId: null, observedName: null, rolePolicyId: null },
        itemCount: 0,
        endpoint: '/v2/device/{id}',
      };
    }
    let observedName: string | null = null;
    try {
      if (policyId != null) {
        const p = ctx.store.database
          .prepare('SELECT display_name FROM entities_policy WHERE policy_id = ?')
          .get(policyId) as { display_name?: string } | undefined;
        observedName = p?.display_name ?? null;
      }
    } catch {
      observedName = null;
    }
    return {
      status: 'succeeded',
      completeness: 'complete',
      canonical: {
        policyId,
        observedName,
        rolePolicyId,
        nodeClass: d?.nodeClass ?? undefined,
      },
      itemCount: policyId != null ? 1 : 0,
      endpoint: '/v2/device/{id}',
    };
  },

  software_inventory: async (ctx) =>
    deviceList(ctx, () => ctx.api.getDeviceSoftware(ctx.deviceId), '/v2/device/{id}/software', (r) =>
      pick(r, ['name', 'version', 'publisher', 'installDate', 'id']),
    ),

  os_patch_state: async (ctx) =>
    // Real shape: id,name,severity,status,type,deviceId,timestamp,kbNumber.
    // This is a PENDING-patch list — never report "0 failed / all installed".
    pagedQuery(ctx, 'queryOSPatches', '/v2/queries/os-patches', (r) =>
      pick(r, ['id', 'name', 'kbNumber', 'status', 'severity', 'type', 'timestamp', 'deviceId']),
    ),

  software_patch_state: async (ctx) =>
    pagedQuery(ctx, 'querySoftwarePatches', '/v2/queries/software-patches', (r) =>
      pick(r, ['id', 'name', 'status', 'type', 'timestamp', 'deviceId']),
    ),

  storage: async (ctx) =>
    // Real shape: name,driveLetter,label,deviceType,fileSystem,capacity,
    // freeSpace,serialNumber,timestamp.
    pagedQuery(ctx, 'queryVolumes', '/v2/queries/volumes', (r) =>
      pick(r, ['name', 'driveLetter', 'label', 'deviceType', 'fileSystem', 'capacity', 'freeSpace', 'timestamp', 'deviceId']),
    ),

  alerts: async (ctx) =>
    // Real shape: uid,severity,priority,conditionName,createTime,updateTime,
    // sourceType,subject,message — there is no 'status' field.
    deviceList(ctx, () => ctx.api.getDeviceAlerts(ctx.deviceId), '/v2/device/{id}/alerts', (r) =>
      pick(r, ['uid', 'severity', 'priority', 'conditionName', 'conditionHealthStatus', 'createTime', 'updateTime', 'sourceType', 'subject']),
    ),

  os_patch_history: async (ctx) =>
    // Real shape: id,name,severity,status,type,installedAt,kbNumber.
    deviceList(
      ctx,
      () => ctx.api.getDeviceOSPatchInstalls(ctx.deviceId),
      '/v2/device/{id}/os-patch-installs',
      (r) => pick(r, ['id', 'name', 'kbNumber', 'status', 'type', 'installedAt', 'deviceId']),
    ),

  software_patch_history: async (ctx) =>
    deviceList(
      ctx,
      () => ctx.api.getDeviceSoftwarePatchInstalls(ctx.deviceId),
      '/v2/device/{id}/software-patch-installs',
      (r) => pick(r, ['id', 'name', 'productName', 'status', 'type', 'installedAt', 'deviceId']),
    ),
};

export interface CaptureOptions {
  deviceId: number;
  profile?: string | undefined;
  resources?: string[] | undefined;
  kind?: 'on_demand' | 'scheduled' | 'pre_op' | 'post_op' | undefined;
  scheduleId?: string | undefined;
  slotKey?: string | undefined;
  requestBudget?: number | undefined;
  device?: any; // pre-fetched device record (schedule path supplies it)
}

export class SnapshotService {
  constructor(
    private store: EntityStore,
    private api: any,
    private profile = 'local',
  ) {}

  private get db() {
    return this.store.database;
  }

  /** Journal a capture as an operation — read-only upstream work is still
      an initiated action worth auditing. Never throws. */
  private journalCapture(opts: CaptureOptions, status: 'ok' | 'error', detail?: string, snapshotId?: string | null): void {
    try {
      this.store.logOperation({
        profile: this.profile,
        tool: 'capture_device_snapshot',
        args: {
          deviceId: opts.deviceId,
          profile: opts.profile ?? 'standard',
          resources: opts.resources ?? null,
          kind: opts.kind ?? 'on_demand',
          snapshotId: snapshotId ?? null,
        },
        targetDeviceId: opts.deviceId,
        dryRun: false,
        status,
        error: detail ?? null,
      });
    } catch { /* journaling must never break a capture */ }
  }

  /** Adapter calls get a hard timeout so a hung upstream can't wedge a run. */
  private static readonly ADAPTER_TIMEOUT_MS = 30_000;

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('adapter timeout')), ms);
      p.then((v) => {
        clearTimeout(t);
        resolve(v);
      }, (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  /**
   * Run one capture: fresh device preflight read, then each resource adapter
   * sequentially (bounded concurrency = 1, spec §4.3). Every requested
   * resource records a terminal observation; run ends partial unless all
   * succeeded. Seals a manifest only after the run completes.
   *
   * Coalescing: an identical in-flight run (same device+profile+resources)
   * returns its runId instead of starting a duplicate capture.
   */
  async capture(opts: CaptureOptions): Promise<{ runId: string; snapshotId: string | null; coverage: any; coalesced?: boolean }> {
    const resourcesForKey = (opts.resources?.length ? [...opts.resources].sort() : null);
    const keyResources = JSON.stringify(resourcesForKey);
    // A crashed process leaves runs in 'running' forever — terminate them so
    // they never block a fresh capture. The predicate uses the worker
    // heartbeat (written after every resource), not created_at: a healthy
    // capture heartbeats far more often than the 10-min bound, so this can
    // only fire on a run whose worker is genuinely gone.
    this.db
      .prepare(
        `UPDATE device_capture_runs SET status='interrupted', safe_error='process_lost', completed_at=?
         WHERE device_id = ? AND status = 'running'
           AND COALESCE(heartbeat_at, created_at) < ?`,
      )
      .run(Date.now(), opts.deviceId, Date.now() - 10 * 60 * 1000);
    // Coalesce duplicate concurrent captures for the same requested scope.
    const running = this.db
      .prepare(
        `SELECT id, resources_json, profile FROM device_capture_runs
         WHERE device_id = ? AND status = 'running' AND kind = ?`,
      )
      .all(opts.deviceId, opts.kind ?? 'on_demand') as any[];
    for (const r of running) {
      if (r.profile === (opts.profile ?? 'standard')) {
        const same = JSON.stringify(JSON.parse(r.resources_json).slice().sort?.() ?? []) === keyResources;
        if (same || resourcesForKey === null) {
          return { runId: r.id, snapshotId: null, coverage: { status: 'running' }, coalesced: true };
        }
      }
    }

    const runId = randomUUID();
    const now = Date.now();
    const profile = opts.profile ?? 'standard';
    const resources: string[] = opts.resources?.length
      ? opts.resources
      : (RESOURCE_PROFILES[profile] ?? RESOURCE_PROFILES['standard'] ?? []);
    const budget = opts.requestBudget ?? 200;
    const connId = this.store.connId;

    this.db
      .prepare(
        `INSERT INTO device_capture_runs
           (id, connection_id, device_id, kind, profile, resources_json, status, slot_key, schedule_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(runId, connId, opts.deviceId, opts.kind ?? 'on_demand', profile, JSON.stringify(resources), 'running', opts.slotKey ?? null, opts.scheduleId ?? null, now);

    const ctx: Ctx = {
      api: this.api,
      deviceId: opts.deviceId,
      device: opts.device ?? null,
      store: this.store,
      requestBudget: budget,
      requestsUsed: 0,
    };

    // Fresh upstream device read — snapshot identity is never stale cache.
    if (!ctx.device) {
      try {
        ctx.device = await this.api.getDevice(opts.deviceId);
        ctx.requestsUsed++;
      } catch (err) {
        const c = classifyError(err);
        this.db
          .prepare(`UPDATE device_capture_runs SET status='failed', safe_error=?, request_count=?, completed_at=? WHERE id=?`)
          .run(`device_prefetch_${c.safeError}`, ctx.requestsUsed, Date.now(), runId);
        this.journalCapture(opts, 'error', `device_prefetch_${c.safeError}`);
        return { runId, snapshotId: null, coverage: { status: 'failed', reason: c.safeError } };
      }
    }

    const coverage: Record<string, { status: string; completeness: string; observationId?: string }> = {};
    let allOk = true;

    for (const type of resources) {
      const adapter = ADAPTERS[type];
      const obsId = randomUUID();
      const fetchAt = Date.now();
      let res: AdapterResult;
      if (!adapter) {
        res = unavailable(type);
      } else {
        try {
          res = await this.withTimeout(adapter(ctx), SnapshotService.ADAPTER_TIMEOUT_MS);
        } catch (err) {
          res = { status: 'failed', completeness: 'unknown', safeError: 'timeout', endpoint: type };
        }
      }

      // Persist canonical payload deduplicated by semantic hash.
      let payloadId: string | null = null;
      if (res.canonical !== undefined) {
        const canonicalJson = JSON.stringify(canonicalize(res.canonical));
        payloadId = sha256(`${connId}|${type}|${CANONICALIZER_VERSION}|${canonicalJson}`);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO device_resource_payloads (id, connection_id, resource_type, canonical_json, created_at)
             VALUES (?,?,?,?,?)`,
          )
          .run(payloadId, connId, type, canonicalJson, fetchAt);
      }

      this.db
        .prepare(
          `INSERT INTO device_resource_observations
             (id, run_id, connection_id, device_id, resource_type, collector_version, adapter_version, source_endpoint,
              fetched_at, source_observed_at, collection_status, completeness,
              item_count, returned_count, pages_fetched, payload_id, safe_error, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          obsId,
          runId,
          connId,
          opts.deviceId,
          type,
          COLLECTOR_VERSION,
          ADAPTER_VERSION,
          res.endpoint,
          fetchAt,
          res.sourceObservedAt ?? null,
          res.status,
          res.completeness,
          res.itemCount ?? null,
          res.returnedCount ?? null,
          res.pagesFetched ?? 1,
          payloadId,
          res.safeError ?? null,
          fetchAt,
        );

      coverage[type] = { status: res.status, completeness: res.completeness, observationId: obsId };
      if (res.status !== 'succeeded') allOk = false;
      // Liveness heartbeat — stale-run recovery keys on this, so a healthy
      // worker is never mistaken for a stranded one.
      this.db
        .prepare(`UPDATE device_capture_runs SET heartbeat_at=? WHERE id=?`)
        .run(Date.now(), runId);
    }

    // Persisted baseline semantics: the sealed manifest links the latest
    // succeeded observation for EVERY resource type not freshly collected
    // this run — regardless of profile. A per-resource fetch of a
    // full-profile resource (e.g. os_patch_history under default 'standard')
    // must not drop other out-of-profile observations. A resource that was
    // requested but FAILED keeps its prior observation linked under a
    // 'failed' state — retained evidence, honestly labeled.
    const priors = this.db
      .prepare(
        `SELECT resource_type, id FROM (
           SELECT resource_type, id,
                  ROW_NUMBER() OVER (PARTITION BY resource_type ORDER BY fetched_at DESC, rowid DESC) rn
           FROM device_resource_observations
           WHERE device_id = ? AND collection_status = 'succeeded'
         ) WHERE rn = 1`,
      )
      .all(opts.deviceId) as any[];
    for (const p of priors) {
      const cur = coverage[p.resource_type];
      if (cur) {
        // Failed/skipped this run — retain the prior observation as evidence.
        if (cur.status !== 'succeeded' && !cur.observationId) cur.observationId = p.id;
        continue;
      }
      coverage[p.resource_type] = { status: 'reused', completeness: 'referenced', observationId: p.id };
    }

    const completed = Date.now();
    const runStatus = allOk ? 'completed' : 'partial';
    // Seal guard: only a still-running run may finalize. If stale-run
    // recovery already interrupted it, this worker is a zombie — its
    // observations stay on record but it must NOT seal a conflicting
    // snapshot over them.
    const fin = this.db
      .prepare(
        `UPDATE device_capture_runs SET status=?, request_count=?, completed_at=? WHERE id=? AND status='running'`,
      )
      .run(runStatus, ctx.requestsUsed, completed, runId);
    if (Number(fin.changes) === 0) {
      this.journalCapture(opts, 'error', 'interrupted_before_seal');
      return { runId, snapshotId: null, coverage: { status: 'interrupted', reason: 'interrupted_before_seal' } };
    }

    // Seal the manifest — deterministic digest over ALL linked resources:
    // freshly collected AND reused prior observations. Building this from
    // `coverage` (not `resources`) is what makes a per-resource fetch produce
    // a complete, honest snapshot instead of a one-resource stub.
    const snapshotId = randomUUID();
    const linkEntries = Object.keys(coverage)
      .map((t) => ({
        resource_type: t,
        observation_id: coverage[t]?.observationId ?? null,
        state:
          coverage[t]?.status === 'succeeded'
            ? 'collected'
            : coverage[t]?.status === 'reused'
              ? 'reused'
              : coverage[t]?.status === 'skipped'
                ? 'skipped'
                : 'failed',
      }))
      .sort((a, b) => (a.resource_type < b.resource_type ? -1 : 1));
    const manifestDigest = sha256(
      JSON.stringify({ v: CANONICALIZER_VERSION, device: opts.deviceId, profile, links: linkEntries }),
    );

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO device_snapshots
             (id, connection_id, device_id, capture_run_id, profile, reason, coverage_json, manifest_digest, sealed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          snapshotId,
          connId,
          opts.deviceId,
          runId,
          profile,
          opts.kind ?? 'on_demand',
          JSON.stringify(coverage),
          manifestDigest,
          completed,
          completed,
        );
      for (const l of linkEntries) {
        this.db
          .prepare(
            `INSERT INTO device_snapshot_resources (snapshot_id, resource_type, observation_id, state)
             VALUES (?,?,?,?)`,
          )
          .run(snapshotId, l.resource_type, l.observation_id, l.state);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.journalCapture(opts, 'error', 'seal_failed');
      throw err;
    }

    this.journalCapture(opts, 'ok', runStatus === 'partial' ? 'partial coverage' : undefined, snapshotId);
    return { runId, snapshotId, coverage: { status: runStatus, resources: coverage, digest: manifestDigest } };
  }

  listSnapshots(
    deviceId: number,
    opts?: { since?: number | undefined; until?: number | undefined; limit?: number | undefined },
  ): any[] {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const conds = ['device_id = ?'];
    const params: unknown[] = [deviceId];
    if (opts?.since) {
      conds.push('sealed_at >= ?');
      params.push(opts.since);
    }
    if (opts?.until) {
      conds.push('sealed_at <= ?');
      params.push(opts.until);
    }
    return this.db
      .prepare(
        `SELECT id, device_id, profile, reason, sealed_at, manifest_digest, coverage_json
         FROM device_snapshots WHERE ${conds.join(' AND ')} ORDER BY sealed_at DESC LIMIT ?`,
      )
      .all(...(params as any[]), limit)
      .map((r: any) => ({ ...r, coverage: JSON.parse(r.coverage_json), coverage_json: undefined }));
  }

  getSnapshot(snapshotId: string): any | null {
    const s = this.db
      .prepare(`SELECT * FROM device_snapshots WHERE id = ?`)
      .get(snapshotId) as any;
    if (!s) return null;
    const links = this.db
      .prepare(
        `SELECT r.resource_type, r.observation_id, r.state,
                o.fetched_at, o.source_observed_at, o.collection_status, o.completeness,
                o.item_count, o.returned_count, o.pages_fetched, o.safe_error, o.payload_id
         FROM device_snapshot_resources r
         LEFT JOIN device_resource_observations o ON o.id = r.observation_id
         WHERE r.snapshot_id = ? ORDER BY r.resource_type`,
      )
      .all(snapshotId) as any[];
    // Bounded preview per resource: first 5 items for lists, the scalar map
    // otherwise — enough for collapsed cards without paging a full inventory.
    for (const l of links) {
      if (!l.payload_id) continue;
      const p = this.db
        .prepare(`SELECT canonical_json FROM device_resource_payloads WHERE id = ?`)
        .get(l.payload_id) as any;
      if (!p) continue;
      const parsed = JSON.parse(p.canonical_json);
      l.preview =
        Array.isArray(parsed?.items)
          ? { items: parsed.items.slice(0, 5), total: parsed.items.length }
          : parsed;
    }
    return { ...s, coverage: JSON.parse(s.coverage_json), coverage_json: undefined, resources: links };
  }

  /** Observation + payload (bounded); detail='summary' omits item bodies. */
  getObservation(observationId: string, detail: 'summary' | 'full' = 'summary'): any | null {
    const o = this.db
      .prepare(`SELECT * FROM device_resource_observations WHERE id = ?`)
      .get(observationId) as any;
    if (!o) return null;
    let payload: any = null;
    if (o.payload_id) {
      const p = this.db
        .prepare(`SELECT canonical_json FROM device_resource_payloads WHERE id = ?`)
        .get(o.payload_id) as any;
      if (p) {
        const parsed = JSON.parse(p.canonical_json);
        payload =
          detail === 'full'
            ? parsed
            : {
                itemCount: Array.isArray(parsed?.items) ? parsed.items.length : undefined,
                keys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : undefined,
              };
      }
    }
    return { ...o, payload };
  }

  getRun(runId: string): any | null {
    return this.db.prepare(`SELECT * FROM device_capture_runs WHERE id = ?`).get(runId) ?? null;
  }

  /**
   * Deterministic per-resource diff between two sealed snapshots.
   * Coverage-aware: identical payload → unchanged; differing → changed;
   * missing/failed on either side → not_comparable. Partial coverage diffs
   * are labeled, never reported as complete.
   */
  compare(baselineId: string, comparisonId: string): any {
    const cached = this.db
      .prepare(
        `SELECT result_json FROM snapshot_comparisons WHERE baseline_id=? AND comparison_id=? AND diff_version=?`,
      )
      .get(baselineId, comparisonId, DIFF_VERSION) as any;
    if (cached) return { ...JSON.parse(cached.result_json), cached: true };

    const base = this.getSnapshot(baselineId);
    const comp = this.getSnapshot(comparisonId);
    if (!base || !comp) return { error: 'snapshot_not_found' };
    if (base.device_id !== comp.device_id) return { error: 'device_mismatch' };

    const baseMap = new Map<string, any>(base.resources.map((r: any) => [r.resource_type, r]));
    const compMap = new Map<string, any>(comp.resources.map((r: any) => [r.resource_type, r]));
    const types = [...new Set([...baseMap.keys(), ...compMap.keys()])].sort();

    const diffs: any[] = [];
    for (const type of types) {
      const b = baseMap.get(type);
      const c = compMap.get(type);
      const usable = (r: any) => r && (r.state === 'collected' || r.state === 'reused') && r.observation_id;
      if (!usable(b) || !usable(c)) {
        diffs.push({
          resource: type,
          status: 'not_comparable',
          reason: !b ? 'missing_in_baseline' : !c ? 'missing_in_comparison' : 'collection_incomplete',
          baselineObservedAt: b ? this.observedAt(b.observation_id) : null,
          comparisonObservedAt: c ? this.observedAt(c.observation_id) : null,
        });
        continue;
      }
      const bo = this.getObservation(b.observation_id, 'full');
      const co = this.getObservation(c.observation_id, 'full');
      const bp = bo?.payload_id;
      const cp = co?.payload_id;
      if (bp && cp && bp === cp) {
        diffs.push({ resource: type, status: 'unchanged' });
        continue;
      }
      const partial =
        bo?.completeness === 'partial' || co?.completeness === 'partial';
      // Adapter-version skew: field allowlists changed between captures.
      // Diff only the shared field set — fields unique to one version are a
      // schemaDelta, never endpoint data changes. No shared fields → the
      // resource is genuinely not comparable across the schema change.
      const versionSkew =
        bo?.adapter_version != null &&
        co?.adapter_version != null &&
        bo.adapter_version !== co.adapter_version;
      const detail = this.diffPayloads(bo?.payload, co?.payload, versionSkew);
      if (detail?.schemaChange === true) {
        diffs.push({
          resource: type,
          status: 'not_comparable',
          reason: 'schema_version_change',
          detail,
          baselineFetchedAt: bo?.fetched_at ?? null,
          comparisonFetchedAt: co?.fetched_at ?? null,
        });
        continue;
      }
      // After projection to the shared field set, an empty diff means the
      // payloads differ only by schema additions — NOT an endpoint change.
      const emptyDiff =
        (Array.isArray(detail?.fields) && detail.fields.length === 0) ||
        (detail?.itemCounts &&
          !(detail.added?.length || detail.removed?.length || detail.modified?.length));
      if (versionSkew && emptyDiff) {
        diffs.push({
          resource: type,
          status: 'unchanged',
          detail,
          adapterVersions: { baseline: bo.adapter_version, comparison: co.adapter_version },
        });
        continue;
      }
      // Routine ticks (e.g. device lastContact) are honest changes but not
      // meaningful ones — flagged, and excluded from meaningfulChanged.
      const routineOnly =
        Array.isArray(detail?.fields) &&
        detail.fields.length > 0 &&
        detail.fields.every((f: any) => ROUTINE_FIELDS.has(f.field));
      diffs.push({
        resource: type,
        status: 'changed',
        coverage: partial ? 'partial' : 'complete',
        detail,
        ...(routineOnly ? { meaningful: false, routine: true } : { meaningful: true }),
        ...(versionSkew
          ? { adapterVersions: { baseline: bo.adapter_version, comparison: co.adapter_version } }
          : {}),
        baselineFetchedAt: bo?.fetched_at ?? null,
        comparisonFetchedAt: co?.fetched_at ?? null,
      });
    }

    const result = {
      baselineId,
      comparisonId,
      deviceId: base.device_id,
      baselineSealedAt: base.sealed_at,
      comparisonSealedAt: comp.sealed_at,
      diffVersion: DIFF_VERSION,
      resources: diffs,
      counts: {
        changed: diffs.filter((d) => d.status === 'changed').length,
        meaningfulChanged: diffs.filter((d) => d.status === 'changed' && d.meaningful !== false).length,
        unchanged: diffs.filter((d) => d.status === 'unchanged').length,
        not_comparable: diffs.filter((d) => d.status === 'not_comparable').length,
      },
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshot_comparisons
           (id, connection_id, baseline_id, comparison_id, diff_version, result_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(randomUUID(), this.store.connId, baselineId, comparisonId, DIFF_VERSION, JSON.stringify(result), Date.now());
    return result;
  }

  private observedAt(obsId: string | null): number | null {
    if (!obsId) return null;
    const r = this.db
      .prepare(`SELECT fetched_at FROM device_resource_observations WHERE id=?`)
      .get(obsId) as any;
    return r?.fetched_at ?? null;
  }

  /**
   * Item-level diff for list payloads; field-level diff for scalar maps.
   * With versionSkew (adapter versions differ), only fields present on BOTH
   * sides are compared — fields unique to one version are reported as
   * schemaDelta, never as adds/removes. Zero shared fields → schemaChange.
   */
  private diffPayloads(base: any, comp: any, versionSkew = false): any {
    if (!base || !comp) return { note: 'payload_unavailable' };
    const fieldsOf = (items: any[]) => {
      const s = new Set<string>();
      for (const it of items) if (it && typeof it === 'object') for (const k of Object.keys(it)) s.add(k);
      return s;
    };
    const project = (it: any, shared: Set<string>) =>
      Object.fromEntries(Object.entries(it ?? {}).filter(([k]) => shared.has(k)));

    if (Array.isArray(base.items) || Array.isArray(comp.items)) {
      const bItems: any[] = base.items ?? [];
      const cItems: any[] = comp.items ?? [];
      let shared: Set<string> | null = null;
      let schemaDelta: any = null;
      if (versionSkew) {
        const bF = fieldsOf(bItems);
        const cF = fieldsOf(cItems);
        shared = new Set([...bF].filter((k) => cF.has(k)));
        if (bF.size && cF.size && shared.size === 0) {
          return { schemaChange: true, note: 'no shared fields between adapter versions' };
        }
        const onlyB = [...bF].filter((k) => !cF.has(k));
        const onlyC = [...cF].filter((k) => !bF.has(k));
        if (onlyB.length || onlyC.length) {
          schemaDelta = { onlyInBaseline: onlyB.sort(), onlyInComparison: onlyC.sort() };
        }
      }
      const proj = (it: any) => (shared ? project(it, shared) : it);
      // Identity: prefer a natural key — but under version skew only a key
      // field present in BOTH versions is safe. If the keyed field is not
      // shared (e.g. renamed across versions), fall back to the projected
      // item so schema-only differences can't phantom-match.
      const keyOf = (it: any) => {
        const k = stableKey(it);
        if (k !== null) {
          if (!shared) return k;
          const field = k.slice(0, k.indexOf(':'));
          if (shared.has(field)) return k;
        }
        return shared ? JSON.stringify(proj(it)) : JSON.stringify(it);
      };
      const bKeys = new Map(bItems.map((i) => [keyOf(i), i]));
      const cKeys = new Map(cItems.map((i) => [keyOf(i), i]));
      const added = cItems.filter((i) => !bKeys.has(keyOf(i))).slice(0, 50);
      const removed = bItems.filter((i) => !cKeys.has(keyOf(i))).slice(0, 50);
      const modified: any[] = [];
      for (const [k, bi] of bKeys) {
        const ci = cKeys.get(k);
        if (ci && JSON.stringify(proj(bi)) !== JSON.stringify(proj(ci))) {
          modified.push({ key: k, before: proj(bi), after: proj(ci) });
          if (modified.length >= 50) break;
        }
      }
      return {
        itemCounts: { baseline: bItems.length, comparison: cItems.length },
        added,
        removed,
        modified,
        truncated: bItems.length > 50 || cItems.length > 50,
        ...(schemaDelta ? { schemaDelta } : {}),
      };
    }
    const bF = new Set(Object.keys(base));
    const cF = new Set(Object.keys(comp));
    let keys = [...new Set([...bF, ...cF])].sort();
    let schemaDelta: any = null;
    if (versionSkew) {
      const shared = new Set([...bF].filter((k) => cF.has(k)));
      if (bF.size && cF.size && shared.size === 0) {
        return { schemaChange: true, note: 'no shared fields between adapter versions' };
      }
      const onlyB = [...bF].filter((k) => !cF.has(k));
      const onlyC = [...cF].filter((k) => !bF.has(k));
      if (onlyB.length || onlyC.length) {
        schemaDelta = { onlyInBaseline: onlyB.sort(), onlyInComparison: onlyC.sort() };
      }
      keys = [...shared].sort();
    }
    const changed: any[] = [];
    for (const k of keys) {
      if (JSON.stringify(base[k]) !== JSON.stringify(comp[k])) {
        changed.push({ field: k, before: base[k] ?? null, after: comp[k] ?? null });
      }
    }
    return { fields: changed.slice(0, 50), ...(schemaDelta ? { schemaDelta } : {}) };
  }

  /**
   * Meaningful changes since `since`: entity_changes minus routine
   * last_contact ticks; '__appeared__' events labeled readably.
   */
  changeSummary(deviceId: number, since: number): any {
    const rows = this.db
      .prepare(
        `SELECT field, old_value, new_value, detected_at FROM entity_changes
         WHERE entity_type='device' AND entity_id=? AND detected_at>=? ORDER BY detected_at DESC LIMIT 200`,
      )
      .all(deviceId, since) as any[];
    const ticks = rows.filter((r) => r.field === 'last_contact').length;
    const changes = rows
      .filter((r) => r.field !== 'last_contact')
      .map((r) => ({
        field: r.field === '__appeared__' ? 'first_observed_locally' : r.field,
        label: r.field === '__appeared__' ? 'First observed locally' : r.field,
        old: r.old_value,
        new: r.new_value,
        at: r.detected_at,
      }));
    return {
      deviceId,
      since,
      meaningful: changes.length,
      routineContactTicks: ticks,
      changes,
      stale: changes.length === 0 && ticks === 0 ? 'no_recorded_changes' : null,
    };
  }

  // ---- schedules -----------------------------------------------------------

  upsertSchedule(cfg: {
    id?: string | undefined;
    name: string;
    scope: { orgId?: number | undefined; deviceIds?: number[] | undefined };
    profile?: string | undefined;
    timezone?: string | undefined;
    windowHhmm?: string | undefined;
    budgetRequests?: number | undefined;
    enabled?: boolean | undefined;
  }): { id: string } {
    const id = cfg.id ?? randomUUID();
    const existing = this.db.prepare(`SELECT policy_version FROM capture_schedules WHERE id=?`).get(id) as any;
    this.db
      .prepare(
        `INSERT INTO capture_schedules
           (id, connection_id, name, scope_json, profile, timezone, window_hhmm, budget_requests, enabled, policy_version, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, scope_json=excluded.scope_json,
           profile=excluded.profile, timezone=excluded.timezone, window_hhmm=excluded.window_hhmm,
           budget_requests=excluded.budget_requests, enabled=excluded.enabled,
           policy_version=capture_schedules.policy_version+1`,
      )
      .run(
        id,
        this.store.connId,
        cfg.name,
        JSON.stringify(cfg.scope),
        cfg.profile ?? 'standard',
        cfg.timezone ?? 'UTC',
        cfg.windowHhmm ?? '02:00',
        cfg.budgetRequests ?? 500,
        cfg.enabled === false ? 0 : 1,
        (existing?.policy_version ?? 0) + 1,
        Date.now(),
      );
    return { id };
  }

  listSchedules(): any[] {
    return (this.db.prepare(`SELECT * FROM capture_schedules ORDER BY name`).all() as any[]).map((s) => {
      const runs = this.db
        .prepare(
          `SELECT status, slot_key, created_at, completed_at, safe_error
           FROM device_capture_runs WHERE schedule_id = ? AND device_id = -1
           ORDER BY created_at DESC LIMIT 10`,
        )
        .all(s.id) as any[];
      const lastRun = runs.find((r) => r.status !== 'missed') ?? null;
      const missed = runs.filter((r) => r.status === 'missed').length;
      // Next slot = tomorrow's window in schedule tz (today already claimed or pending).
      return {
        ...s,
        scope: JSON.parse(s.scope_json),
        scope_json: undefined,
        enabled: Boolean(s.enabled),
        last_run: lastRun,
        missed_runs: missed,
        note: 'Foreground scheduling — runs only while this server process is up.',
      };
    });
  }

  /**
   * Deterministic local-date slot: "YYYY-MM-DD" in the schedule's timezone
   * (Intl handles DST — a skipped hour never matches a date, a repeated hour
   * still yields one date → one slot per local day, spec §5).
   */
  localDateOf(ts: number, tz: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    } catch {
      return new Date(ts).toISOString().slice(0, 10);
    }
  }

  /** Hour-of-day in the schedule's timezone, for window matching. */
  localHourOf(ts: number, tz: string): number {
    try {
      return Number(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ts)),
      );
    } catch {
      return new Date(ts).getUTCHours();
    }
  }

  /**
   * One tick: for each enabled schedule whose window hour has arrived and
   * whose today's slot hasn't run, expand scope membership and capture each
   * device sequentially. Slot key uniqueness dedupes restarts/DST repeats.
   * If now is past the window hour with no slot row, the slot still runs
   * (catch-up same day); yesterday's missed window is recorded 'missed' —
   * never fabricated.
   */
  async tickSchedules(now: number = Date.now()): Promise<any[]> {
    const schedules = this.db
      .prepare(`SELECT * FROM capture_schedules WHERE enabled = 1`)
      .all() as any[];
    const fired: any[] = [];
    for (const s of schedules) {
      const today = this.localDateOf(now, s.timezone);
      const slotKey = `${s.id}:${today}:pv${s.policy_version}`;
      const windowHour = Number(String(s.window_hhmm).split(':')[0]);
      if (this.localHourOf(now, s.timezone) < windowHour) continue;

      // Record up to 7 recent missed days honestly — never fabricate a
      // snapshot for a day the process wasn't running (§5 missed-run rule).
      for (let back = 1; back <= 7; back++) {
        const missedDate = this.localDateOf(now - back * 86_400_000, s.timezone);
        const missedKey = `${s.id}:${missedDate}:pv${s.policy_version}`;
        try {
          this.db
            .prepare(
              `INSERT INTO device_capture_runs
                 (id, connection_id, device_id, kind, profile, resources_json, status, slot_key, schedule_id, safe_error, created_at, completed_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(randomUUID(), this.store.connId, -1, 'scheduled', s.profile, '[]', 'missed', missedKey, s.id, 'server_not_running', now, now);
        } catch {
          /* slot row exists (ran, interrupted, or already marked missed) */
        }
      }

      const dup = this.db
        .prepare(`SELECT id, status, created_at, heartbeat_at FROM device_capture_runs WHERE slot_key = ? LIMIT 1`)
        .get(slotKey) as any;
      if (dup) {
        // A claimed slot whose process crashed stays 'running' forever and
        // would strand this schedule permanently — terminate it honestly.
        // Heartbeat, not created_at: a live worker heartbeats every resource.
        if (dup.status === 'running' && now - Number(dup.heartbeat_at ?? dup.created_at) > 10 * 60 * 1000) {
          this.db
            .prepare(`UPDATE device_capture_runs SET status='interrupted', safe_error='process_lost', completed_at=? WHERE id=?`)
            .run(now, dup.id);
        }
        continue;
      }

      const scope = JSON.parse(s.scope_json);
      const deviceIds: number[] = Array.isArray(scope.deviceIds) ? scope.deviceIds : [];
      if (scope.orgId != null) {
        const rows = this.db
          .prepare(`SELECT device_id FROM entities_device WHERE org_id = ?`)
          .all(scope.orgId) as any[];
        for (const r of rows) if (!deviceIds.includes(r.device_id)) deviceIds.push(r.device_id);
      }

      // Reserve slot BEFORE running — a crash mid-run can't double-fire.
      const runGroupId = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO device_capture_runs
               (id, connection_id, device_id, kind, profile, resources_json, status, slot_key, schedule_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(runGroupId, this.store.connId, -1, 'scheduled', s.profile, JSON.stringify(deviceIds), 'running', slotKey, s.id, now);
      } catch {
        continue; // slot already claimed by a racing tick
      }

      const perDeviceBudget = Math.max(10, Math.floor(s.budget_requests / Math.max(1, deviceIds.length)));
      const results: any[] = [];
      for (const deviceId of deviceIds) {
        // Heartbeat the group row — a long multi-device run must not be
        // mistaken for a stranded claim by the next tick.
        this.db
          .prepare(`UPDATE device_capture_runs SET heartbeat_at=? WHERE id=?`)
          .run(Date.now(), runGroupId);
        try {
          const r = await this.capture({
            deviceId,
            profile: s.profile,
            kind: 'scheduled',
            scheduleId: s.id,
            requestBudget: perDeviceBudget,
          });
          results.push({ deviceId, runId: r.runId, snapshotId: r.snapshotId, status: r.coverage?.status });
        } catch (err) {
          results.push({ deviceId, status: 'failed', error: 'capture_error' });
        }
      }
      const allDone = results.every((r) => r.status === 'completed' || r.status === 'partial');
      this.db
        .prepare(`UPDATE device_capture_runs SET status=?, request_count=?, completed_at=? WHERE id=?`)
        .run(allDone ? 'completed' : 'failed', results.length, Date.now(), runGroupId);
      this.db
        .prepare(`UPDATE capture_schedules SET last_slot=? WHERE id=?`)
        .run(slotKey, s.id);
      fired.push({ scheduleId: s.id, slot: slotKey, devices: results });
    }
    return fired;
  }

  /** Deterministic markdown report — no LLM, evidence references only. */
  renderReport(kind: 'snapshot' | 'comparison' | 'work_evidence', ref: string): string {
    const lines: string[] = [];
    if (kind === 'snapshot') {
      const s = this.getSnapshot(ref);
      if (!s) return '# Snapshot report\n\nSnapshot not found.';
      lines.push(
        `# Device snapshot report`,
        ``,
        `- Snapshot: \`${s.id}\``,
        `- Device: ${s.device_id}`,
        `- Profile: ${s.profile} · Reason: ${s.reason}`,
        `- Sealed: ${new Date(s.sealed_at).toISOString()} · Digest: \`${s.manifest_digest.slice(0, 16)}\``,
        ``,
        `## Resource coverage`,
      );
      for (const r of s.resources) {
        lines.push(`- ${r.resource_type}: ${r.state}${r.observation_id ? ` (obs \`${r.observation_id.slice(0, 8)}\`)` : ''}`);
      }
      lines.push(``, `_Retained local observations; provenance not certified forensic proof._`);
    } else if (kind === 'comparison') {
      const c = this.compare(ref.split(':')[0]!, ref.split(':')[1]!);
      if (c.error) return `# Comparison report\n\n${c.error}`;
      lines.push(
        `# Device comparison report`,
        ``,
        `- Baseline: \`${c.baselineId}\` (${new Date(c.baselineSealedAt).toISOString()})`,
        `- Comparison: \`${c.comparisonId}\` (${new Date(c.comparisonSealedAt).toISOString()})`,
        `- Changed: ${c.counts.changed} · Unchanged: ${c.counts.unchanged} · Not comparable: ${c.counts.not_comparable}`,
        ``,
        `## Changes`,
      );
      for (const r of c.resources) {
        if (r.status !== 'changed') continue;
        const d = r.detail ?? {};
        lines.push(`- **${r.resource}**${r.coverage === 'partial' ? ' (partial coverage)' : ''}`);
        if (d.fields) for (const f of d.fields.slice(0, 10)) lines.push(`  - ${f.field}: \`${JSON.stringify(f.before)}\` → \`${JSON.stringify(f.after)}\``);
        if (d.added?.length) lines.push(`  - +${d.added.length} item(s)`);
        if (d.removed?.length) lines.push(`  - −${d.removed.length} item(s)`);
      }
      if (c.counts.changed === 0) lines.push(`- No comparable changes found (not equivalent to "nothing changed").`);
      lines.push(``, `_Differences are observed-state deltas; they do not prove causation._`);
    } else {
      const op = this.db.prepare(`SELECT * FROM operations WHERE id = ?`).get(ref) as any;
      if (!op) return '# Work evidence report\n\nOperation not found.';
      const events = this.db
        .prepare(`SELECT kind, at FROM operation_events WHERE operation_id=? ORDER BY seq`)
        .all(ref) as any[];
      lines.push(
        `# Work evidence report`,
        ``,
        `- Operation: \`${op.id}\` · ${op.operation} on device ${op.target_id}`,
        `- Status: ${op.status}`,
        ``,
        `## Evidence chain`,
      );
      for (const e of events) lines.push(`- ${new Date(e.at).toISOString()} — ${e.kind}`);
      lines.push(
        ``,
        `_Requested/approved/dispatched/observed are distinct stages; an observed end state does not alone prove this operation caused it._`,
      );
    }
    return lines.join('\n');
  }
}
