/**
 * INFRA-1 — organization infrastructure knowns.
 *
 * Evidence model (plan §5): immutable entity/relationship OBSERVATIONS
 * linked to collection COVERAGE rows (which receipt/section/scope produced
 * them) plus a rebuildable CURRENT projection. Raw receipts stay in
 * operations.result_json — nothing here replaces them.
 *
 * Extraction is deterministic, typed, and versioned (EXTRACTOR_VERSION).
 * LLMs may explain facts; they never author observed configuration.
 *
 * Absence semantics (plan §6): only a COMPLETE enumeration of the same
 * source+namespace+section scope can mark entities 'not_observed'. A
 * failed/partial/unverified section creates coverage rows but zero
 * removal events. "Not observed since…" — never "Deleted".
 */
import { randomUUID } from 'node:crypto';
import type { EntityStore } from './entity-store.js';

// Bump when extraction semantics change: 2 = v3 RBJGZ payloads + superseded
// status; 3 = DHCP v4 (authorization, reservations, leases as entities;
// coverage.namespaces for empty-enumeration absence); 4 = GpoStatus decoded
// as the .NET enum (3 = all enabled), fixing the inverted v1–v3 labels.
export const EXTRACTOR_VERSION = 4;

/** Categories with typed schemas — no unconstrained blobs (plan §5). */
export const INFRA_CATEGORIES = [
  'forest',
  'domain',
  'domain-controller',
  'fsmo-role',
  'site',
  'dns-server',
  'dns-zone',
  'dns-record',
  'dhcp-server',
  'dhcp-scope',
  'dhcp-reservation',
  'dhcp-lease',
  'gpo',
  'container',
] as const;
export type InfraCategory = (typeof INFRA_CATEGORIES)[number];

export type CoverageStatus = 'complete' | 'partial' | 'failed' | 'unverified' | 'not-applicable';
export type EntityStatus = 'observed' | 'not_observed' | 'conflicting' | 'stale' | 'superseded';

interface ExtractCtx {
  connection_id: string | null;
  org_id: number;
  operation_id: string;
  target_seq: number | null;
  runbook_id: string;
  runbook_version: number;
  source_device_id: number;
  source_device_name: string;
  collected_at: number;
  parsed: Record<string, unknown>;
  opStatus: string;
  exitCode: number | null;
}

interface CoverageRec {
  section: string;
  status: CoverageStatus;
  completeness?: string | undefined;
  count?: number | undefined;
  truncated?: boolean | undefined;
  note?: string | undefined;
  /** Namespaces this section fully enumerated — used for scoped absence when
   *  some namespaces legitimately produced zero entities (e.g. a scope with
   *  no leases: its namespace must still be evaluated or stale leases would
   *  linger as 'observed'). */
  namespaces?: string[] | undefined;
}

interface EntityRec {
  category: InfraCategory;
  namespace: string;
  key: string;
  display?: string | undefined;
  aliases?: string[] | undefined;
  attrs: Record<string, unknown>;
  /** Fields to compare for conflict detection. */
  watch?: string[] | undefined;
}

interface RelRec {
  from: { category: InfraCategory; namespace: string; key: string };
  to: { category: InfraCategory; namespace: string; key: string };
  rel_type: string;
  attrs?: Record<string, unknown> | undefined;
}

interface ExtractionResult {
  coverage: CoverageRec[];
  entities: EntityRec[];
  relationships: RelRec[];
  /** Human-readable qualifications, e.g. legacy receipt with exit conflict. */
  qualified: string[];
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
/**
 * PowerShell ConvertTo-Json serializes DateTime as '/Date(1322878261000)/'.
 * Normalize those wrappers to epoch ms at ingest so stored attrs render and
 * compare as dates (deep-walks objects/arrays; everything else untouched).
 */
const PS_DATE = /^\/Date\((\d+)\)\/$/;
const normalizeAttr = (v: unknown): unknown => {
  if (typeof v === 'string') {
    const m = PS_DATE.exec(v.trim());
    return m ? Number(m[1]) : v;
  }
  if (Array.isArray(v)) return v.map(normalizeAttr);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeAttr(x);
    return out;
  }
  return v;
};
/**
 * A namespace is "unresolved" when the collector could not name the real
 * scope — `:unknown` placeholders ('domain:unknown', 'fsmo:unknown') or the
 * bare v1-era literals 'unknown-domain'/'unknown-forest'.
 */
const isUnresolvedNamespace = (ns: string): boolean =>
  ns.includes(':unknown') || ns === 'unknown' || ns === 'unknown-domain' || ns === 'unknown-forest';

const ipToInt = (ip: string | null): number | null => {
  if (!ip) return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n;
};

/* ── Extractors ─────────────────────────────────────────────────────────── */

type Extractor = (ctx: ExtractCtx) => ExtractionResult;

// v3 = v2 payload over a compressed wire (RBJGZ) — identical JSON shape,
// same extractor. Only the emission footer differs.
const EXTRACTORS: Record<string, Record<number, Extractor>> = {
  'diag/ad-health': { 1: extractAdHealthV1, 2: extractAdHealthV2, 3: extractAdHealthV2 },
  'diag/dns-server': { 1: extractDnsV1, 2: extractDnsV2, 3: extractDnsV2 },
  'diag/dhcp-scopes': { 1: extractDhcpV1, 2: extractDhcpV2, 3: extractDhcpV2, 4: extractDhcpV4 },
  'diag/dhcp-clients': { 1: extractDhcpClientsV1 },
  'diag/dns-records': { 1: extractDnsRecordsV1 },
  'diag/gpo-inventory': { 1: extractGpoV1, 2: extractGpoV2, 3: extractGpoV2 },
};

function adNamespace(ctx: ExtractCtx): string {
  const dom = ctx.parsed.domain as Record<string, unknown> | undefined;
  return norm(dom?.dnsRoot) || norm((ctx.parsed.forest as Record<string, unknown> | undefined)?.name) || `device:${ctx.source_device_id}`;
}

function dcEntity(hostname: string, domainNs: string): EntityRec {
  return {
    category: 'domain-controller',
    namespace: domainNs,
    // Host short name is the canonical key — dcInventory, FSMO holder lists,
    // and self-report disagree on FQDN vs short form; the machine is the same.
    key: norm(hostname.split('.')[0] ?? hostname),
    display: hostname,
    attrs: {},
  };
}

function extractAdHealthV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const coverage: CoverageRec[] = [];
  const entities: EntityRec[] = [];
  const relationships: RelRec[] = [];
  const qualified: string[] = [];
  const ns = `device:${ctx.source_device_id}`; // v1 has no domain identity — namespace is the queried DC
  const domainNs = 'unknown-domain';

  coverage.push({ section: 'roleDetect', status: 'complete', note: p.rolePresent ? 'NTDS service present' : 'NTDS service absent — not a DC' });
  if (!p.rolePresent) {
    for (const s of ['directory', 'replication', 'topology']) coverage.push({ section: s, status: 'not-applicable', note: 'role absent' });
    return { coverage, entities, relationships, qualified };
  }
  // Queried DC itself is a domain-controller entity (self-evidence: it answered).
  const self = dcEntity(ctx.source_device_name, domainNs);
  self.attrs = { selfReported: true, rolePresent: true };
  entities.push(self);

  const fsmo = p.fsmo as Record<string, unknown> | undefined;
  if (fsmo && (fsmo.pdc || fsmo.schema)) {
    coverage.push({ section: 'directory', status: 'complete', note: 'v1: fsmo/sites/dcCount populated; domain SID not collected' });
    for (const [role, holder] of Object.entries({ pdc: fsmo.pdc, rid: fsmo.rid, infra: fsmo.infra, schema: fsmo.schema, naming: fsmo.naming })) {
      if (!holder) continue;
      const scope = role === 'schema' || role === 'naming' ? 'forest' : 'domain';
      entities.push({ category: 'fsmo-role', namespace: `${scope}:unknown`, key: role, display: `${role} (${scope})`, attrs: { scope }, watch: ['holder'] });
      const holderName = str(holder)!;
      const short = holderName.split('.')[0]!;
      const dc = dcEntity(short, domainNs);
      dc.attrs = { reportedFqdn: holderName };
      entities.push(dc);
      relationships.push({
        from: { category: 'fsmo-role', namespace: `${scope}:unknown`, key: role },
        to: { category: 'domain-controller', namespace: domainNs, key: norm(short) },
        rel_type: 'held-by',
        attrs: { holderFqdn: holderName },
      });
    }
    if (typeof p.sites === 'number') coverage.push({ section: 'topology', status: 'partial', note: `sites=${p.sites} dcCount=${p.dcCount ?? '?'} — counts only, names not collected in v1`, count: p.sites as number });
  } else {
    coverage.push({ section: 'directory', status: 'failed', note: 'fsmo absent from v1 payload' });
  }
  // v1 replication: repadmin exit leaked (e.g. 234 on this receipt family) and
  // the catch was silent → output coverage cannot be established as complete.
  const replStatus: CoverageStatus = ctx.exitCode !== 0 ? 'unverified' : 'unverified';
  coverage.push({
    section: 'replication',
    status: replStatus,
    note: `v1 silent-catch + process exit ${ctx.exitCode ?? '?'} — "0 reported errors" is NOT established; coverage unverified`,
    count: Array.isArray(p.replicationErrors) ? (p.replicationErrors as unknown[]).length : undefined,
  });
  if (ctx.exitCode !== 0) {
    qualified.push(`receipt exitCode=${ctx.exitCode} conflicts with clean parse — sections ingested as qualified; replication coverage unverified`);
  }
  return { coverage, entities, relationships, qualified };
}

