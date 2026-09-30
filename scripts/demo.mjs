#!/usr/bin/env node
// Mission Control demo — explore the full UI with a fictional MSP and no RMM
// account. Seeds a throwaway SQLite database under .demo/ (git-ignored) and
// starts the local server in read-only reporting mode with every upstream
// worker off: nothing here can reach NinjaOne or touch a real endpoint.
//
//   npm run demo              seed (if needed) and start on http://localhost:39399
//   npm run demo -- --reset   rebuild the demo data from scratch
//   npm run demo -- --seed-only
//
// All organizations, hosts, users, and addresses are fictional
// (Contoso / Northwind / Fabrikam, RFC 1918 ranges).
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = join(ROOT, '.demo');
const DB_PATH = join(DEMO_DIR, 'demo.db');
const PORT = Number(process.env.DEMO_PORT || 39399);
const args = new Set(process.argv.slice(2));

if (!existsSync(join(ROOT, 'dist', 'serve.js'))) {
  console.error('Build first:  npm run build');
  process.exit(1);
}

const { openDatabase } = await import('../dist/storage.js');
const { EntityStore } = await import('../dist/entity-store.js');
const { ReviewService } = await import('../dist/review.js');

// Deterministic pseudo-random so screenshots are reproducible.
let s = 0x5eed;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rand() * a.length)];

