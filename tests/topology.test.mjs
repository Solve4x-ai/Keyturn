// Infrastructure topology — structure and honesty semantics.
// FSMO holders come from held-by relationships; short-name/FQDN DC twins
// collapse into one card; DCs link to live agents by hostname; DHCP scope
// utilization is derived only from collected counts; "unlinked" GPOs are
// claimed only when link coverage is complete; dead AD authorizations are
// the ones with no matching device; org scoping holds.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../dist/storage.js';
import { EntityStore } from '../dist/entity-store.js';
import { buildInfraTopology } from '../dist/infra-topology.js';

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const ORG = 7;

function seed({ linksComplete = true } = {}) {
  const store = new EntityStore(openDatabase(':memory:'));
  const db = store.database;
  db.prepare('INSERT INTO entities_org (org_id, name, updated_at, seen_at) VALUES (?,?,?,?)').run(ORG, 'Clinic', NOW, NOW);
  const dev = db.prepare('INSERT INTO entities_device (device_id, system_name, dns_name, org_id, node_class, offline, last_contact, updated_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)');
  dev.run(10, 'DC1', 'dc1.clinic.local', ORG, 'WINDOWS_SERVER', 0, NOW / 1000, NOW, NOW);
  dev.run(11, 'DC2', 'dc2.clinic.local', ORG, 'WINDOWS_SERVER', 1, NOW / 1000, NOW, NOW);

  let n = 0;
  const ent = (category, key, name, attrs, { ns = 'domain:clinic.local', org = ORG, src = 10, status = 'observed' } = {}) => {
    const id = `e${++n}`;
    db.prepare('INSERT INTO infra_entities (id, connection_id, org_id, namespace, category, stable_key, display_name, first_seen_at, last_seen_at, source_device_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, null, org, ns, category, key, name, NOW, NOW, src);
    db.prepare('INSERT INTO infra_current (entity_id, attrs_json, status, conflicting, collected_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, JSON.stringify(attrs), status, 0, NOW, NOW);
    return id;
  };
  db.prepare("INSERT INTO collection_coverage (id, connection_id, org_id, operation_id, section, status, truncated, collected_at, ingested_at, extractor_version, source_device_id, runbook_id) VALUES ('c1', NULL, ?, 'op1', 'links', ?, 0, ?, ?, 1, 10, 'diag/gpo-inventory')")
    .run(ORG, linksComplete ? 'complete' : 'partial', NOW, NOW);
  let r = 0;
  const rel = (from, to, relType) => db.prepare('INSERT INTO relationship_observations (id, from_entity_id, to_entity_id, rel_type, coverage_id, collected_at, ingested_at, operation_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(`r${++r}`, from, to, relType, 'c1', NOW, NOW, 'op1');

  ent('forest', 'clinic.local', 'clinic.local', { name: 'clinic.local', forestMode: 'Windows2016Forest', siteCount: 1, globalCatalogCount: 2 });
  ent('domain', 'sid-1', 'clinic.local', { dnsRoot: 'clinic.local', netbios: 'CLINIC', domainMode: 'Windows2016Domain' });
  ent('site', 'hq', 'HQ', {});
  const dc1short = ent('domain-controller', 'dc1', 'DC1', {});
  const dc1 = ent('domain-controller', 'dc1.clinic.local', 'DC1.clinic.local', { host: 'DC1.clinic.local', ip: '10.0.0.10', os: 'Windows Server 2022', site: 'HQ', gc: true, rodc: false });
  ent('domain-controller', 'dc2.clinic.local', 'DC2.clinic.local', { host: 'DC2.clinic.local', ip: '10.0.0.11', site: 'HQ', gc: true });
  const pdc = ent('fsmo-role', 'pdc', 'pdc (domain)', { scope: 'domain' });
  const rid = ent('fsmo-role', 'rid', 'rid (domain)', { scope: 'domain' });
  rel(pdc, dc1short, 'held-by');
  rel(rid, dc1, 'held-by');

  const dhcpSrv = ent('dhcp-server', 'dc1.clinic.local', 'DC1.clinic.local', { authorizedInAd: true, authorizedServers: ['dc1.clinic.local', 'oldsbs.clinic.local'] }, { ns: 'ad' });
  ent('dhcp-server', 'oldsbs', 'oldsbs.clinic.local', { observedVia: 'ad-authorization-list' }, { ns: 'ad', src: null });
  const scope = ent('dhcp-scope', '10.0.0.0', 'Main (10.0.0.0)', { scopeId: '10.0.0.0', name: 'Main', state: 'Active', start: '10.0.0.50', end: '10.0.0.250', inUse: 150, free: 50, options: { 3: ['10.0.0.1'], 6: ['10.0.0.10', '10.0.0.10', '8.8.8.8'], 51: ['691200'] } }, { ns: 'dhcp-scope:10.0.0.0' });
  rel(dhcpSrv, scope, 'serves-scope');
  ent('dhcp-lease', '10.0.0.60', 'pc1 (10.0.0.60)', { ip: '10.0.0.60', hostName: 'pc1', scopeId: '10.0.0.0', state: 'Active' }, { ns: 'dhcp-scope:10.0.0.0' });
  ent('dhcp-reservation', '10.0.0.5', 'printer (10.0.0.5)', { ip: '10.0.0.5', name: 'printer', scopeId: '10.0.0.0' }, { ns: 'dhcp-scope:10.0.0.0' });

  // GpoStatus ordinals: 3 = AllSettingsEnabled, 0 = AllSettingsDisabled.
  const linked = ent('gpo', 'g1', 'Baseline', { gpoStatus: 3 });
  ent('gpo', 'g2', 'Leftover', { gpoStatus: 3 });
  ent('gpo', 'g3', 'Old RMM deploy', { gpoStatus: 0 });
  const ou = ent('container', 'ou', 'Workstations', { somPath: 'clinic.local/Workstations' });
  rel(linked, ou, 'links-to');

  // Another org's entity must never leak into this org's topology.
  ent('domain-controller', 'otherdc', 'OTHERDC', { host: 'OTHERDC' }, { org: 99 });
  return store;
}

describe('Infrastructure topology', () => {
  test('directory: FSMO via held-by, DC twins collapse, agents matched by hostname', () => {
    const t = buildInfraTopology(seed(), ORG);
    assert.equal(t.directory.dcs.length, 2, 'DC1 short-name twin collapses into the FQDN card; other org excluded');
    const dc1 = t.directory.dcs.find((d) => d.host.startsWith('DC1'));
    assert.deepEqual(dc1.fsmo, ['pdc', 'rid']);
    assert.equal(dc1.ip, '10.0.0.10', 'the richer twin record wins');
    assert.deepEqual(dc1.agent, { deviceId: 10, offline: false, lastContact: NOW / 1000 });
    assert.equal(t.directory.dcs.find((d) => d.host.startsWith('DC2')).agent.offline, true);
    assert.equal(t.directory.fsmo.find((f) => f.role === 'schema').holder, null, 'unobserved roles stay null');
    assert.equal(t.directory.forest.gcCount, 2);
  });

  test('dhcp: utilization from collected counts, options decoded, dead authorizations flagged', () => {
    const t = buildInfraTopology(seed(), ORG);
    const s = t.dhcp.servers[0];
    assert.equal(s.authorized, true);
    const z = s.scopes[0];
    assert.equal(z.pctUsed, 75);
    assert.deepEqual(z.dnsServers, ['10.0.0.10', '8.8.8.8'], 'duplicate DNS options deduped');
    assert.equal(z.leaseSeconds, 691200);
    assert.equal(z.leases, 1);
    assert.equal(z.reservations, 1);
    const dead = t.dhcp.authorizations.filter((a) => !a.agent).map((a) => a.host);
    assert.deepEqual(dead, ['oldsbs.clinic.local']);
  });

  test('gpo: unlinked only claimed with complete link coverage', () => {
    const complete = buildInfraTopology(seed(), ORG);
    assert.equal(complete.gpo.counts.unlinked, 2, 'Leftover (enabled) + Old RMM deploy (disabled) — both apply nowhere');
    assert.equal(complete.gpo.gpos.find((g) => g.name === 'Leftover').linked, false);
    assert.deepEqual(complete.gpo.containers[0].gpos, ['Baseline']);
    const partial = buildInfraTopology(seed({ linksComplete: false }), ORG);
    assert.equal(partial.gpo.counts.unlinked, null);
    assert.equal(partial.gpo.gpos.find((g) => g.name === 'Leftover').linked, null, 'unknown, not "unlinked"');
  });

  test('gpo status decodes the .NET GpoStatus enum (3 = enabled), not AD flags', async () => {
    const t = buildInfraTopology(seed(), ORG);
    const by = Object.fromEntries(t.gpo.gpos.map((g) => [g.name, g]));
    assert.equal(by.Baseline.enabled, 'enabled');
    assert.equal(by.Baseline.label, 'All settings enabled');
    assert.equal(by['Old RMM deploy'].enabled, 'disabled');
    assert.deepEqual([t.gpo.counts.enabled, t.gpo.counts.disabled], [2, 1]);
    const { gpoStatusCode, gpoStatusLabel, correctAttrs } = await import('../dist/infra.js');
    assert.equal(gpoStatusCode('AllSettingsEnabled'), 3, 'named values accepted');
    assert.equal(gpoStatusLabel(0), 'All settings disabled');
    assert.equal(correctAttrs('gpo', { gpoStatus: 3, statusLabel: 'All settings disabled' }).statusLabel, 'All settings enabled', 'stale stored label re-derived on read');
  });

  test('migration 16 retracts v1 GPO findings raised on the inverted decoding only', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const path = join(mkdtempSync(join(tmpdir(), 'mig16-')), 'db.sqlite');
    openDatabase(path).close();
    const raw = new DatabaseSync(path);
    const ins = raw.prepare("INSERT INTO infra_annotations (id, org_id, kind, rule_id, rule_version, title, status, created_at) VALUES (?, 2, 'finding', ?, ?, 't', 'open', 1)");
    ins.run('a1', 'firewall-gpo-enabled', 1);
    ins.run('a2', 'default-gpo-disabled', 2);
    ins.run('a3', 'dhcp-unauthorized', 1);
    raw.exec('PRAGMA user_version = 15');
    raw.close();
    const db = openDatabase(path);
    const st = Object.fromEntries(db.prepare('SELECT id, status FROM infra_annotations').all().map((r) => [r.id, r.status]));
    assert.deepEqual(st, { a1: 'retracted', a2: 'open', a3: 'open' });
    db.close();
  });

  test('empty org is reported as empty, not as healthy', () => {
    const t = buildInfraTopology(seed(), 12345);
    assert.equal(t.empty, true);
    assert.equal(t.directory.dcs.length, 0);
    assert.equal(t.lastCollected, null);
  });
});