function extractAdHealthV2(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const coverage: CoverageRec[] = [];
  const entities: EntityRec[] = [];
  const relationships: RelRec[] = [];
  const qualified: string[] = [];
  const domain = p.domain as Record<string, unknown> | undefined;
  const forest = p.forest as Record<string, unknown> | undefined;
  const domainNs = norm(domain?.dnsRoot) || 'unknown-domain';
  const forestNs = norm(forest?.name) || 'unknown-forest';
  const cov = (name: string): CoverageStatus => (sections?.[name]?.status as CoverageStatus) ?? 'unverified';
  const covNote = (name: string) => (sections?.[name]?.note as string) ?? (sections?.[name]?.detail as string) ?? (sections?.[name]?.error as string) ?? undefined;

  coverage.push({ section: 'roleDetect', status: cov('roleDetect'), note: covNote('roleDetect') });
  coverage.push({ section: 'directory', status: cov('directory'), note: covNote('directory') });
  coverage.push({ section: 'dcInventory', status: cov('dcInventory'), note: covNote('dcInventory'), count: sections?.dcInventory?.count as number | undefined });
  coverage.push({ section: 'replication', status: cov('replication'), note: covNote('replication'), completeness: 'queried-dc-only' });

  if (p.rolePresent && cov('directory') === 'complete' && domain) {
    entities.push({
      category: 'domain', namespace: 'ad', key: norm(domain.domainSid) || domainNs,
      display: str(domain.dnsRoot) ?? undefined,
      aliases: [str(domain.netbios), str(domain.distinguishedName)].filter(Boolean) as string[],
      attrs: { dnsRoot: domain.dnsRoot, netbios: domain.netbios, domainMode: domain.domainMode, domainSid: domain.domainSid },
    });
    if (forest) {
      entities.push({
        category: 'forest', namespace: 'ad', key: forestNs,
        display: str(forest.name) ?? undefined,
        attrs: { name: forest.name, forestMode: forest.forestMode, rootDomain: forest.rootDomain, siteCount: p.sites ?? null, globalCatalogCount: p.dcCount ?? null },
      });
      relationships.push({ from: { category: 'domain', namespace: 'ad', key: norm(domain.domainSid) || domainNs }, to: { category: 'forest', namespace: 'ad', key: forestNs }, rel_type: 'member-of' });
    }
    const fsmo = p.fsmo as Record<string, unknown> | undefined;
    if (fsmo) {
      for (const [role, holder] of Object.entries({ pdc: fsmo.pdc, rid: fsmo.rid, infra: fsmo.infra, schema: fsmo.schema, naming: fsmo.naming })) {
        if (!holder) continue;
        const scope = role === 'schema' || role === 'naming' ? 'forest' : 'domain';
        const roleNs = scope === 'forest' ? forestNs : domainNs;
        entities.push({ category: 'fsmo-role', namespace: `${scope}:${roleNs}`, key: role, display: `${role} (${scope})`, attrs: { scope }, watch: ['holder'] });
        const holderName = str(holder)!;
        const dc = dcEntity(holderName.split('.')[0]!, domainNs);
        dc.attrs = { reportedFqdn: holderName };
        entities.push(dc);
        relationships.push({
          from: { category: 'fsmo-role', namespace: `${scope}:${roleNs}`, key: role },
          to: { category: 'domain-controller', namespace: domainNs, key: norm(holderName.split('.')[0]) },
          rel_type: 'held-by', attrs: { holderFqdn: holderName, scope },
        });
      }
    }
  }
  if (cov('dcInventory') === 'complete' && Array.isArray(p.domainControllers)) {
    for (const dc of p.domainControllers as Array<Record<string, unknown>>) {
      const name = str(dc.host) ?? str(dc.name);
      if (!name) continue;
      entities.push({
        category: 'domain-controller', namespace: domainNs, key: norm(name.split('.')[0] ?? name),
        display: name,
        attrs: { host: dc.host, site: dc.site, ip: dc.ip, os: dc.os, gc: dc.gc, rodc: dc.rodc },
      });
      if (dc.site) {
        entities.push({ category: 'site', namespace: forestNs !== 'unknown-forest' ? forestNs : domainNs, key: norm(dc.site), display: str(dc.site) ?? undefined, attrs: {} });
        relationships.push({ from: { category: 'domain-controller', namespace: domainNs, key: norm(name.split('.')[0] ?? name) }, to: { category: 'site', namespace: forestNs !== 'unknown-forest' ? forestNs : domainNs, key: norm(dc.site) }, rel_type: 'in-site' });
      }
    }
  }
  return { coverage, entities, relationships, qualified };
}

function extractDnsV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const coverage: CoverageRec[] = [];
  const entities: EntityRec[] = [];
  const relationships: RelRec[] = [];
  const qualified: string[] = [];
  const serverNs = `dns-server:${norm(ctx.source_device_name) || ctx.source_device_id}`;

  coverage.push({ section: 'roleDetect', status: 'complete', note: p.rolePresent ? 'DNS service present' : 'DNS service absent' });
  if (!p.rolePresent) {
    for (const s of ['zones', 'forwarders', 'scavenging']) coverage.push({ section: s, status: 'not-applicable' });
    return { coverage, entities, relationships, qualified };
  }
  entities.push({
    category: 'dns-server', namespace: 'ad', key: norm(ctx.source_device_name) || String(ctx.source_device_id),
    display: ctx.source_device_name,
    attrs: { moduleAvailable: !!p.moduleAvailable, forwarders: p.forwarders ?? null, scavenging: p.scavenging ?? null },
    watch: ['forwarders', 'scavenging'],
  });
  coverage.push({ section: 'zones', status: 'complete', count: Array.isArray(p.zones) ? p.zones.length : 0, note: 'Get-DnsServerZone full enumeration' });
  for (const z of (p.zones as Array<Record<string, unknown>>) ?? []) {
    const name = str(z.ZoneName);
    if (!name) continue;
    entities.push({
      category: 'dns-zone', namespace: serverNs, key: norm(name),
      display: name,
      attrs: { zoneType: z.ZoneType, dsIntegrated: z.IsDsIntegrated, reverse: z.IsReverseLookupZone, dynamicUpdate: z.DynamicUpdate },
      watch: ['dynamicUpdate', 'zoneType'],
    });
    relationships.push({ from: { category: 'dns-server', namespace: 'ad', key: norm(ctx.source_device_name) || String(ctx.source_device_id) }, to: { category: 'dns-zone', namespace: serverNs, key: norm(name) }, rel_type: 'hosts-zone' });
  }
  coverage.push({ section: 'forwarders', status: 'complete', count: Array.isArray(p.forwarders) ? p.forwarders.length : 0 });
  coverage.push({ section: 'scavenging', status: p.scavenging ? 'complete' : 'unverified', note: p.scavenging ? undefined : 'v1 silent catch — scavenging state unverified' });
  return { coverage, entities, relationships, qualified };
}

function extractDnsV2(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const res = extractDnsV1({ ...ctx, parsed: { ...p, collection: undefined } });
  // Rebuild coverage rows from authoritative section data instead of inference.
  res.coverage = ['roleDetect', 'zones', 'forwarders', 'scavenging'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'zones' ? (p.zones as unknown[] | undefined)?.length : s === 'forwarders' ? (p.forwarders as unknown[] | undefined)?.length : undefined,
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
  }));
  // Entities only ingest from complete sections.
  if (cov('zones') !== 'complete') {
    res.entities = res.entities.filter((e) => e.category !== 'dns-zone');
    res.relationships = res.relationships.filter((r) => r.rel_type !== 'hosts-zone');
  }
  return res;
}

function extractDhcpV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const coverage: CoverageRec[] = [];
  const entities: EntityRec[] = [];
  const relationships: RelRec[] = [];
  const qualified: string[] = [];
  const serverNs = `dhcp-server:${norm(ctx.source_device_name) || ctx.source_device_id}`;

  coverage.push({ section: 'roleDetect', status: 'complete', note: p.rolePresent ? 'DHCPServer service present' : 'DHCPServer service absent' });
  if (!p.rolePresent) {
    for (const s of ['scopes', 'options', 'failover']) coverage.push({ section: s, status: 'not-applicable' });
    return { coverage, entities, relationships, qualified };
  }
  entities.push({
    category: 'dhcp-server', namespace: 'ad', key: norm(ctx.source_device_name) || String(ctx.source_device_id),
    display: ctx.source_device_name,
    attrs: { moduleAvailable: !!p.moduleAvailable },
  });
  coverage.push({ section: 'scopes', status: 'complete', count: Array.isArray(p.scopes) ? p.scopes.length : 0 });
  coverage.push({ section: 'options', status: 'unverified', note: 'v1 did not collect scope options' });
  coverage.push({ section: 'failover', status: 'unverified', note: 'v1 silent catch — failover query failure indistinguishable from empty; absence NOT established' });
  for (const s of (p.scopes as Array<Record<string, unknown>>) ?? []) {
    const id = str(s.scopeId);
    if (!id) continue;
    entities.push({
      category: 'dhcp-scope', namespace: serverNs, key: norm(id),
      display: `${s.name ?? id} (${id})`,
      attrs: { scopeId: s.scopeId, name: s.name, state: s.state, start: s.start, end: s.end, inUse: s.inUse ?? null, free: s.free ?? null, pctUsed: s.pctUsed ?? null },
      watch: ['state', 'start', 'end'],
    });
    relationships.push({ from: { category: 'dhcp-server', namespace: 'ad', key: norm(ctx.source_device_name) || String(ctx.source_device_id) }, to: { category: 'dhcp-scope', namespace: serverNs, key: norm(id) }, rel_type: 'serves-scope' });
  }
  return { coverage, entities, relationships, qualified };
}

