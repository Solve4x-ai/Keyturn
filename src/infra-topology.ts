/**
 * Infrastructure topology — one structured, read-only model of an
 * organization's directory, DNS, DHCP, and Group Policy, assembled from the
 * evidence store (infra_entities + infra_current + latest relationships).
 *
 * The UI draws this directly (domain map, DC cards, zone grid, scope gauges,
 * GPO health) instead of stitching long entity lists together. Honesty rules
 * are unchanged: every node carries its projection status and collection
 * time; nothing is inferred beyond what a collection observed; "unlinked"
 * is only claimed when link coverage is complete.
 */
import type { EntityStore } from './entity-store.js';
import { GPO_STATUS, gpoStatusCode, gpoStatusLabel } from './infra.js';

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const host = (v: unknown) => String(v ?? '').toLowerCase().split('.')[0] ?? '';
const RECORD_CAP = 3000;
const CLIENT_CAP = 3000;

interface Node {
  id: string; category: string; namespace: string; key: string; name: string;
  attrs: Row; status: string; conflicting: boolean; collectedAt: number | null; sourceDeviceId: number | null;
}

/** "01:00:00" / "8.00:00:00" / seconds → seconds. */
function durationSeconds(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) : null;
}

export function buildInfraTopology(store: EntityStore, orgId: number) {
  const db = store.database;
  const conn = store.connId ?? null;

  const rows = db.prepare(
    `SELECT e.id, e.category, e.namespace, e.stable_key, e.display_name, e.source_device_id,
            c.attrs_json, c.status, c.conflicting, c.collected_at
     FROM infra_entities e JOIN infra_current c ON c.entity_id = e.id
     WHERE e.connection_id IS ? AND e.org_id = ? AND c.status != 'superseded'`,
  ).all(conn, orgId) as Row[];
  const nodes: Node[] = rows.map((r) => ({
    id: String(r.id), category: String(r.category), namespace: String(r.namespace), key: String(r.stable_key),
    name: String(r.display_name ?? r.stable_key),
    attrs: (() => { try { return JSON.parse(String(r.attrs_json ?? '{}')) as Row; } catch { return {}; } })(),
    status: String(r.status), conflicting: Number(r.conflicting) === 1,
    collectedAt: num(r.collected_at), sourceDeviceId: num(r.source_device_id),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const of = (cat: string) => nodes.filter((n) => n.category === cat);

  // Latest relationship set per (from, rel) — a stale older link does not
  // survive a newer collection that no longer reports it.
  const rels = nodes.length
    ? (db.prepare(
      `SELECT r.from_entity_id AS f, r.to_entity_id AS t, r.rel_type AS rel, r.attrs_json AS a
       FROM relationship_observations r
       WHERE r.collected_at = (SELECT MAX(r2.collected_at) FROM relationship_observations r2
                               WHERE r2.from_entity_id = r.from_entity_id AND r2.rel_type = r.rel_type)
         AND r.from_entity_id IN (SELECT id FROM infra_entities WHERE connection_id IS ? AND org_id = ?)`,
    ).all(conn, orgId) as Row[])
    : [];
  const out = new Map<string, Array<{ to: string; rel: string; attrs: Row | null }>>();
  const seen = new Set<string>();
  for (const r of rels) {
    const k = `${r.f}|${r.t}|${r.rel}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const list = out.get(String(r.f)) ?? [];
    list.push({ to: String(r.t), rel: String(r.rel), attrs: r.a ? (() => { try { return JSON.parse(String(r.a)); } catch { return null; } })() : null });
    out.set(String(r.f), list);
  }
  const targets = (id: string, rel: string) => (out.get(id) ?? []).filter((x) => x.rel === rel).map((x) => byId.get(x.to)).filter((n): n is Node => !!n);

  // NinjaOne devices by hostname — links topology nodes to live agents.
  const devices = db.prepare('SELECT device_id, system_name, dns_name, offline, last_contact FROM entities_device WHERE org_id = ?').all(orgId) as Row[];
  const deviceByHost = new Map<string, Row>();
  for (const d of devices) {
    for (const h of [host(d.system_name), host(d.dns_name)]) if (h) deviceByHost.set(h, d);
  }
  const agent = (hostname: unknown) => {
    const d = deviceByHost.get(host(hostname));
    return d ? { deviceId: Number(d.device_id), offline: Number(d.offline) === 1, lastContact: num(d.last_contact) } : null;
  };
  const base = (n: Node) => ({ id: n.id, name: n.name, status: n.status, conflicting: n.conflicting, collectedAt: n.collectedAt });

  // ── Directory ─────────────────────────────────────────────────────────
  // Logical DCs: collapse short-name / FQDN twins (e.g. DC04 vs
  // DC04.contoso.local) into one card, preferring the richer record.
  const fsmoHolders = new Map<string, string[]>();
  for (const f of of('fsmo-role')) {
    const role = f.name.replace(/\s*\(.*\)$/, '').trim();
    for (const dc of targets(f.id, 'held-by')) {
      const h = host(dc.attrs.host ?? dc.name);
      const list = fsmoHolders.get(h) ?? [];
      if (!list.includes(role)) list.push(role);
      fsmoHolders.set(h, list);
    }
  }
  const dcMap = new Map<string, Node>();
  for (const dc of of('domain-controller')) {
    const h = host(dc.attrs.host ?? dc.name);
    const prev = dcMap.get(h);
    if (!prev || Object.keys(dc.attrs).length > Object.keys(prev.attrs).length) dcMap.set(h, dc);
  }
  const FSMO_ORDER = ['schema', 'naming', 'pdc', 'rid', 'infra'];
  const dcs = [...dcMap.entries()].map(([h, dc]) => ({
    ...base(dc),
    host: str(dc.attrs.host) ?? dc.name,
    ip: str(dc.attrs.ip), os: str(dc.attrs.os), site: str(dc.attrs.site),
    gc: dc.attrs.gc === true, rodc: dc.attrs.rodc === true,
    fsmo: (fsmoHolders.get(h) ?? []).sort((a, b) => FSMO_ORDER.indexOf(a) - FSMO_ORDER.indexOf(b)),
    agent: agent(dc.attrs.host ?? dc.name),
  })).sort((a, b) => b.fsmo.length - a.fsmo.length || a.host.localeCompare(b.host));
  const forest = of('forest')[0];
  const domains = of('domain').filter((d) => !/unknown/i.test(d.namespace));
  const directory = {
    forest: forest ? { ...base(forest), name: str(forest.attrs.name) ?? forest.name, mode: str(forest.attrs.forestMode), rootDomain: str(forest.attrs.rootDomain), siteCount: num(forest.attrs.siteCount), gcCount: num(forest.attrs.globalCatalogCount) } : null,
    domains: domains.map((d) => ({ ...base(d), dnsRoot: str(d.attrs.dnsRoot) ?? d.name, netbios: str(d.attrs.netbios), mode: str(d.attrs.domainMode) })),
    sites: [...new Set(of('site').map((s) => s.name))].map((name) => ({ name, dcs: dcs.filter((d) => d.site === name).map((d) => d.host) })),
    dcs,
    fsmo: FSMO_ORDER.map((role) => ({ role, holder: dcs.find((d) => d.fsmo.includes(role))?.host ?? null })),
  };

  // ── DNS ───────────────────────────────────────────────────────────────
  const records = of('dns-record');
  const recordsByNs = new Map<string, Node[]>();
  for (const r of records) (recordsByNs.get(r.namespace) ?? recordsByNs.set(r.namespace, []).get(r.namespace)!).push(r);
  const zoneView = (z: Node) => {
    const recs = recordsByNs.get(`dns-zone:${z.name.toLowerCase()}@${z.namespace.replace(/^dns-server:/, '')}`)
      ?? recordsByNs.get(`dns-zone:${z.name}@${z.namespace.replace(/^dns-server:/, '')}`) ?? [];
    const byType: Record<string, number> = {};
    for (const r of recs) { const t = String(r.attrs.type ?? '?'); byType[t] = (byType[t] ?? 0) + 1; }
    const dyn = str(z.attrs.dynamicUpdate);
    return {
      ...base(z),
      type: str(z.attrs.zoneType), reverse: z.attrs.reverse === true, dsIntegrated: z.attrs.dsIntegrated === true,
      dynamicUpdate: dyn, insecureUpdates: !!dyn && /nonsecure/i.test(dyn),
      recordNamespace: recs[0]?.namespace ?? null,
      recordCount: recs.length ? recs.length : null,
      recordTypes: byType,
    };
  };
  const dnsServers = of('dns-server').map((s) => {
    const zones = targets(s.id, 'hosts-zone');
    const zs = (zones.length ? zones : of('dns-zone').filter((z) => z.namespace === `dns-server:${s.key.toLowerCase()}`)).map(zoneView)
      .sort((a, b) => Number(a.reverse) - Number(b.reverse) || a.name.localeCompare(b.name));
    const scav = s.attrs.scavenging as Row | undefined;
    return {
      ...base(s),
      forwarders: Array.isArray(s.attrs.forwarders) ? s.attrs.forwarders.map(String) : [],
      scavenging: scav ? { enabled: scav.enabled === true, intervalHours: durationSeconds(scav.intervalHours) === null ? null : Math.round(durationSeconds(scav.intervalHours)! / 3600) } : null,
      moduleAvailable: s.attrs.moduleAvailable !== false,
      zones: zs,
      agent: agent(s.name),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  // Zone presence across servers — divergence between DCs is worth seeing.
  const zoneNames = [...new Set(dnsServers.flatMap((s) => s.zones.map((z) => z.name.toLowerCase())))].sort();
  const dns = {
    servers: dnsServers,
    zoneMatrix: zoneNames.map((z) => ({ zone: z, servers: dnsServers.map((s) => s.zones.some((x) => x.name.toLowerCase() === z)) })),
    records: records.slice(0, RECORD_CAP).map((r) => ({
      id: r.id, ns: r.namespace, host: str(r.attrs.host) ?? r.name, type: str(r.attrs.type), data: str(r.attrs.data),
      ttl: durationSeconds(r.attrs.ttl), static: r.attrs.isStatic === true || r.attrs.timestamp === null || r.attrs.timestamp === undefined,
      status: r.status,
    })),
    recordsTruncated: records.length > RECORD_CAP,
  };

  // ── DHCP ──────────────────────────────────────────────────────────────
  const reservations = of('dhcp-reservation');
  const leases = of('dhcp-lease');
  const dhcpLive = of('dhcp-server').filter((s) => s.attrs.observedVia !== 'ad-authorization-list' && s.sourceDeviceId !== null);
  const authRecords = of('dhcp-server').filter((s) => s.attrs.observedVia === 'ad-authorization-list' || !dhcpLive.includes(s));
  const scopeId = (n: Node) => String(n.attrs.scopeId ?? n.namespace.replace(/^dhcp-scope:/, '')).toLowerCase();
  const OPT = { router: '3', dns: '6', domain: '15', lease: '51' };
  const dhcpServers = dhcpLive.map((s) => {
    const scopes = (targets(s.id, 'serves-scope').length ? targets(s.id, 'serves-scope') : of('dhcp-scope').filter((z) => z.sourceDeviceId === s.sourceDeviceId))
      .map((z) => {
        const sid = scopeId(z);
        const opts = (z.attrs.options ?? {}) as Record<string, unknown[]>;
        const inUse = num(z.attrs.inUse); const free = num(z.attrs.free);
        const res = reservations.filter((r) => r.sourceDeviceId === s.sourceDeviceId && scopeId(r) === sid);
        const ls = leases.filter((l) => l.sourceDeviceId === s.sourceDeviceId && scopeId(l) === sid);
        return {
          ...base(z), scopeId: str(z.attrs.scopeId), label: str(z.attrs.name) ?? z.name, state: str(z.attrs.state),
          start: str(z.attrs.start), end: str(z.attrs.end),
          inUse, free, pctUsed: num(z.attrs.pctUsed) ?? (inUse !== null && free !== null && inUse + free > 0 ? Math.round((inUse / (inUse + free)) * 1000) / 10 : null),
          router: (opts[OPT.router] ?? []).map(String), dnsServers: [...new Set((opts[OPT.dns] ?? []).map(String))], domain: (opts[OPT.domain] ?? [])[0] ? String(opts[OPT.domain]![0]) : null,
          leaseSeconds: num((opts[OPT.lease] ?? [])[0]),
          reservations: res.length, leases: ls.filter((l) => l.attrs.isReservation !== true).length,
        };
      }).sort((a, b) => (b.pctUsed ?? -1) - (a.pctUsed ?? -1));
    return {
      ...base(s), sourceDeviceId: s.sourceDeviceId,
      authorized: s.attrs.authorizedInAd === true ? true : s.attrs.authorizedInAd === false ? false : null,
      authorizedServers: Array.isArray(s.attrs.authorizedServers) ? s.attrs.authorizedServers.map(String) : [],
      scopes, agent: agent(s.name),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const clients = [
    ...reservations.map((r) => ({ kind: 'reservation', n: r })),
    ...leases.filter((l) => l.attrs.isReservation !== true).map((l) => ({ kind: 'lease', n: l })),
  ].slice(0, CLIENT_CAP).map(({ kind, n }) => ({
    id: n.id, kind, scopeId: scopeId(n), sourceDeviceId: n.sourceDeviceId,
    ip: str(n.attrs.ip), name: str(n.attrs.hostName) ?? str(n.attrs.name), mac: str(n.attrs.clientId),
    state: str(n.attrs.state) ?? (kind === 'reservation' ? 'configured' : null), expiry: str(n.attrs.expiry), status: n.status,
    agent: agent(n.attrs.hostName ?? n.attrs.name),
  }));
  const dhcp = {
    servers: dhcpServers,
    clients,
    clientsTruncated: reservations.length + leases.length > CLIENT_CAP,
    // Directory authorization entries — each checked against a live agent so
    // dead registrations (servers that no longer exist) stand out.
    authorizations: [...new Map(authRecords.map((a) => [host(a.key), a])).values()].map((a) => ({
      ...base(a), host: a.name, reportedIp: str(a.attrs.reportedIp), agent: agent(a.name),
    })).sort((a, b) => a.host.localeCompare(b.host)),
  };

  // ── Group Policy ──────────────────────────────────────────────────────
  const linkCoverage = db.prepare("SELECT status FROM collection_coverage WHERE connection_id IS ? AND org_id = ? AND section = 'links' ORDER BY collected_at DESC LIMIT 1").get(conn, orgId) as Row | undefined;
  const linksComplete = linkCoverage?.status === 'complete';
  const gposRaw = of('gpo').filter((g) => !/unknown/i.test(g.namespace));
  const gpos = [...new Map(gposRaw.map((g) => [g.key, g])).values()].map((g) => {
    const links = targets(g.id, 'links-to').map((c) => str(c.attrs.somPath) ?? c.name);
    const st = gpoStatusCode(g.attrs.gpoStatus);
    return {
      ...base(g), gpoStatus: st, label: gpoStatusLabel(st),
      enabled: st === GPO_STATUS.enabled ? 'enabled' : st === GPO_STATUS.userOff ? 'user-off' : st === GPO_STATUS.computerOff ? 'computer-off' : st === GPO_STATUS.disabled ? 'disabled' : 'unknown',
      links, linked: links.length > 0 ? true : linksComplete ? false : null,
      created: str(g.attrs.created), modified: str(g.attrs.modified),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const containers = [...new Map(of('container').filter((c) => !/unknown/i.test(c.namespace)).map((c) => [str(c.attrs.somPath) ?? c.name, c])).entries()]
    .map(([path, c]) => ({ id: c.id, path, gpos: gpos.filter((g) => g.links.includes(path)).map((g) => g.name) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const gpo = {
    linksComplete,
    counts: {
      total: gpos.length,
      enabled: gpos.filter((g) => g.enabled === 'enabled').length,
      partial: gpos.filter((g) => g.enabled === 'user-off' || g.enabled === 'computer-off').length,
      disabled: gpos.filter((g) => g.enabled === 'disabled').length,
      unlinked: linksComplete ? gpos.filter((g) => g.linked === false).length : null,
    },
    gpos, containers,
  };

  // ── Evidence ──────────────────────────────────────────────────────────
  const cov = db.prepare(
    `SELECT cc.source_device_id, d.system_name, cc.runbook_id, cc.section, cc.status, cc.enumerated_count, cc.truncated, MAX(cc.collected_at) AS at
     FROM collection_coverage cc LEFT JOIN entities_device d ON d.device_id = cc.source_device_id
     WHERE cc.connection_id IS ? AND cc.org_id = ? GROUP BY cc.source_device_id, cc.section`,
  ).all(conn, orgId) as Row[];
  const findings = db.prepare("SELECT id, rule_id, title, detail, entity_id, created_at FROM infra_annotations WHERE connection_id IS ? AND org_id = ? AND kind = 'finding' AND status = 'open' ORDER BY created_at DESC LIMIT 50").all(conn, orgId) as Row[];
  const lastCollected = nodes.reduce((m, n) => Math.max(m, n.collectedAt ?? 0), 0) || null;

  return {
    schemaVersion: 1,
    orgId,
    generatedAt: Date.now(),
    lastCollected,
    empty: nodes.length === 0,
    directory, dns, dhcp, gpo,
    coverage: cov.map((c) => ({ sourceDeviceId: num(c.source_device_id), source: str(c.system_name), runbook: str(c.runbook_id), section: str(c.section), status: str(c.status), count: num(c.enumerated_count), truncated: Number(c.truncated) === 1, at: num(c.at) })),
    findings: findings.map((f) => ({ id: f.id, rule: f.rule_id, title: f.title, detail: f.detail, entityId: f.entity_id, at: num(f.created_at) })),
    conflicts: nodes.filter((n) => n.conflicting).map((n) => ({ id: n.id, category: n.category, name: n.name })),
  };
}