const NOW = Date.now();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function seed() {
  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  const store = new EntityStore(openDatabase(DB_PATH));
  const db = store.database;

  // ── Organizations, locations, devices ─────────────────────────────
  const orgs = [
    { id: 1, name: 'Contoso Dental Group', domain: 'contoso.local', net: '10.20', sites: ['Main Clinic', 'Eastside Clinic', 'Billing Office'], ws: 38, servers: ['DC01', 'DC02', 'FS01', 'SQL01', 'IMG01', 'RDS01'] },
    { id: 2, name: 'Northwind Logistics', domain: 'northwind.local', net: '10.30', sites: ['Warehouse', 'Head Office'], ws: 24, servers: ['NW-DC01', 'NW-APP01', 'NW-FS01', 'NW-PRINT01'] },
    { id: 3, name: 'Fabrikam Legal', domain: 'fabrikam.local', net: '10.40', sites: ['Downtown'], ws: 11, servers: ['FAB-DC01', 'FAB-DOC01'] },
  ];
  const insOrg = db.prepare('INSERT INTO entities_org (org_id, name, description, raw_json, updated_at, seen_at) VALUES (?,?,?,?,?,?)');
  const insLoc = db.prepare('INSERT INTO entities_location (org_id, location_id, name, raw_json, updated_at, seen_at) VALUES (?,?,?,?,?,?)');
  const insDev = db.prepare('INSERT INTO entities_device (device_id, system_name, display_name, dns_name, org_id, location_id, node_class, offline, last_contact, raw_json, updated_at, seen_at, name_norm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const people = ['reception', 'hygiene-1', 'hygiene-2', 'dr-lee', 'dr-patel', 'office-mgr', 'billing-1', 'billing-2', 'xray', 'lab', 'ops-1', 'ops-2', 'dispatch', 'yard', 'hr', 'finance', 'paralegal-1', 'paralegal-2', 'partner-1', 'partner-2', 'records'];
  let devId = 100, locId = 10;
  const devices = [];
  for (const o of orgs) {
    insOrg.run(o.id, o.name, `Managed client · ${o.domain}`, JSON.stringify({ id: o.id, name: o.name }), NOW, NOW);
    const locs = o.sites.map((name) => { const id = ++locId; insLoc.run(o.id, id, name, JSON.stringify({ id, name }), NOW, NOW); return id; });
    const add = (name, display, nodeClass, offline, lastContactMs) => {
      const id = ++devId;
      const loc = locs[devices.filter((d) => d.org === o.id).length % locs.length];
      const dns = `${name.toLowerCase()}.${o.domain}`;
      const raw = { id, systemName: name, displayName: display, dnsName: dns, organizationId: o.id, locationId: loc, nodeClass, offline, lastContact: lastContactMs / 1000,
        os: { name: nodeClass === 'WINDOWS_SERVER' ? 'Windows Server 2022 Standard' : pick(['Windows 11 Pro', 'Windows 11 Pro', 'Windows 10 Pro']) } };
      insDev.run(id, name, display, dns, o.id, loc, nodeClass, offline ? 1 : 0, lastContactMs / 1000, JSON.stringify(raw), NOW, NOW, `${name}${display}`.toLowerCase().replace(/[^a-z0-9]/g, ''));
      devices.push({ id, name, org: o.id, nodeClass, offline });
      return id;
    };
    for (const srv of o.servers) {
      const offline = srv === 'IMG01';
      add(srv, srv, 'WINDOWS_SERVER', offline, offline ? NOW - 2 * DAY - 3 * HOUR : NOW - Math.floor(rand() * 4) * MIN);
    }
    const prefix = o.domain.slice(0, 3).toUpperCase();
    for (let i = 1; i <= o.ws; i++) {
      const offline = rand() < 0.14;
      const age = offline ? pick([3 * HOUR, 20 * HOUR, 3 * DAY, 9 * DAY]) : Math.floor(rand() * 10) * MIN;
      add(`${prefix}-WS${String(i).padStart(3, '0')}`, `${pick(people)} PC`, i % 7 === 0 ? 'WINDOWS_LAPTOP' : 'WINDOWS_WORKSTATION', offline, NOW - age);
    }
  }
  const sync = db.prepare('INSERT INTO sync_state (entity_type, last_sync_at, item_count) VALUES (?,?,?)');
  sync.run('devices', NOW - 3 * MIN, devices.length);
  sync.run('organizations', NOW - 3 * MIN, orgs.length);
  sync.run('locations', NOW - 3 * MIN, locId - 10);

  // A little change history so device timelines are not empty.
  const chg = db.prepare('INSERT INTO entity_changes (entity_type, entity_id, field, old_value, new_value, detected_at) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 120; i++) {
    const d = pick(devices);
    const at = NOW - Math.floor(rand() * 14 * DAY);
    chg.run('device', String(d.id), 'offline', rand() < 0.5 ? '0' : '1', rand() < 0.5 ? '1' : '0', at);
  }

  // ── Infrastructure evidence (as the read-only runbooks would collect it) ──
  let n = 0;
  const insEnt = db.prepare('INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, aliases_json, first_seen_at, last_seen_at, source_device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insCur = db.prepare('INSERT INTO infra_current (entity_id, attrs_json, status, conflicting, collected_at, observed_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const ent = (org, ns, category, key, name, attrs, src, at = NOW - 2 * HOUR) => {
    const id = `demo-e${++n}`;
    insEnt.run(id, null, org, ns, category, key, name, '[]', at - 10 * DAY, at, src);
    insCur.run(id, JSON.stringify(attrs), 'observed', 0, at, at, at);
    return id;
  };
  let r = 0;
  const insRel = db.prepare('INSERT INTO relationship_observations (id, from_entity_id, to_entity_id, rel_type, coverage_id, collected_at, ingested_at, operation_id) VALUES (?,?,?,?,?,?,?,?)');
  const rel = (from, to, type, cov) => insRel.run(`demo-r${++r}`, from, to, type, cov, NOW - 2 * HOUR, NOW - 2 * HOUR, 'demo-op-collect');
  let c = 0;
  const insCov = db.prepare('INSERT INTO collection_coverage (id, connection_id, org_id, operation_id, runbook_id, runbook_version, source_device_id, namespace, section, status, completeness, enumerated_count, truncated, collected_at, ingested_at, extractor_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const cov = (org, src, runbook, section, status, count, ns = null) => {
    const id = `demo-c${++c}`;
    insCov.run(id, null, org, 'demo-op-collect', runbook, 1, src, ns, section, status, status === 'complete' ? 'complete' : 'partial', count, 0, NOW - 2 * HOUR, NOW - 2 * HOUR, 4);
    return id;
  };
  const devByName = (org, name) => devices.find((d) => d.org === org && d.name === name)?.id ?? null;

  for (const o of orgs) {
    const dcs = o.servers.filter((x) => /DC0\d$/.test(x));
    const dc1 = devByName(o.id, dcs[0]);
    const dom = `domain:${o.domain}`;
    const netbios = o.domain.split('.')[0].toUpperCase();
    const linksCov = cov(o.id, dc1, 'diag/gpo-inventory', 'links', 'complete', 12);
    cov(o.id, dc1, 'diag/ad-health', 'directory', 'complete', dcs.length);
    cov(o.id, dc1, 'diag/dns-inventory', 'zones', 'complete', 3);
    cov(o.id, dc1, 'diag/dhcp-inventory', 'scopes', o.id === 3 ? 'partial' : 'complete', 2);

    ent(o.id, dom, 'forest', o.domain, o.domain, { name: o.domain, forestMode: 'Windows2016Forest', siteCount: 1, globalCatalogCount: dcs.length, rootDomain: o.domain }, dc1);
    ent(o.id, dom, 'domain', `sid-${o.id}`, o.domain, { dnsRoot: o.domain, netbios, domainMode: 'Windows2016Domain' }, dc1);
    ent(o.id, dom, 'site', 'default', 'Default-First-Site-Name', {}, dc1);
    const dcIds = dcs.map((name, i) => ent(o.id, dom, 'domain-controller', `${name.toLowerCase()}.${o.domain}`, `${name}.${o.domain}`,
      { host: `${name}.${o.domain}`, ip: `${o.net}.0.${10 + i}`, os: 'Windows Server 2022 Standard', site: 'Default-First-Site-Name', gc: true, rodc: false }, devByName(o.id, name)));
    for (const [i, role] of ['schema', 'naming', 'pdc', 'rid', 'infrastructure'].entries()) {
      const f = ent(o.id, dom, 'fsmo-role', role, `${role} (${i < 2 ? 'forest' : 'domain'})`, { scope: i < 2 ? 'forest' : 'domain' }, dc1);
      rel(f, dcIds[0], 'held-by', linksCov);
    }

    // DNS
    const dnsNs = `dns-server:${dcs[0].toLowerCase()}.${o.domain}`;
    ent(o.id, 'ad', 'dns-server', `${dcs[0].toLowerCase()}.${o.domain}`, `${dcs[0]}.${o.domain}`, { host: `${dcs[0]}.${o.domain}`, forwarders: ['1.1.1.1', '9.9.9.9'], scavenging: o.id !== 2 }, dc1);
    const zones = [[o.domain, false], [`_msdcs.${o.domain}`, false], [`${o.net.split('.').reverse().join('.')}.in-addr.arpa`, true]];
    for (const [z, reverse] of zones) {
      ent(o.id, dnsNs, 'dns-zone', z, z, { name: z, zoneType: 'Primary', dsIntegrated: true, dynamicUpdate: 'Secure', reverse }, dc1);
      if (z === o.domain) {
        const recNs = `dns-zone:${z}@${dcs[0].toLowerCase()}.${o.domain}`;
        const recs = [['@', 'A', `${o.net}.0.10`], [dcs[0].toLowerCase(), 'A', `${o.net}.0.10`], ['mail', 'CNAME', `${o.domain.split('.')[0]}-mail.example.net.`], ['intranet', 'A', `${o.net}.0.25`], ['printer-01', 'A', `${o.net}.1.40`]];
        for (const [host, type, data] of recs) ent(o.id, recNs, 'dns-record', `${host}/${type}`, `${host} ${type} → ${data}`, { host, type, data, ttl: '01:00:00', timestamp: null }, dc1);
      }
    }

    // DHCP
    const dhcpSrv = ent(o.id, 'ad', 'dhcp-server', `${dcs[0].toLowerCase()}.${o.domain}`, `${dcs[0]}.${o.domain}`,
      { authorizedInAd: true, authorizedServers: [`${dcs[0].toLowerCase()}.${o.domain}`, ...(o.id === 1 ? [`legacy-dhcp.${o.domain}`] : [])] }, dc1);
    if (o.id === 1) ent(o.id, 'ad', 'dhcp-server', 'legacy-dhcp', `legacy-dhcp.${o.domain}`, { observedVia: 'ad-authorization-list' }, null);
    const scopes = [['0', 'Servers & Printers', 40, 30], ['1', 'Workstations', 200, o.id === 1 ? 186 : 120], ['2', 'Guest Wi-Fi', 100, o.id === 2 ? 91 : 37]];
    for (const [third, name, size, used] of scopes) {
      const id = `${o.net}.${third}.0`;
      const scope = ent(o.id, `dhcp-scope:${id}`, 'dhcp-scope', id, `${name} (${id})`,
        { scopeId: id, name, state: 'Active', start: `${o.net}.${third}.20`, end: `${o.net}.${third}.${19 + size}`, inUse: used, free: size - used, pctUsed: Math.round((used / size) * 100),
          options: { 3: [`${o.net}.${third}.1`], 6: [`${o.net}.0.10`, ...(o.id === 2 && third === '2' ? ['8.8.8.8'] : [])], 51: ['691200'] } }, dc1);
      rel(dhcpSrv, scope, 'serves-scope', linksCov);
    }

    // Group Policy
    const gpos = [['Default Domain Policy', 3, true], ['Default Domain Controllers Policy', 3, true], ['Workstation Baseline', 3, true], ['BitLocker Enforcement', 3, true], ['Windows Update Rings', 3, true], ['Legacy Mapped Drives', 3, false], ['Old AV Deployment', 0, false]];
    const ou = ent(o.id, dom, 'container', 'workstations', 'Workstations', { somPath: `${o.domain}/Workstations` }, dc1);
    const root = ent(o.id, dom, 'container', 'root', o.domain, { somPath: o.domain }, dc1);
    for (const [name, status, linked] of gpos.slice(0, o.id === 3 ? 5 : 7)) {
      const g = ent(o.id, dom, 'gpo', name.toLowerCase().replace(/\W+/g, '-'), name, { gpoStatus: status, created: NOW - 400 * DAY, modified: NOW - Math.floor(rand() * 90) * DAY }, dc1);
      if (linked) rel(g, /Domain Policy|Controllers/.test(name) ? root : ou, 'links-to', linksCov);
    }
  }

  // ── Operations: two weeks of approved, receipted runbook work ──────
  const insPlan = db.prepare('INSERT INTO operation_plans (id, connection_id, operation, target_type, target_id, args_canonical, plan_hash, principal, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insAppr = db.prepare('INSERT INTO operation_approvals (id, plan_id, plan_hash, approved_by, method, created_at, expires_at) VALUES (?,?,?,?,?,?,?)');
  const insOp = db.prepare('INSERT INTO operations (id, connection_id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, result_json, runbook_id, runbook_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insEvt = db.prepare('INSERT INTO operation_events (operation_id, kind, at, data_json) VALUES (?,?,?,?)');
  const runbooks = ['diag/ad-health', 'diag/dns-inventory', 'diag/dhcp-inventory', 'diag/gpo-inventory', 'diag/disk-health', 'diag/pending-reboot'];
  const servers = devices.filter((d) => d.nodeClass === 'WINDOWS_SERVER' && !d.offline);
  for (let i = 0; i < 110; i++) {
    const day = Math.floor(Math.pow(rand(), 1.3) * 30);
    const at = NOW - day * DAY - Math.floor(rand() * 8) * HOUR - HOUR;
    const target = pick(servers);
    const rb = pick(runbooks);
    const status = i < 2 ? 'accepted' : rand() < 0.1 ? 'failed' : 'verified';
    const id = `demo-op-${i}`;
    const hash = randomBytes(16).toString('hex');
    insPlan.run(`demo-plan-${i}`, null, 'run_device_powershell', 'device', target.id, JSON.stringify({ runbookId: rb }), hash, 'mcp:command', at - 4 * MIN, at + 11 * MIN);
    insAppr.run(`demo-appr-${i}`, `demo-plan-${i}`, hash, 'passkey:Operator YubiKey', 'webauthn', at - 2 * MIN, at + 13 * MIN);
    const dur = 4000 + Math.floor(rand() * 40000);
    insOp.run(id, null, `demo-plan-${i}`, `demo-appr-${i}`, `demo-d-${i}`, 'run_device_powershell', 'device', target.id, status,
      status === 'accepted' ? null : JSON.stringify({ durationMs: dur, exitCode: status === 'failed' ? 1 : 0 }), rb, 1, at, at + dur);
    insEvt.run(id, 'accepted', at, '{}');
    if (status !== 'accepted') insEvt.run(id, status, at + dur, '{}');
  }

  // Two plans waiting for a human — the approval queue.
  for (const [i, rb, target] of [[900, 'maint/clear-print-spooler', devByName(2, 'NW-PRINT01')], [901, 'diag/disk-health', devByName(1, 'FS01')]]) {
    insPlan.run(`demo-plan-${i}`, null, 'run_device_powershell', 'device', target, JSON.stringify({ runbookId: rb }), randomBytes(16).toString('hex'), 'mcp:command', NOW - 6 * MIN, NOW + 9 * MIN);
  }

  // ── Rule findings raised on the collected evidence ─────────────────
  const insAnn = db.prepare("INSERT INTO infra_annotations (id, connection_id, org_id, entity_id, operation_id, kind, rule_id, rule_version, title, detail, evidence_json, status, author, created_at) VALUES (?,?,?,?,?,'finding',?,?,?,?,?,'open','rule',?)");
  const findings = [
    [1, 'dhcp-scope-exhaustion', 'Workstation scope 93% used', '14 free addresses left in 10.20.1.20–10.20.1.219.'],
    [1, 'dhcp-authorization-stale', 'AD DHCP authorization with no matching device', 'legacy-dhcp.contoso.local is authorized but no agent or DNS host matches.'],
    [1, 'gpo-unlinked', '2 GPOs linked nowhere', 'Legacy Mapped Drives, Old AV Deployment.'],
    [2, 'dhcp-public-dns', 'Guest scope hands out a public resolver', 'Option 6 on 10.30.2.0 includes 8.8.8.8.'],
    [2, 'dns-scavenging-off', 'DNS scavenging disabled', 'NW-DC01 does not age stale records.'],
    [3, 'single-dc', 'Single domain controller', 'FAB-DC01 is the only DC and DNS server.'],
  ];
  findings.forEach(([org, rule, title, detail], i) => insAnn.run(`demo-f${i}`, null, org, null, 'demo-op-collect', rule, 1, title, detail, '[]', NOW - 2 * HOUR));

  // ── Review Center: AI-proposed findings, questions, a decision ─────
  const review = new ReviewService(store);
  const items = [
    [1, 'risk', 'dhcp', 'Workstation DHCP scope is 93% full', 'high', 'high', 'New devices at Main Clinic will fail to get an address once the remaining 14 leases are used.'],
    [1, 'risk', 'ad', 'Retired DHCP server still authorized in AD', 'medium', 'high', 'legacy-dhcp.contoso.local is in the AD authorization list but no agent or DNS host matches it.'],
    [1, 'risk', 'infrastructure', 'Imaging server IMG01 offline for 2 days', 'high', 'high', 'X-ray imaging storage has not checked in since Tuesday; backups of that volume are not verified.'],
    [1, 'improvement', 'gpo', 'Two GPOs are not linked anywhere', 'low', 'high', '"Legacy Mapped Drives" and "Old AV Deployment" apply to no container; candidates for cleanup.'],
    [2, 'risk', 'dhcp', 'Guest Wi-Fi hands out a public DNS resolver', 'medium', 'medium', 'Option 6 on the guest scope includes 8.8.8.8, bypassing DNS filtering.'],
    [2, 'risk', 'dns', 'DNS scavenging disabled on NW-DC01', 'low', 'high', 'Stale A records accumulate and can resolve to reassigned addresses.'],
    [2, 'improvement', 'dhcp', 'Guest Wi-Fi scope at 91% during shift change', 'medium', 'medium', 'Consider shortening the lease or widening the scope.'],
    [3, 'observation', 'infrastructure', 'Single domain controller', 'medium', 'high', 'FAB-DC01 holds all FSMO roles and is the only DNS server; no failover.'],
    [3, 'risk', 'lifecycle', 'DHCP inventory incomplete', 'low', 'medium', 'The last DHCP collection was partial; utilization is not claimed until a complete run.'],
  ];
  const created = items.map(([org, type, category, title, severity, confidence, summary], i) =>
    review.proposeItem({ orgId: org, itemType: type, category, title, summary, severity, confidence, sourceKind: i % 3 ? 'rule' : 'ai', actor: i % 3 ? undefined : 'claude',
      provenance: 'system', questions: i === 1 ? [{ question: 'Was legacy-dhcp decommissioned intentionally?', whyItMatters: 'If it can come back online it could hand out conflicting leases.', answerType: 'yes_no_unknown' }] : i === 7 ? [{ question: 'Is a second DC planned for Fabrikam?', whyItMatters: 'Determines whether this is accepted risk or a project.' }] : undefined }).item);
  review.addQuestion(1, { itemId: created[0].id, question: 'Is the Eastside Clinic expansion adding more workstations this quarter?', whyItMatters: 'Decides between widening the scope and shortening lease time.' }, { kind: 'ai', name: 'claude' });
  review.recordDecision(1, created[3].id, { disposition: 'pursue_improvement', rationale: 'Remove both GPOs in the next maintenance window.', owner: 'ops', actorKind: 'human_ui', actor: 'operator', provenance: 'direct' });

  db.close?.();
  return devices.length;
}

if (args.has('--reset') || !existsSync(DB_PATH)) {
  const count = seed();
  console.log(`Seeded demo tenant: 3 organizations, ${count} devices → ${DB_PATH}`);
}
if (args.has('--seed-only')) process.exit(0);

const token = randomBytes(24).toString('hex');
// Sandbox the server's home so the demo never reads or writes real tokens,
// connection manifests, or MCP client configs.
const home = join(DEMO_DIR, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --no-warnings`.trim(),
  NINJA_DB_PATH: DB_PATH,
  NINJA_SERVE_TOKEN: token,
  NINJA_SERVE_PORT: String(PORT),
  NINJA_AUTH_PROFILE: 'reporting',
  NINJA_BASE_URL: 'https://demo.invalid',
  NINJA_POLICY_PATH: join(ROOT, 'config', 'policy.example.json'),
  NINJA_SYNC_INTERVAL_MINUTES: '0',
  NINJA_RECONCILE_TICK_MS: '0',
  NINJA_SCHEDULE_TICK_MS: '2000000000',
  NINJA_DEMO: '1',
};
const child = spawn(process.execPath, [join(ROOT, 'dist', 'serve.js')], { env, cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
// Keep the console readable: only real errors, not config/deprecation chatter.
child.stderr.on('data', (d) => {
  const text = String(d).split('\n').filter((l) => l.trim() && !/not fully configured|Deprecation|serve\.token written/.test(l)).join('\n');
  if (text) process.stderr.write(text + '\n');
});
const url = `http://localhost:${PORT}/?token=${token}`;
if (process.env.DEMO_TOKEN_FILE) (await import('node:fs')).writeFileSync(process.env.DEMO_TOKEN_FILE, token);
setTimeout(() => {
  console.log(`\n  Mission Control demo → ${url}\n  (fictional data · read-only · Ctrl+C to stop)\n`);
  if (!args.has('--no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
}, 1500);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