function extractDhcpV2(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const res = extractDhcpV1({ ...ctx, parsed: { ...p, collection: undefined } });
  res.coverage = ['roleDetect', 'scopes', 'options', 'failover'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'scopes' ? (p.scopes as unknown[] | undefined)?.length : s === 'failover' ? (p.failover as unknown[] | undefined)?.length : undefined,
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
  }));
  // v2 scopes carry options embedded (scopes[].options) — merge them into
  // scope attrs only when the options section was actually measured;
  // absent options data must never fabricate empty config.
  if (cov('options') === 'complete' || cov('options') === 'partial') {
    const byScope = new Map(((p.scopes as Array<Record<string, unknown>>) ?? []).map((s) => [norm(s.scopeId), s.options]));
    for (const e of res.entities) {
      if (e.category !== 'dhcp-scope') continue;
      const opts = byScope.get(e.key);
      if (opts && typeof opts === 'object') {
        e.attrs.options = opts;
        if (e.watch && !e.watch.includes('options')) e.watch.push('options');
      }
    }
  }
  // v2 failover relationships become entities only when the failover
  // section completed.
  if (cov('failover') === 'complete') {
    const serverKey = norm(ctx.source_device_name) || String(ctx.source_device_id);
    for (const f of (p.failover as Array<Record<string, unknown>>) ?? []) {
      const partner = str(f.PartnerServer);
      if (!partner) continue;
      res.entities.push({ category: 'dhcp-server', namespace: 'ad', key: norm(partner.split('.')[0] ?? partner), display: partner, attrs: { reportedFqdn: partner } });
      res.relationships.push({
        from: { category: 'dhcp-server', namespace: 'ad', key: serverKey },
        to: { category: 'dhcp-server', namespace: 'ad', key: norm(partner.split('.')[0] ?? partner) },
        rel_type: 'failover-partner',
        attrs: { name: f.Name, mode: f.Mode, state: f.State },
      });
    }
  }
  return res;
}

/*
 * v4 — everything v2 measures plus AD authorization state. Client data
 * (reservations/leases) is a separate runbook (diag/dhcp-clients): the wire
 * budget cannot carry both, and client state churns on a different cadence
 * than the scope/authorization census. The scope stat 'inUse' conflates
 * reservations+leases — UI splits come from the clients runbook.
 */
function extractDhcpV4(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const measured = (n: string) => cov(n) === 'complete' || cov(n) === 'partial';
  const res = extractDhcpV2({ ...ctx });
  const serverKey = norm(ctx.source_device_name) || String(ctx.source_device_id);

  res.coverage = ['roleDetect', 'authorization', 'scopes', 'options', 'failover'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'scopes' ? (p.scopes as unknown[] | undefined)?.length
      : s === 'failover' ? (p.failover as unknown[] | undefined)?.length
      : s === 'authorization' ? (p.authorizedServers as unknown[] | undefined)?.length
      : undefined,
    truncated: !!(sections?.[s]?.truncated),
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
  }));

  // Authorization state lands on the server entity; AD-listed servers that
  // are NOT this device become their own entities (orphaned authorizations
  // are visible, never silently dropped).
  if (measured('authorization')) {
    const server = res.entities.find((e) => e.category === 'dhcp-server' && e.key === serverKey);
    if (server) {
      server.attrs.authorizedInAd = p.authorizedInAd ?? null;
      server.attrs.authorizedServers = (p.authorizedServers as Array<Record<string, unknown>> | undefined)?.map((a) => str(a.dns) ?? '').filter(Boolean) ?? [];
      if (server.watch && !server.watch.includes('authorizedInAd')) server.watch.push('authorizedInAd');
    }
    for (const a of (p.authorizedServers as Array<Record<string, unknown>>) ?? []) {
      const dns = str(a.dns);
      if (!dns) continue;
      const short = norm(dns.split('.')[0]);
      if (!short || short === serverKey) continue;
      res.entities.push({ category: 'dhcp-server', namespace: 'ad', key: short, display: dns, attrs: { authorizedInAd: true, observedVia: 'ad-authorization-list', reportedFqdn: dns, reportedIp: str(a.ip) } });
    }
  }
  return res;
}

/*
 * diag/dhcp-clients — per-scope reservations and leases as entities under
 * `dhcp-scope:<id>` namespaces, so scoped absence works per-scope (a deleted
 * reservation or an expired lease surfaces as not_observed). Emits no scope
 * entities — updateProjection replaces attrs wholesale, so a partial stub
 * would clobber the richer record owned by diag/dhcp-scopes. Per-scope
 * reserved/leased counts are derived downstream from the entities (and
 * every client entity carries scopeId), which also keeps the displayed
 * count honest to what was actually enumerated. Absence maps only
 * reservations/leases — never scopes.
 */
function extractDhcpClientsV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const measured = (n: string) => cov(n) === 'complete' || cov(n) === 'partial';
  const res: ExtractionResult = { coverage: [], entities: [], relationships: [], qualified: [] };
  const serverKey = norm(ctx.source_device_name) || String(ctx.source_device_id);
  const serverNs = `dhcp-server:${serverKey}`;
  const scopes = (p.scopes as Array<Record<string, unknown>>) ?? [];
  const scopeNamespaces = scopes.map((s) => `dhcp-scope:${norm(s.scopeId)}`).filter((n) => !n.endsWith(':'));

  res.coverage = ['roleDetect', 'scopes', 'reservations', 'leases'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'scopes' ? scopes.length
      : s === 'reservations' ? scopes.reduce((n, sc) => n + ((sc.reservations as unknown[])?.length ?? 0), 0)
      : s === 'leases' ? scopes.reduce((n, sc) => n + ((sc.leases as unknown[])?.length ?? 0), 0)
      : undefined,
    truncated: !!(sections?.[s]?.truncated),
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
    namespaces: s === 'reservations' || s === 'leases' ? scopeNamespaces : undefined,
  }));
  if (!p.rolePresent || !p.moduleAvailable) return res;

  for (const s of scopes) {
    const scopeKey = norm(s.scopeId);
    if (!scopeKey) continue;
    const scopeNs = `dhcp-scope:${scopeKey}`;
    if (measured('reservations')) {
      for (const r of (s.reservations as Array<Record<string, unknown>>) ?? []) {
        const ip = norm(r.ip);
        if (!ip) continue;
        res.entities.push({
          category: 'dhcp-reservation', namespace: scopeNs, key: ip,
          display: str(r.name) ? `${str(r.name)} (${str(r.ip)})` : String(r.ip ?? ''),
          attrs: { ip: str(r.ip), clientId: str(r.clientId), name: str(r.name), type: str(r.type), scopeId: str(s.scopeId) },
          watch: ['clientId', 'name', 'type'],
        });
        res.relationships.push({ from: { category: 'dhcp-scope', namespace: serverNs, key: scopeKey }, to: { category: 'dhcp-reservation', namespace: scopeNs, key: ip }, rel_type: 'has-reservation' });
      }
    }
    if (measured('leases')) {
      for (const l of (s.leases as Array<Record<string, unknown>>) ?? []) {
        const ip = norm(l.ip);
        if (!ip) continue;
        const state = str(l.state);
        res.entities.push({
          category: 'dhcp-lease', namespace: scopeNs, key: ip,
          display: str(l.hostName) ? `${str(l.hostName)} (${str(l.ip)})` : String(l.ip ?? ''),
          attrs: { ip: str(l.ip), clientId: str(l.clientId), hostName: str(l.hostName), state, expiry: str(l.expiry), isReservation: /reservation/i.test(state ?? ''), scopeId: str(s.scopeId) },
          watch: ['state', 'clientId', 'hostName'],
        });
        res.relationships.push({ from: { category: 'dhcp-scope', namespace: serverNs, key: scopeKey }, to: { category: 'dhcp-lease', namespace: scopeNs, key: ip }, rel_type: 'holds-lease' });
      }
    }
  }
  return res;
}

/**
 * diag/dns-records v1 — per-zone resource-record detail, converging on the
 * proven checkpoint shape (zone, host, type, timestamp, TTL, data) but with
 * normalized RecordData values instead of raw CIM dumps. Records are
 * namespaced per server-zone copy (`dns-zone:<zone>@<server>`) so scoped
 * absence stays correct and inter-server zone divergence remains visible.
 */
function extractDnsRecordsV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const measured = (n: string) => cov(n) === 'complete' || cov(n) === 'partial';
  const res: ExtractionResult = { coverage: [], entities: [], relationships: [], qualified: [] };
  const serverKey = norm(ctx.source_device_name) || String(ctx.source_device_id);
  const serverNs = `dns-server:${serverKey}`;
  const zones = (p.zones as Array<Record<string, unknown>>) ?? [];
  // Truncated zones stay out of the absence scope — a capped record dump
  // cannot prove which records are gone.
  const recordNamespaces = zones.filter((z) => !z.truncated).map((z) => `dns-zone:${norm(z.name)}@${serverKey}`).filter((n) => !n.includes(':@'));

  res.coverage = ['roleDetect', 'records'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'records' ? zones.reduce((n, z) => n + ((z.records as unknown[])?.length ?? 0), 0) : undefined,
    truncated: !!(sections?.[s]?.truncated),
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
    namespaces: s === 'records' ? recordNamespaces : undefined,
  }));
  if (!p.rolePresent || !p.moduleAvailable) return res;
  if (!measured('records')) return res;

  for (const z of zones) {
    const zoneName = str(z.name);
    if (!zoneName) continue;
    const recNs = `dns-zone:${norm(zoneName)}@${serverKey}`;
    const zoneRef = { category: 'dns-zone' as const, namespace: serverNs, key: norm(zoneName) };
    for (const r of (z.records as Array<Record<string, unknown>>) ?? []) {
      const host = str(r.host) ?? '@';
      const type = str(r.type) ?? 'unknown';
      const data = str(r.data);
      const key = `${norm(host)}|${norm(type)}|${norm(data) || 'none'}`;
      res.entities.push({
        category: 'dns-record', namespace: recNs, key,
        display: `${host} ${type}${data ? ` → ${data}` : ''}`,
        attrs: {
          zone: zoneName, host, type, data,
          ttl: str(r.ttl), timestamp: str(r.ts),
          isStatic: r.ts == null,
        },
        watch: ['data', 'timestamp'],
      });
      res.relationships.push({ from: zoneRef, to: { category: 'dns-record', namespace: recNs, key }, rel_type: 'contains-record' });
    }
    // Zone aging rides as a relationship observation on the zone entity —
    // a dns-zone stub would clobber census attrs (projection replaces attrs).
    if (z.aging != null) {
      res.relationships.push({
        from: { category: 'dns-server', namespace: 'ad', key: serverKey }, to: zoneRef, rel_type: 'zone-aging',
        attrs: { enabled: !!z.aging },
      });
    }
  }
  return res;
}

function extractGpoV1(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const coverage: CoverageRec[] = [];
  const entities: EntityRec[] = [];
  const relationships: RelRec[] = [];
  const qualified: string[] = [];
  const domainNs = 'unknown-domain'; // v1 collected no domain identity

  coverage.push({ section: 'domainCheck', status: 'complete', note: p.domainJoined ? 'domain-joined' : 'not domain-joined' });
  if (!p.domainJoined) {
    coverage.push({ section: 'inventory', status: 'not-applicable' });
    coverage.push({ section: 'links', status: 'not-applicable' });
    return { coverage, entities, relationships, qualified };
  }
  coverage.push({ section: 'inventory', status: 'complete', count: (p.total as number) ?? (p.gpos as unknown[])?.length ?? 0 });
  coverage.push({ section: 'links', status: 'unverified', note: 'v1 did not collect GPO links — configured scope unknown' });
  for (const g of (p.gpos as Array<Record<string, unknown>>) ?? []) {
    const guid = norm(g.Id);
    if (!guid) continue;
    entities.push({
      category: 'gpo', namespace: `domain:${domainNs}`, key: guid,
      display: str(g.DisplayName) ?? undefined,
      attrs: { displayName: g.DisplayName, gpoStatus: g.GpoStatus, statusLabel: gpoStatusLabel(g.GpoStatus), created: g.CreationTime, modified: g.ModificationTime },
      watch: ['gpoStatus'],
    });
  }
  return { coverage, entities, relationships, qualified };
}

function extractGpoV2(ctx: ExtractCtx): ExtractionResult {
  const p = ctx.parsed;
  const sections = (p.collection as Record<string, unknown> | undefined)?.sections as Record<string, Record<string, unknown>> | undefined;
  const cov = (n: string): CoverageStatus => (sections?.[n]?.status as CoverageStatus) ?? 'unverified';
  const res = extractGpoV1({ ...ctx, parsed: { ...p, collection: undefined } });
  res.coverage = ['domainCheck', 'inventory', 'links'].map((s) => ({
    section: s,
    status: cov(s),
    count: s === 'inventory' ? ((p.total as number) ?? undefined) : (sections?.[s]?.count as number | undefined),
    truncated: !!(sections?.[s]?.truncated),
    note: (sections?.[s]?.note as string) ?? (sections?.[s]?.detail as string) ?? (sections?.[s]?.error as string) ?? undefined,
  }));
  if (cov('links') === 'complete' && p.links && typeof p.links === 'object') {
    // Derive the domain namespace from SOM roots — link paths look like
    // 'domain.tld/OU/...' so the most common root IS the domain DNS root.
    // Resolves entities into the real domain namespace without an AD call;
    // unlinked-only sets keep the 'unknown' placeholder (merged later by
    // supersedeUnknownTwin once a resolved namespace arrives).
    const roots = new Map<string, number>();
    for (const links of Object.values(p.links as Record<string, unknown[]>)) {
      for (const l of links as Array<Record<string, unknown>>) {
        const root = norm(String(l.som ?? '').split('/')[0]);
        if (root) roots.set(root, (roots.get(root) ?? 0) + 1);
      }
    }
    const domainNs = [...roots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    if (domainNs !== 'unknown') {
      // Re-home entities the v1 extractor filed under the placeholder.
      for (const e of res.entities) {
        if (e.namespace === 'domain:unknown-domain' || e.namespace === 'domain:unknown') e.namespace = `domain:${domainNs}`;
      }
      for (const r of res.relationships) {
        if (r.from.namespace === 'domain:unknown-domain' || r.from.namespace === 'domain:unknown') r.from.namespace = `domain:${domainNs}`;
        if (r.to.namespace === 'domain:unknown-domain' || r.to.namespace === 'domain:unknown') r.to.namespace = `domain:${domainNs}`;
      }
    }
    for (const [guid, links] of Object.entries(p.links as Record<string, unknown[]>)) {
      for (const l of links as Array<Record<string, unknown>>) {
        const som = str(l.som);
        if (!som) continue;
        res.entities.push({ category: 'container', namespace: `domain:${domainNs}`, key: norm(som), display: l.somName ? `${l.somName} (${som})` : som, attrs: { somPath: som } });
        res.relationships.push({
          from: { category: 'gpo', namespace: `domain:${domainNs}`, key: norm(guid) },
          to: { category: 'container', namespace: `domain:${domainNs}`, key: norm(som) },
          rel_type: 'links-to',
          attrs: { enabled: l.enabled, noOverride: l.noOverride },
        });
      }
    }
  }
  return res;
}

/**
 * Microsoft.GroupPolicy.GpoStatus ordinals as serialized by ConvertTo-Json:
 * 0 AllSettingsDisabled · 1 UserSettingsDisabled · 2 ComputerSettingsDisabled
 * · 3 AllSettingsEnabled. NOT the AD `flags` attribute (where 0 = enabled) —
 * extractor v1–v3 decoded it as flags, inverting every enabled/disabled
 * label. Verified 2026-09-27 on DC04: [int]'AllSettingsEnabled' = 3 and
 * GPMC status matches this table. Named values are accepted as well.
 */
export const GPO_STATUS = { disabled: 0, userOff: 1, computerOff: 2, enabled: 3 } as const;
export function gpoStatusCode(v: unknown): number | null {
  if (typeof v === 'string' && !/^\d+$/.test(v)) {
    const named: Record<string, number> = { allsettingsdisabled: 0, usersettingsdisabled: 1, computersettingsdisabled: 2, allsettingsenabled: 3 };
    return named[v.toLowerCase()] ?? null;
  }
  const n = Number(v);
  return v === null || v === undefined || !Number.isInteger(n) || n < 0 || n > 3 ? null : n;
}
export function gpoStatusLabel(v: unknown): string {
  switch (gpoStatusCode(v)) {
    case 0: return 'All settings disabled';
    case 1: return 'User settings disabled';
    case 2: return 'Computer settings disabled';
    case 3: return 'All settings enabled';
    default: return 'Unknown';
  }
}

/** Finding rule versions — v2 GPO rules use the corrected GpoStatus decoding;
    v1 annotations from those rules were raised on the inverted condition and
    are retracted by storage MIGRATION_16. */
export const RULE_VERSION: Record<string, number> = { 'default-gpo-disabled': 2, 'firewall-gpo-enabled': 2, 'gpo-enabled-unlinked': 2 };

/** Derived fields are re-derived on read so evidence ingested by an older
    extractor never surfaces a stale interpretation (raw values untouched). */
export function correctAttrs(category: unknown, attrs: Record<string, unknown>): Record<string, unknown> {
  if (category === 'gpo' && attrs && 'gpoStatus' in attrs) return { ...attrs, statusLabel: gpoStatusLabel(attrs.gpoStatus) };
  return attrs;
}

/* ── Ingestion ──────────────────────────────────────────────────────────── */

interface OpRow {
  id: string; plan_id: string; target_type: string; target_id: number;
  status: string; result_json: string | null; runbook_id: string | null; runbook_version: number | null;
  created_at: number; updated_at: number;
}

export class InfraService {
  constructor(private readonly store: EntityStore) {}

  private get db() {
    return this.store.database;
  }

  /** Drain pending ingestion jobs (called from the serve sweep / backfill). */
  processIngestionJobs(limit = 10): { processed: number; errors: number } {
    const jobs = this.db
      .prepare("SELECT * FROM ingestion_jobs WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    let processed = 0;
    let errors = 0;
    for (const job of jobs) {
      try {
        this.ingestReceipt(String(job.operation_id), job.target_seq === null ? null : Number(job.target_seq));
        this.db.prepare("UPDATE ingestion_jobs SET status = 'done', done_at = ?, attempts = attempts + 1 WHERE id = ?").run(Date.now(), String(job.id));
        processed++;
      } catch (error) {
        errors++;
        this.db
          .prepare("UPDATE ingestion_jobs SET status = 'error', error = ?, attempts = attempts + 1 WHERE id = ?")
          .run(error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400), String(job.id));
      }
    }
    return { processed, errors };
  }

  /**
   * Extract + persist one receipt's facts. Receipt is read from the immutable
   * operations/operation_targets rows; extraction runs outside their write
   * path. Safe to re-run: observations dedupe on coverage identity.
   */
  ingestReceipt(operationId: string, targetSeq: number | null): { entities: number; observations: number; qualified: string[] } {
    const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as OpRow | undefined;
    if (!op) throw new Error(`operation ${operationId} not found`);
    if (!op.runbook_id) return { entities: 0, observations: 0, qualified: ['no runbook — nothing to extract'] };

    let resultJson = op.result_json;
    let deviceId = Number(op.target_id);
    if (targetSeq !== null) {
      const t = this.db.prepare('SELECT device_id, result_json FROM operation_targets WHERE seq = ?').get(targetSeq) as { device_id: number; result_json: string | null } | undefined;
      if (!t) throw new Error(`target seq ${targetSeq} not found`);
      resultJson = t.result_json;
      deviceId = t.device_id;
    }
    if (!resultJson) throw new Error('no result payload on receipt');
    const receipt = JSON.parse(resultJson) as { parsed?: Record<string, unknown> | null; exitCode?: number | null };
    const parsed = receipt.parsed;
    if (!parsed) return { entities: 0, observations: 0, qualified: ['no parsed RBJSON — raw receipt retained only'] };

    const device = this.store.getDeviceById(deviceId);
    const ctx: ExtractCtx = {
      connection_id: this.store.connId ?? null,
      org_id: Number(device?.org_id ?? 0),
      operation_id: operationId,
      target_seq: targetSeq,
      runbook_id: op.runbook_id,
      runbook_version: Number(op.runbook_version ?? 1),
      source_device_id: deviceId,
      source_device_name: String(device?.dns_name ?? device?.system_name ?? device?.display_name ?? deviceId),
      collected_at: Number(op.updated_at ?? op.created_at ?? Date.now()),
      parsed,
      opStatus: String(op.status),
      exitCode: receipt.exitCode ?? null,
    };
    const extractor = EXTRACTORS[op.runbook_id]?.[ctx.runbook_version];
    if (!extractor) return { entities: 0, observations: 0, qualified: [`no extractor for ${op.runbook_id} v${ctx.runbook_version}`] };
    const ex = extractor(ctx);
    return this.persistExtraction(ctx, ex);
  }

  private persistExtraction(ctx: ExtractCtx, ex: ExtractionResult): { entities: number; observations: number; qualified: string[] } {
    const now = Date.now();
    let obsCount = 0;
    const entityIds = new Map<string, string>();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1. Coverage rows — one per declared section.
      const coverageIds = new Map<string, string>();
      for (const c of ex.coverage) {
        const cid = randomUUID();
        coverageIds.set(c.section, cid);
        this.db
          .prepare(
            `INSERT INTO collection_coverage (id, connection_id, org_id, operation_id, target_seq, runbook_id, runbook_version, source_device_id, namespace, section, status, completeness, enumerated_count, truncated, note, collected_at, ingested_at, extractor_version)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(cid, ctx.connection_id, ctx.org_id, ctx.operation_id, ctx.target_seq, ctx.runbook_id, ctx.runbook_version, ctx.source_device_id, null, c.section, c.status, c.completeness ?? null, c.count ?? null, c.truncated ? 1 : 0, c.note ?? null, ctx.collected_at, now, EXTRACTOR_VERSION);
      }
      const primaryCoverage = coverageIds.values().next().value as string | undefined;
      // 2. Entities: upsert identity + append immutable observation + projection.
      for (const e of ex.entities) {
        e.attrs = normalizeAttr(e.attrs) as Record<string, unknown>;
        const id = this.upsertEntity(ctx, e, now);
        entityIds.set(`${e.category}|${e.namespace}|${e.key}`, id);
        const coverageId = coverageIds.get(this.sectionFor(e.category)) ?? primaryCoverage;
        if (!coverageId) continue;
        this.db
          .prepare(
            `INSERT INTO entity_observations (id, entity_id, coverage_id, attrs_json, field_presence_json, observed_at, collected_at, ingested_at, extractor_version, operation_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(randomUUID(), id, coverageId, JSON.stringify(e.attrs), JSON.stringify(Object.keys(e.attrs)), ctx.collected_at, ctx.collected_at, now, EXTRACTOR_VERSION, ctx.operation_id);
        obsCount++;
        this.updateProjection(id, e, coverageId, ctx, now);
      }
      // 3. Relationships (resolved through the entity map).
      for (const r of ex.relationships) {
        const fromId = entityIds.get(`${r.from.category}|${r.from.namespace}|${r.from.key}`) ?? this.lookupEntityId(ctx, r.from.category, r.from.namespace, r.from.key);
        const toId = entityIds.get(`${r.to.category}|${r.to.namespace}|${r.to.key}`) ?? this.lookupEntityId(ctx, r.to.category, r.to.namespace, r.to.key);
        if (!fromId || !toId) continue;
        this.db
          .prepare(
            `INSERT INTO relationship_observations (id, from_entity_id, to_entity_id, rel_type, attrs_json, coverage_id, observed_at, collected_at, ingested_at, operation_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(randomUUID(), fromId, toId, r.rel_type, r.attrs ? JSON.stringify(r.attrs) : null, primaryCoverage ?? null, ctx.collected_at, ctx.collected_at, now, ctx.operation_id);
      }
      // 4. Scoped absence evaluation: only COMPLETE enumerations may mark
      //    not_observed, and only inside their own source+namespace+section.
      for (const c of ex.coverage) {
        if (c.status !== 'complete') continue;
        const cat = this.categoryForSection(ctx.runbook_id, c.section);
        if (!cat) continue;
        this.applyAbsence(ctx, cat, c, ex.entities, now);
      }
      // 5. Deterministic findings.
      this.evaluateFindings(ctx, ex, now);
      // 6. Qualified ingestion note → annotation on the operation.
      for (const q of ex.qualified) {
        this.db
          .prepare(
            `INSERT INTO infra_annotations (id, connection_id, org_id, operation_id, kind, rule_id, rule_version, title, detail, status, author, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(randomUUID(), ctx.connection_id, ctx.org_id, ctx.operation_id, 'interpretation', 'qualified-ingest', EXTRACTOR_VERSION, 'Qualified ingestion', q, 'open', 'system', now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { entities: ex.entities.length, observations: obsCount, qualified: ex.qualified };
  }

  private sectionFor(category: InfraCategory): string {
    switch (category) {
      case 'domain': case 'forest': case 'fsmo-role': return 'directory';
      case 'domain-controller': return 'dcInventory';
      case 'site': return 'dcInventory';
      case 'dns-server': return 'roleDetect';
      case 'dns-zone': return 'zones';
      case 'dns-record': return 'records';
      case 'dhcp-server': return 'roleDetect';
      case 'dhcp-scope': return 'scopes';
      case 'dhcp-reservation': return 'reservations';
      case 'dhcp-lease': return 'leases';
      case 'gpo': return 'inventory';
      case 'container': return 'links';
    }
  }

  private categoryForSection(runbookId: string, section: string): InfraCategory | null {
    const map: Record<string, Record<string, InfraCategory>> = {
      'diag/dns-server': { zones: 'dns-zone' },
      'diag/dhcp-scopes': { scopes: 'dhcp-scope' },
      'diag/dhcp-clients': { reservations: 'dhcp-reservation', leases: 'dhcp-lease' },
      'diag/dns-records': { records: 'dns-record' },
      'diag/gpo-inventory': { inventory: 'gpo' },
      'diag/ad-health': { dcInventory: 'domain-controller' },
    };
    return map[runbookId]?.[section] ?? null;
  }

  private upsertEntity(ctx: ExtractCtx, e: EntityRec, now: number): string {
    const found = this.db
      .prepare('SELECT id, aliases_json FROM infra_entities WHERE connection_id IS ? AND org_id = ? AND category = ? AND namespace = ? AND stable_key = ?')
      .get(ctx.connection_id, ctx.org_id, e.category, e.namespace, e.key) as { id: string; aliases_json: string | null } | undefined;
    const id = found
      ? (this.db.prepare('UPDATE infra_entities SET last_seen_at = ?, display_name = COALESCE(?, display_name) WHERE id = ?').run(now, e.display ?? null, found.id), found.id)
      : this.insertEntity(ctx, e, now);
    // Namespace resolution upgrade: an extractor that could not resolve the
    // real domain/forest name historically filed entities under
    // 'domain:unknown'. Once a later collection resolves the true namespace,
    // the placeholder twin is the SAME entity — supersede it (never deleted;
    // its immutable observations stay queryable as history).
    if (!isUnresolvedNamespace(e.namespace)) {
      this.supersedeUnknownTwin(ctx, e, id, now);
    }
    return id;
  }

  private insertEntity(ctx: ExtractCtx, e: EntityRec, now: number): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, aliases_json, first_seen_at, last_seen_at, source_device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, ctx.connection_id, ctx.org_id, e.namespace, e.category, e.key, e.display ?? null, e.aliases ? JSON.stringify(e.aliases) : null, now, now, ctx.source_device_id);
    return id;
  }

  private supersedeUnknownTwin(ctx: ExtractCtx, e: EntityRec, resolvedId: string, now: number): void {
    for (const twin of this.findUnresolvedTwins(ctx.connection_id, ctx.org_id, e.category, e.key, ctx.source_device_id, resolvedId)) {
      const cur = this.db.prepare('SELECT status FROM infra_current WHERE entity_id = ?').get(twin.id) as { status: string } | undefined;
      if (!cur || cur.status === 'superseded') continue;
      this.db
        .prepare(
          `UPDATE infra_current SET status = 'superseded', conflict_json = ?, updated_at = ? WHERE entity_id = ?`,
        )
        .run(JSON.stringify({ supersededBy: resolvedId, reason: 'namespace-resolved', namespace: e.namespace }), now, twin.id);
    }
  }

  /**
   * Twins = same org/category/source under an unresolved namespace, whose
   * stable_key matches the resolved entity exactly OR shares its first DNS
   * label (collectors disagree on `host` vs `host.domain` key shapes).
   */
  private findUnresolvedTwins(connectionId: string | null, orgId: number, category: string, key: string, sourceDeviceId: number | null, excludeId: string): { id: string }[] {
    const short = String(key).split('.')[0] ?? key;
    return this.db
      .prepare(
        `SELECT e.id FROM infra_entities e
         WHERE e.connection_id IS ? AND e.org_id = ? AND e.category = ?
           AND e.source_device_id IS ? AND e.id != ?
           AND (e.namespace LIKE '%:unknown%' OR e.namespace IN ('unknown','unknown-domain','unknown-forest'))
           AND (e.stable_key = ? OR substr(e.stable_key, 1, instr(e.stable_key || '.', '.') - 1) = ?)`,
      )
      .all(connectionId, orgId, category, sourceDeviceId ?? null, excludeId, key, short) as { id: string }[];
  }

  /**
   * Repair pass: apply the namespace-resolution rule to entities ingested
   * before the merge existed (or from receipts collected under extractors
   * that could not resolve the domain). For every entity under a resolved
   * namespace, same category+key+source twins under '*:unknown' are marked
   * superseded — observations stay immutable; only the projection pointer
   * moves. Idempotent.
   */
  repairNamespaceSupersession(): { superseded: number } {
    const resolved = this.db
      .prepare(
        `SELECT id, connection_id, org_id, category, stable_key, namespace, source_device_id FROM infra_entities
         WHERE namespace NOT LIKE '%:unknown%' AND namespace NOT IN ('unknown','unknown-domain','unknown-forest')`,
      )
      .all() as Array<{ id: string; connection_id: string | null; org_id: number; category: string; stable_key: string; namespace: string; source_device_id: number | null }>;
    let superseded = 0;
    const now = Date.now();
    for (const r of resolved) {
      for (const twin of this.findUnresolvedTwins(r.connection_id, r.org_id, r.category, r.stable_key, r.source_device_id, r.id)) {
        const cur = this.db.prepare('SELECT status FROM infra_current WHERE entity_id = ?').get(twin.id) as { status: string } | undefined;
        if (!cur || cur.status === 'superseded') continue;
        this.db
          .prepare(`UPDATE infra_current SET status = 'superseded', conflict_json = ?, updated_at = ? WHERE entity_id = ?`)
          .run(JSON.stringify({ supersededBy: r.id, reason: 'namespace-resolved', namespace: r.namespace }), now, twin.id);
        superseded++;
      }
    }
    return { superseded };
  }

  /**
   * Point-in-time projection: each entity's latest observation collected
   * at-or-before `asOfMs`. "As of T" means *evidence collected by T* — not
   * provably what was true then; coverage records bound what was measured.
   * Entities first observed after T are excluded (we didn't know them yet).
   */
  listEntitiesAsOf(orgId: number, asOfMs: number, opts: { category?: string | undefined; namespace?: string | undefined; q?: string | undefined; limit?: number | undefined; cursor?: number | undefined; linkCounts?: boolean | undefined }): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const cond: string[] = ['e.connection_id IS ?', 'e.org_id = ?', 'o.collected_at <= ?'];
    const args: unknown[] = [conn, orgId, asOfMs];
    if (opts.category) { cond.push('e.category = ?'); args.push(opts.category); }
    if (opts.namespace) { cond.push('e.namespace = ?'); args.push(opts.namespace); }
    if (opts.q) { cond.push('(e.display_name LIKE ? OR e.stable_key LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.cursor) { cond.push('e.rowid > ?'); args.push(opts.cursor); }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const lc = opts.linkCounts ? this.linkCountSubquery(asOfMs) : null;
    const rows = this.db
      .prepare(
        `SELECT e.rowid AS _cur, e.id, e.category, e.namespace, e.stable_key, e.display_name, e.first_seen_at, e.source_device_id,
                o.attrs_json, o.observed_at, o.collected_at, o.operation_id${lc ? ', lc.link_count' : ''}
         FROM infra_entities e JOIN entity_observations o ON o.entity_id = e.id
         ${lc ? `LEFT JOIN (${lc.sql}) lc ON lc.from_entity_id = e.id` : ''}
         WHERE ${cond.join(' AND ')}
           AND o.collected_at = (SELECT MAX(collected_at) FROM entity_observations WHERE entity_id = e.id AND collected_at <= ?)
         ORDER BY e.rowid LIMIT ?`,
      )
      .all(...(lc?.args as never[] ?? []), ...(args as never[]), asOfMs, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    const horizon = this.db
      .prepare('SELECT MIN(collected_at) AS first FROM collection_coverage WHERE connection_id IS ? AND org_id = ?')
      .get(conn, orgId) as { first: number | null };
    return {
      entities: page.map((r) => ({
        id: r.id, category: r.category, namespace: r.namespace, stable_key: r.stable_key,
        display_name: r.display_name, first_seen_at: r.first_seen_at, source_device_id: r.source_device_id,
        attrs: correctAttrs(r.category, JSON.parse(String(r.attrs_json))), status: 'observed', conflicting: 0,
        observed_at: r.observed_at, collected_at: r.collected_at, last_operation_id: r.operation_id,
        link_count: r.link_count ?? null,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!._cur : null,
      asOf: asOfMs,
      evidenceHorizon: horizon.first ?? null,
      disclosure: 'As-of view replays the latest evidence collected at-or-before the selected time. "Not present" here means not yet observed — first-ever collection bounds how far back any claim can reach.',
    };
  }

  private lookupEntityId(ctx: ExtractCtx, category: InfraCategory, namespace: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM infra_entities WHERE connection_id IS ? AND org_id = ? AND category = ? AND namespace = ? AND stable_key = ?')
      .get(ctx.connection_id, ctx.org_id, category, namespace, key) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Current projection: latest eligible observation wins — but a late-
   * arriving OLDER observation never regresses current state; it becomes a
   * conflict record instead (plan §6 precedence rules).
   */
  private updateProjection(entityId: string, e: EntityRec, coverageId: string, ctx: ExtractCtx, now: number): void {
    const cur = this.db.prepare('SELECT * FROM infra_current WHERE entity_id = ?').get(entityId) as Record<string, unknown> | undefined;
    if (!cur) {
      this.db
        .prepare(
          `INSERT INTO infra_current (entity_id, attrs_json, last_coverage_id, last_operation_id, observed_at, collected_at, status, updated_at)
           VALUES (?,?,?,?,?,?, 'observed', ?)`,
        )
        .run(entityId, JSON.stringify(e.attrs), coverageId, ctx.operation_id, ctx.collected_at, ctx.collected_at, now);
      return;
    }
    const curCollected = Number(cur.collected_at ?? 0);
    const curAttrs = JSON.parse(String(cur.attrs_json)) as Record<string, unknown>;
    if (ctx.collected_at >= curCollected) {
      // Newer or same-age measurement → becomes current; check watched fields
      // for conflict against the previous current only when same age and the
      // source differs (two DCs disagreeing is a finding, not an update race).
      const diffs = this.watchedDiffs(e, curAttrs);
      const sameAgeDifferentSource = ctx.collected_at === curCollected && Number(cur.last_operation_id ? 0 : 0) === 0 && String(cur.last_operation_id) !== ctx.operation_id;
      const conflicting = diffs.length > 0 && sameAgeDifferentSource;
      this.db
        .prepare(
          `UPDATE infra_current SET attrs_json = ?, last_coverage_id = ?, last_operation_id = ?, observed_at = ?, collected_at = ?, status = 'observed', conflicting = ?, conflict_json = ?, updated_at = ? WHERE entity_id = ?`,
        )
        .run(JSON.stringify(e.attrs), coverageId, ctx.operation_id, ctx.collected_at, ctx.collected_at, conflicting ? 1 : 0, conflicting ? JSON.stringify({ diffs, previous: curAttrs, previousOperation: cur.last_operation_id }) : null, now, entityId);
    } else {
      // Older measurement arriving late → record conflict, keep current.
      const diffs = this.watchedDiffs(e, curAttrs);
      if (diffs.length > 0) {
        this.db
          .prepare('UPDATE infra_current SET conflicting = 1, conflict_json = ?, updated_at = ? WHERE entity_id = ?')
          .run(JSON.stringify({ lateArrival: true, diffs, staleObservation: e.attrs, staleOperation: ctx.operation_id }), now, entityId);
      }
    }
  }

  private watchedDiffs(e: EntityRec, curAttrs: Record<string, unknown>): string[] {
    const fields = e.watch ?? [];
    return fields.filter((f) => JSON.stringify(e.attrs[f] ?? null) !== JSON.stringify(curAttrs[f] ?? null));
  }

  /** Scoped absence: complete enumeration of category in this namespace/source. */
  private applyAbsence(ctx: ExtractCtx, category: InfraCategory, coverage: CoverageRec, entities: EntityRec[], now: number): void {
    // Namespace per extractor: server-scoped categories key off the source
    // device namespace; domain-scoped off the domain namespace. An explicit
    // coverage.namespaces set wins — it covers namespaces that enumerated
    // empty this run (their prior entities must still be evaluated).
    const namespaces = new Set(
      coverage.namespaces?.length ? coverage.namespaces : entities.filter((e) => e.category === category).map((e) => e.namespace),
    );
    if (namespaces.size === 0) {
      // Complete EMPTY enumeration — every entity of this category previously
      // observed under THIS source's namespaces becomes not_observed.
      const prior = this.db
        .prepare(
          `SELECT e.id, e.namespace FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
           WHERE e.connection_id IS ? AND e.org_id = ? AND e.category = ? AND c.status = 'observed' AND e.source_device_id = ?`,
        )
        .all(ctx.connection_id, ctx.org_id, category, ctx.source_device_id) as Array<{ id: string; namespace: string }>;
      for (const row of prior) {
        this.db.prepare("UPDATE infra_current SET status = 'not_observed', updated_at = ? WHERE entity_id = ?").run(now, row.id);
      }
      return;
    }
    for (const ns of namespaces) {
      const seen = new Set(entities.filter((e) => e.category === category && e.namespace === ns).map((e) => e.key));
      const prior = this.db
        .prepare(
          `SELECT e.id, e.stable_key FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
           WHERE e.connection_id IS ? AND e.org_id = ? AND e.category = ? AND e.namespace = ? AND c.status = 'observed'`,
        )
        .all(ctx.connection_id, ctx.org_id, category, ns) as Array<{ id: string; stable_key: string }>;
      for (const row of prior) {
        if (!seen.has(row.stable_key)) {
          this.db.prepare("UPDATE infra_current SET status = 'not_observed', updated_at = ? WHERE entity_id = ?").run(now, row.id);
        }
      }
    }
  }

  /** Deterministic finding rules (plan §12) — evidence-backed, no scores. */
  private evaluateFindings(ctx: ExtractCtx, ex: ExtractionResult, now: number): void {
    const add = (ruleId: string, title: string, detail: string, entityKey?: { category: InfraCategory; namespace: string; key: string }) => {
      const entityId = entityKey ? this.lookupEntityId(ctx, entityKey.category, entityKey.namespace, entityKey.key) : null;
      const existing = this.db
        .prepare("SELECT id FROM infra_annotations WHERE rule_id = ? AND org_id = ? AND entity_id IS ? AND status = 'open'")
        .get(ruleId, ctx.org_id, entityId) as { id: string } | undefined;
      if (existing) return;
      this.db
        .prepare(
          `INSERT INTO infra_annotations (id, connection_id, org_id, entity_id, operation_id, kind, rule_id, rule_version, title, detail, evidence_json, status, author, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(randomUUID(), ctx.connection_id, ctx.org_id, entityId, ctx.operation_id, 'finding', ruleId, RULE_VERSION[ruleId] ?? 1, title, detail, JSON.stringify({ operationId: ctx.operation_id, sourceDeviceId: ctx.source_device_id }), 'open', 'system', now);
    };

    for (const e of ex.entities) {
      if (e.category === 'gpo') {
        const name = String(e.attrs.displayName ?? '');
        const gs = gpoStatusCode(e.attrs.gpoStatus);
        if (gs === GPO_STATUS.disabled && /default domain (policy|controllers policy)/i.test(name)) {
          add('default-gpo-disabled', `Default-named GPO "${name}" reports all settings disabled`, 'Verify effective policy via RSoP/gpresult before concluding baseline settings are absent. Disabled sections on a default-named GPO warrant review, not assumption.', { category: 'gpo', namespace: e.namespace, key: e.key });
        }
        if (gs === GPO_STATUS.enabled && /(disable|turn off).*firewall|firewall.*(off|disable)/i.test(name)) {
          add('firewall-gpo-enabled', `Enabled GPO "${name}" has a firewall-disabling name`, 'Name suggests firewall disablement; inspect actual configured settings, links, and effective endpoint firewall state before acting.', { category: 'gpo', namespace: e.namespace, key: e.key });
        }
        // Enabled but linked nowhere — dead policy. Only when the links
        // enumeration completed (unverified links must not imply absence).
        const linksComplete = ex.coverage.some((c) => c.section === 'links' && c.status === 'complete');
        const hasLink = ex.relationships.some((r) => r.rel_type === 'links-to' && r.from.category === 'gpo' && r.from.key === e.key && r.from.namespace === e.namespace);
        if (linksComplete && !hasLink && gs !== null && gs !== GPO_STATUS.disabled) {
          add('gpo-enabled-unlinked', `GPO "${name}" is enabled but linked to no container`, 'Complete links enumeration shows no SOM — the policy applies nowhere. Confirm intent before concluding it is dead weight; it may be staged or referenced by security filtering.', { category: 'gpo', namespace: e.namespace, key: e.key });
        }
      }
      if (e.category === 'dns-zone') {
        const dyn = String(e.attrs.dynamicUpdate ?? '');
        if (/nonsecure/i.test(dyn)) {
          add('dns-zone-nonsecure-dynupdate', `Zone "${e.display}" allows nonsecure dynamic updates`, `DynamicUpdate=${dyn} reported. Confirm zone type/storage and operational dependencies before changing.`, { category: 'dns-zone', namespace: e.namespace, key: e.key });
        }
      }
      if (e.category === 'dhcp-scope' && String(e.attrs.state) === 'Active') {
        const failoverComplete = ex.coverage.some((c) => c.section === 'failover' && c.status === 'complete');
        const anyFailoverRel = ex.relationships.some((r) => r.rel_type === 'failover-partner');
        if (failoverComplete && !anyFailoverRel) {
          add('dhcp-scope-no-failover', `Active DHCP scope "${e.display}" has no Windows failover relationship`, 'Complete failover enumeration returned none. Other redundancy (split scopes, second server) may still exist — verify design before concluding exposure.', { category: 'dhcp-scope', namespace: e.namespace, key: e.key });
        }
      }
      if (e.category === 'dhcp-server') {
        // Server with Active scopes but not authorized in AD — the exact
        // mislead a scope "Active" label alone produces: it cannot serve.
        if (e.attrs.authorizedInAd === false) {
          const activeScopes = ex.entities.filter((x) => x.category === 'dhcp-scope' && String(x.attrs.state) === 'Active').length;
          if (activeScopes > 0) {
            add('dhcp-server-unauthorized', `DHCP server "${e.display}" is not AD-authorized but has ${activeScopes} Active scope(s)`, 'An unauthorized DHCP server cannot issue leases — scope state and statistics reflect configuration, not live service. Authorize the server (DHCP console → Action → Authorize) or stand the scopes down.', { category: 'dhcp-server', namespace: e.namespace, key: e.key });
          }
        }
        // AD authorization entry with no matching observed device — stale
        // record from a decommissioned server, or a device not yet inventoried.
        if (e.attrs.observedVia === 'ad-authorization-list') {
          add('dhcp-authorized-orphan', `AD lists "${e.display}" as an authorized DHCP server`, 'Authorization record exists in AD but no device with this name has reported DHCP role data. Stale records are housekeeping debt; a live unrecognized one is a rogue-DHCP question.', { category: 'dhcp-server', namespace: e.namespace, key: e.key });
        }
      }
      if (e.category === 'fsmo-role') {
        const cur = this.db.prepare('SELECT conflicting FROM infra_current c JOIN infra_entities e ON e.id = c.entity_id WHERE e.category = ? AND e.namespace = ? AND e.stable_key = ?').get('fsmo-role', e.namespace, e.key) as { conflicting: number } | undefined;
        if (cur?.conflicting) {
          add('fsmo-conflict', `Conflicting reports for FSMO role "${e.display}"`, 'Two sources reported different role holders within the same window — inspect both receipts.', { category: 'fsmo-role', namespace: e.namespace, key: e.key });
        }
      }
      if (e.category === 'dns-record' && e.attrs.isStatic === true && String(e.attrs.type) === 'A') {
        // Static A record whose target sits inside a known DHCP pool — the
        // record outlives lease churn and points at whatever holds the IP.
        const ipN = ipToInt(str(e.attrs.data));
        if (ipN !== null) {
          const scopes = this.db
            .prepare(
              `SELECT c.attrs_json FROM infra_entities e2 JOIN infra_current c ON c.entity_id = e2.id
               WHERE e2.connection_id IS ? AND e2.org_id = ? AND e2.category = 'dhcp-scope' AND c.status = 'observed'`,
            )
            .all(ctx.connection_id, ctx.org_id) as Array<{ attrs_json: string }>;
          for (const s of scopes) {
            const attrs = JSON.parse(s.attrs_json) as Record<string, unknown>;
            const start = ipToInt(str(attrs.start));
            const end = ipToInt(str(attrs.end));
            if (start !== null && end !== null && ipN >= start && ipN <= end) {
              add('dns-static-in-dhcp-pool', `Static DNS record "${e.display}" targets an address inside DHCP pool ${String(attrs.scopeId)}`, 'A static record pointing into a dynamic pool silently re-targets the name to whichever client holds the lease — verify the record should not be static elsewhere or the pool address should be excluded/reserved.', { category: 'dns-record', namespace: e.namespace, key: e.key });
              break;
            }
          }
        }
      }
    }
  }

  /* ── Queries (MCP + UI read the same projections — plan §5) ─────────── */

  orgSummary(orgId: number): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const counts = this.db
      .prepare(
        `SELECT e.category, c.status, COUNT(*) AS n FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
         WHERE e.connection_id IS ? AND e.org_id = ? GROUP BY e.category, c.status`,
      )
      .all(conn, orgId) as Array<{ category: string; status: string; n: number }>;
    const coverage = this.db
      .prepare(
        `SELECT source_device_id, namespace, section, status, MAX(collected_at) AS last_at FROM collection_coverage
         WHERE connection_id IS ? AND org_id = ? GROUP BY source_device_id, section`,
      )
      .all(conn, orgId) as Array<Record<string, unknown>>;
    const findings = this.db
      .prepare("SELECT id, rule_id, title, detail, entity_id, created_at FROM infra_annotations WHERE connection_id IS ? AND org_id = ? AND kind = 'finding' AND status = 'open' ORDER BY created_at DESC LIMIT 20")
      .all(conn, orgId);
    const conflicts = this.db
      .prepare(
        `SELECT e.id, e.category, e.display_name, c.conflict_json FROM infra_current c JOIN infra_entities e ON e.id = c.entity_id
         WHERE e.connection_id IS ? AND e.org_id = ? AND c.conflicting = 1`,
      )
      .all(conn, orgId);
    const byCat: Record<string, Record<string, number>> = {};
    for (const r of counts) (byCat[r.category] ??= {})[r.status] = r.n;
    return { orgId, categories: byCat, coverage, findings, conflicts, generatedAt: Date.now() };
  }

  /**
   * Latest links-to count per entity — the most recent collection's link set
   * (max collected_at per source), so an unlinked GPO reads 0, not a stale
   * accumulation. Bounded by atMs for as-of replay.
   */
  private linkCountSubquery(atMs: number | null): { sql: string; args: number[] } {
    const outerBound = atMs === null ? '' : ' AND r.collected_at <= ?';
    const innerBound = atMs === null ? '' : ' AND r2.collected_at <= ?';
    return {
      sql: `SELECT r.from_entity_id, COUNT(DISTINCT r.to_entity_id) AS link_count
            FROM relationship_observations r
            WHERE r.rel_type = 'links-to'${outerBound}
              AND r.collected_at = (SELECT MAX(r2.collected_at) FROM relationship_observations r2
                    WHERE r2.from_entity_id = r.from_entity_id AND r2.rel_type = 'links-to'${innerBound})
            GROUP BY r.from_entity_id`,
      args: atMs === null ? [] : [atMs, atMs],
    };
  }

  listEntities(orgId: number, opts: { category?: string | undefined; namespace?: string | undefined; status?: string | undefined; q?: string | undefined; limit?: number | undefined; cursor?: number | undefined; linkCounts?: boolean | undefined }): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const cond: string[] = ['e.connection_id IS ?', 'e.org_id = ?'];
    const args: unknown[] = [conn, orgId];
    if (opts.category) { cond.push('e.category = ?'); args.push(opts.category); }
    if (opts.namespace) { cond.push('e.namespace = ?'); args.push(opts.namespace); }
    if (opts.status) { cond.push('c.status = ?'); args.push(opts.status); }
    if (opts.q) { cond.push('(e.display_name LIKE ? OR e.stable_key LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.cursor) { cond.push('e.rowid > ?'); args.push(opts.cursor); }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const lc = opts.linkCounts ? this.linkCountSubquery(null) : null;
    const rows = this.db
      .prepare(
        `SELECT e.rowid AS _cur, e.id, e.category, e.namespace, e.stable_key, e.display_name, e.first_seen_at, e.last_seen_at, e.source_device_id,
                c.attrs_json, c.status, c.conflicting, c.observed_at, c.collected_at, c.last_operation_id${lc ? ', lc.link_count' : ''}
         FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
         ${lc ? `LEFT JOIN (${lc.sql}) lc ON lc.from_entity_id = e.id` : ''}
         WHERE ${cond.join(' AND ')} ORDER BY e.rowid LIMIT ?`,
      )
      .all(...(lc?.args as never[] ?? []), ...(args as never[]), limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      entities: page.map((r) => ({ ...r, attrs: correctAttrs(r.category, JSON.parse(String(r.attrs_json))), attrs_json: undefined })),
      nextCursor: rows.length > limit ? page[page.length - 1]!._cur : null,
    };
  }

  getEntity(orgId: number, entityId: string): Record<string, unknown> | null {
    const conn = this.store.connId ?? null;
    const e = this.db
      .prepare(
        `SELECT e.*, c.attrs_json AS cur_attrs, c.status AS cur_status, c.conflicting, c.conflict_json, c.observed_at, c.collected_at, c.last_operation_id
         FROM infra_entities e LEFT JOIN infra_current c ON c.entity_id = e.id
         WHERE e.id = ? AND e.connection_id IS ? AND e.org_id = ?`,
      )
      .get(entityId, conn, orgId) as Record<string, unknown> | undefined;
    if (!e) return null;
    const history = this.db
      .prepare('SELECT id, attrs_json, collected_at, operation_id, extractor_version FROM entity_observations WHERE entity_id = ? ORDER BY collected_at DESC LIMIT 20')
      .all(entityId) as Array<Record<string, unknown>>;
    const rels = this.db
      .prepare(
        `SELECT r.rel_type, r.attrs_json, r.collected_at, fe.display_name AS from_name, fe.category AS from_cat, te.display_name AS to_name, te.category AS to_cat, r.from_entity_id, r.to_entity_id
         FROM relationship_observations r
         JOIN infra_entities fe ON fe.id = r.from_entity_id
         JOIN infra_entities te ON te.id = r.to_entity_id
         WHERE r.from_entity_id = ? OR r.to_entity_id = ? ORDER BY r.collected_at DESC LIMIT 50`,
      )
      .all(entityId, entityId) as Array<Record<string, unknown>>;
    return {
      entity: { ...e, current: { attrs: correctAttrs(e.category, JSON.parse(String(e.cur_attrs ?? '{}'))), status: e.cur_status, conflicting: e.conflicting, conflict: e.conflict_json ? JSON.parse(String(e.conflict_json)) : null, observedAt: e.observed_at, collectedAt: e.collected_at, operationId: e.last_operation_id }, cur_attrs: undefined, cur_status: undefined, conflict_json: undefined },
      history: history.map((h) => ({ ...h, attrs: correctAttrs(e.category, JSON.parse(String(h.attrs_json))), attrs_json: undefined })),
      relationships: rels.map((r) => ({ ...r, attrs: r.attrs_json ? JSON.parse(String(r.attrs_json)) : null, attrs_json: undefined })),
    };
  }

  getCoverage(orgId: number): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const rows = this.db
      .prepare(
        `SELECT cc.*, d.display_name AS source_name FROM collection_coverage cc
         LEFT JOIN entities_device d ON d.device_id = cc.source_device_id
         WHERE cc.connection_id IS ? AND cc.org_id = ? ORDER BY cc.collected_at DESC LIMIT 200`,
      )
      .all(conn, orgId) as Array<Record<string, unknown>>;
    const backlog = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM ingestion_jobs GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    return { coverage: rows, ingestion: Object.fromEntries(backlog.map((b) => [b.status, b.n])) };
  }

  /** Bounded change feed: observations/new entities in a window. */
  getChanges(orgId: number, opts: { since?: number | undefined; until?: number | undefined; category?: string | undefined; limit?: number | undefined }): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const since = opts.since ?? Date.now() - 90 * 86400_000;
    const until = opts.until ?? Date.now();
    const cond = ['e.connection_id IS ?', 'e.org_id = ?', 'o.collected_at >= ?', 'o.collected_at <= ?'];
    const args: unknown[] = [conn, orgId, since, until];
    if (opts.category) { cond.push('e.category = ?'); args.push(opts.category); }
    const rows = this.db
      .prepare(
        `SELECT o.id, o.collected_at, o.operation_id, e.category, e.display_name, e.stable_key, o.attrs_json
         FROM entity_observations o JOIN infra_entities e ON e.id = o.entity_id
         WHERE ${cond.join(' AND ')} ORDER BY o.collected_at DESC LIMIT ?`,
      )
      .all(...(args as never[]), Math.min(opts.limit ?? 100, 300)) as Array<Record<string, unknown>>;
    return { window: { since, until }, changes: rows.map((r) => ({ ...r, attrs: correctAttrs(r.category, JSON.parse(String(r.attrs_json))), attrs_json: undefined })) };
  }

  /**
   * Endpoint troubleshooting context: candidate associations only — an IP
   * inside a scope suggests a scope, a dns-name suffix suggests a domain;
   * every join is labeled with its basis (plan §7).
   */
  endpointContext(orgId: number, deviceId: number): Record<string, unknown> {
    const conn = this.store.connId ?? null;
    const device = this.store.getDeviceById(deviceId);
    if (!device) return { deviceId, error: 'device not in cache' };
    const candidates: Array<Record<string, unknown>> = [];
    const dnsName = norm(device.dns_name ?? device.system_name);
    // Candidate domain from dns suffix.
    const domains = this.db
      .prepare("SELECT id, display_name, stable_key FROM infra_entities WHERE connection_id IS ? AND org_id = ? AND category = 'domain'")
      .all(conn, orgId) as Array<{ id: string; display_name: string; stable_key: string }>;
    for (const d of domains) {
      const root = norm(d.display_name ?? d.stable_key);
      if (root && dnsName.endsWith(`.${root}`)) {
        candidates.push({ basis: 'dns-suffix-match', kind: 'domain', entityId: d.id, value: root, confidence: 'candidate' });
      }
    }
    // Candidate DHCP scope from last known IP (if device cache carries one).
    const ip = str((device as Record<string, unknown>).ip_address ?? (device as Record<string, unknown>).ipv4);
    if (ip) {
      const scopes = this.db
        .prepare(
          `SELECT e.id, e.display_name, c.attrs_json FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
           WHERE e.connection_id IS ? AND e.org_id = ? AND e.category = 'dhcp-scope' AND c.status = 'observed'`,
        )
        .all(conn, orgId) as Array<{ id: string; display_name: string; attrs_json: string }>;
      for (const s of scopes) {
        const a = JSON.parse(s.attrs_json) as { start?: string; end?: string };
        if (a.start && a.end && ipInRange(ip, a.start, a.end)) {
          candidates.push({ basis: 'ip-in-scope-range', kind: 'dhcp-scope', entityId: s.id, value: s.display_name, confidence: 'candidate' });
        }
      }
    }
    return { deviceId, device: { name: device.display_name ?? device.system_name, dnsName: device.dns_name }, candidates };
  }

  /**
   * Local backfill (plan §9): scan retained receipts, report what would be
   * ingested (dry-run) or enqueue jobs (commit). Never submits endpoint work.
   */
  backfill(opts: { dryRun: boolean; limit?: number | undefined }): Record<string, unknown> {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const supported = Object.keys(EXTRACTORS);
    const singles = this.db
      .prepare(
        `SELECT id, runbook_id, runbook_version, status, result_json FROM operations
         WHERE runbook_id IS NOT NULL AND status IN ('verified','failed','partial') ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;
    const targets = this.db
      .prepare(
        `SELECT t.seq, t.operation_id, o.runbook_id, o.runbook_version, t.status, t.result_json FROM operation_targets t
         JOIN operations o ON o.id = t.operation_id
         WHERE o.runbook_id IS NOT NULL AND t.status IN ('verified','failed','partial') ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;

    const report = { eligible: 0, enqueued: 0, skipped: [] as Array<{ ref: string; reason: string }>, disputed: [] as Array<{ ref: string; note: string }>, byRunbook: {} as Record<string, number> };
    const consider = (ref: string, operationId: string, seq: number | null, runbookId: string, version: number, resultJson: string | null) => {
      if (!supported.includes(runbookId)) { report.skipped.push({ ref, reason: `no extractor for ${runbookId}` }); return; }
      if (!EXTRACTORS[runbookId]![version]) { report.skipped.push({ ref, reason: `no extractor for ${runbookId} v${version}` }); return; }
      let exitCode: number | null = null;
      let hasParse = false;
      try {
        const r = JSON.parse(resultJson ?? '{}') as { parsed?: unknown; exitCode?: number };
        hasParse = !!r.parsed;
        exitCode = r.exitCode ?? null;
      } catch { /* fall through */ }
      if (!hasParse) { report.skipped.push({ ref, reason: 'no parsed RBJSON on receipt' }); return; }
      report.eligible++;
      report.byRunbook[runbookId] = (report.byRunbook[runbookId] ?? 0) + 1;
      if (exitCode !== null && exitCode !== 0) report.disputed.push({ ref, note: `exitCode=${exitCode} — qualified ingestion` });
      if (!opts.dryRun) {
        const ins = this.db
          .prepare(
            `INSERT OR IGNORE INTO ingestion_jobs (id, operation_id, target_seq, runbook_id, extractor_version, idempotency_key, status, attempts, created_at)
             VALUES (?,?,?,?,?, ?, 'pending', 0, ?)`,
          )
          .run(randomUUID(), operationId, seq, runbookId, EXTRACTOR_VERSION, `${operationId}:${seq ?? 'op'}`, Date.now());
        if (Number(ins.changes) > 0) report.enqueued++;
      }
    };
    for (const op of singles.slice(0, limit)) consider(`op:${String(op.id).slice(0, 8)}`, String(op.id), null, String(op.runbook_id), Number(op.runbook_version ?? 1), op.result_json as string | null);
    for (const t of targets.slice(0, limit)) consider(`target:${t.seq}`, String(t.operation_id), Number(t.seq), String(t.runbook_id), Number(t.runbook_version ?? 1), t.result_json as string | null);
    return report;
  }

  annotations(orgId: number): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM infra_annotations WHERE connection_id IS ? AND org_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(this.store.connId ?? null, orgId) as Array<Record<string, unknown>>;
  }
}

function ipInRange(ip: string, start: string, end: string): boolean {
  const toNum = (v: string) => v.split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);
  const n = toNum(ip);
  return n >= toNum(start) && n <= toNum(end);
}
