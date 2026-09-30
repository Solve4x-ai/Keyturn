/**
 * Local SQLite storage via node:sqlite (Node >= 22.13).
 *
 * Stores entity metadata (names, IDs, state), change history, saved filters,
 * and the operation journal. Never stores tokens, env values, or secrets.
 * One database per tenant, shared by both profiles; WAL mode allows the
 * reporting and command processes to read/write concurrently.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 16;

const SECRET_KEY_PATTERN = /token|secret|password|apikey|api_key|private|credential|authorization|authcode|refresh/i;
const MAX_STORED_STRING = 2000;

export function tenantKeyFromBaseUrl(baseUrl: string): string {
  let host = baseUrl.trim().toLowerCase();
  try {
    host = new URL(host).host;
  } catch {
    host = host.replace(/^https?:\/\//, '').split('/')[0] || host;
  }
  const sanitized = host.replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-');
  return sanitized || 'default';
}

export function resolveDatabasePath(baseUrl: string | null): string {
  const override = (process.env.NINJA_DB_PATH || '').trim();
  if (override) return override;
  const key = tenantKeyFromBaseUrl(baseUrl || 'default');
  return join(homedir(), '.ninjaone-mcp', 'data', `${key}.db`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities_org (
  org_id INTEGER PRIMARY KEY,
  name TEXT,
  description TEXT,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entities_location (
  org_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  name TEXT,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, location_id)
);
CREATE TABLE IF NOT EXISTS entities_policy (
  policy_id INTEGER PRIMARY KEY,
  name TEXT,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entities_device (
  device_id INTEGER PRIMARY KEY,
  system_name TEXT,
  display_name TEXT,
  dns_name TEXT,
  org_id INTEGER,
  location_id INTEGER,
  node_class TEXT,
  offline INTEGER,
  last_contact INTEGER,
  name_norm TEXT,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_norm ON entities_device (name_norm);
CREATE INDEX IF NOT EXISTS idx_device_org ON entities_device (org_id);
CREATE INDEX IF NOT EXISTS idx_device_sysname ON entities_device (system_name);
CREATE INDEX IF NOT EXISTS idx_device_dispname ON entities_device (display_name);
CREATE TABLE IF NOT EXISTS sync_state (
  entity_type TEXT PRIMARY KEY,
  last_sync_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  detected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON entity_changes (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_changes_time ON entity_changes (detected_at);
CREATE TABLE IF NOT EXISTS saved_filters (
  name TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  profile TEXT NOT NULL,
  connection_id TEXT,
  tool TEXT NOT NULL,
  args_redacted TEXT,
  target_device_id INTEGER,
  target_org_id INTEGER,
  dry_run INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  plan_id TEXT,
  operation_id TEXT,
  runbook_id TEXT,
  runbook_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_journal_time ON operation_journal (ts);
CREATE INDEX IF NOT EXISTS idx_journal_operation ON operation_journal (operation_id);
CREATE INDEX IF NOT EXISTS idx_journal_plan ON operation_journal (plan_id);
-- Self-describing identity record: which local connection owns this file.
CREATE TABLE IF NOT EXISTS connection_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  connection_id TEXT,
  api_origin TEXT,
  created_at INTEGER NOT NULL
);
-- M4: durable plans, trusted approvals, operations, and append-only events.
CREATE TABLE IF NOT EXISTS operation_plans (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  args_canonical TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  plan_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  approval_id TEXT NOT NULL REFERENCES operation_approvals(id),
  dedupe_key TEXT UNIQUE NOT NULL,
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  upstream_ref TEXT,
  result_json TEXT,
  session_id TEXT,
  runbook_id TEXT,
  runbook_version INTEGER,
  target_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_targets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  device_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  upstream_ref TEXT,
  result_json TEXT,
  safe_error TEXT,
  canary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_optargets_op ON operation_targets (operation_id, status);
-- M5B frozen selections: explicitly materialized device sets; member ids
-- are the frozen truth — re-evaluating a filter creates a NEW selection.
CREATE TABLE IF NOT EXISTS selections (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  creator TEXT,
  entity_type TEXT NOT NULL DEFAULT 'device',
  source_query_json TEXT NOT NULL,
  org_id INTEGER,
  member_ids_json TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  exclusions_json TEXT,
  evaluated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sel_org ON selections (org_id, created_at);
CREATE TABLE IF NOT EXISTS operation_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_events ON operation_events (operation_id);
-- M4 sessions: one approval opens a bounded per-device PowerShell session
-- for chained stdio commands (frozen device, expiry, command cap).
CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  approval_id TEXT NOT NULL REFERENCES operation_approvals(id),
  status TEXT NOT NULL DEFAULT 'open',
  max_commands INTEGER NOT NULL,
  commands_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON device_sessions (device_id, status);
-- M4.5: capture runs, per-resource observations, deduplicated canonical
-- payloads, sealed snapshot manifests, comparisons, and read-only schedules.
CREATE TABLE IF NOT EXISTS device_capture_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'on_demand',
  profile TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  slot_key TEXT UNIQUE,
  schedule_id TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  safe_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  heartbeat_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_resource_observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES device_capture_runs(id),
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  collector_version INTEGER NOT NULL DEFAULT 1,
  adapter_version INTEGER NOT NULL DEFAULT 1,
  source_endpoint TEXT,
  fetched_at INTEGER NOT NULL,
  source_observed_at INTEGER,
  collection_status TEXT NOT NULL,
  completeness TEXT NOT NULL DEFAULT 'unknown',
  item_count INTEGER,
  returned_count INTEGER,
  pages_fetched INTEGER NOT NULL DEFAULT 1,
  payload_id TEXT,
  safe_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_device ON device_resource_observations (device_id, resource_type, fetched_at);
CREATE TABLE IF NOT EXISTS device_resource_payloads (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  resource_type TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payload_dedupe ON device_resource_payloads (connection_id, resource_type, id);
CREATE TABLE IF NOT EXISTS device_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  capture_run_id TEXT NOT NULL REFERENCES device_capture_runs(id),
  profile TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'on_demand',
  coverage_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  sealed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_device ON device_snapshots (device_id, sealed_at);
CREATE TABLE IF NOT EXISTS device_snapshot_resources (
  snapshot_id TEXT NOT NULL REFERENCES device_snapshots(id),
  resource_type TEXT NOT NULL,
  observation_id TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, resource_type)
);
CREATE TABLE IF NOT EXISTS capture_schedules (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  name TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  profile TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  window_hhmm TEXT NOT NULL DEFAULT '02:00',
  budget_requests INTEGER NOT NULL DEFAULT 500,
  enabled INTEGER NOT NULL DEFAULT 1,
  policy_version INTEGER NOT NULL DEFAULT 1,
  last_slot TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_comparisons (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  baseline_id TEXT NOT NULL REFERENCES device_snapshots(id),
  comparison_id TEXT NOT NULL REFERENCES device_snapshots(id),
  diff_version INTEGER NOT NULL DEFAULT 1,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cmp_key ON snapshot_comparisons (baseline_id, comparison_id, diff_version);
-- INFRA-1: evidence history + rebuildable current projection for
-- organization infrastructure (domains, DCs, DNS, DHCP, GPO). Raw receipts
-- stay immutable in operations; extracted facts carry provenance links.
CREATE TABLE IF NOT EXISTS infra_entities (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  namespace TEXT NOT NULL,
  category TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  display_name TEXT,
  aliases_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source_device_id INTEGER,
  UNIQUE (connection_id, org_id, category, namespace, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_infra_entities_scope ON infra_entities (org_id, category, namespace);
CREATE TABLE IF NOT EXISTS collection_coverage (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  operation_id TEXT NOT NULL,
  target_seq INTEGER,
  runbook_id TEXT,
  runbook_version INTEGER,
  source_device_id INTEGER,
  namespace TEXT,
  section TEXT NOT NULL,
  status TEXT NOT NULL,
  completeness TEXT,
  enumerated_count INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  collected_at INTEGER,
  ingested_at INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverage_op ON collection_coverage (operation_id, section);
CREATE INDEX IF NOT EXISTS idx_coverage_scope ON collection_coverage (org_id, namespace, section, collected_at);
CREATE TABLE IF NOT EXISTS entity_observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES infra_entities(id),
  coverage_id TEXT NOT NULL REFERENCES collection_coverage(id),
  attrs_json TEXT NOT NULL,
  field_presence_json TEXT,
  observed_at INTEGER,
  collected_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eobs_entity ON entity_observations (entity_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_eobs_op ON entity_observations (operation_id);
CREATE TABLE IF NOT EXISTS relationship_observations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  attrs_json TEXT,
  coverage_id TEXT NOT NULL REFERENCES collection_coverage(id),
  observed_at INTEGER,
  collected_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relobs_from ON relationship_observations (from_entity_id, rel_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_relobs_to ON relationship_observations (to_entity_id, rel_type);
CREATE TABLE IF NOT EXISTS infra_current (
  entity_id TEXT PRIMARY KEY REFERENCES infra_entities(id),
  attrs_json TEXT NOT NULL,
  last_coverage_id TEXT,
  last_operation_id TEXT,
  observed_at INTEGER,
  collected_at INTEGER,
  status TEXT NOT NULL DEFAULT 'observed',
  conflicting INTEGER NOT NULL DEFAULT 0,
  conflict_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  target_seq INTEGER,
  runbook_id TEXT,
  extractor_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingestion_status ON ingestion_jobs (status, created_at);
CREATE TABLE IF NOT EXISTS infra_annotations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  entity_id TEXT,
  operation_id TEXT,
  kind TEXT NOT NULL,
  rule_id TEXT,
  rule_version INTEGER,
  title TEXT NOT NULL,
  detail TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  author TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_infra_ann_org ON infra_annotations (org_id, kind, status);
`;

/**
 * v1 → v2 (additive only): journal gains connection_id; connection_meta is
 * created. raw_json columns are RETAINED — dropping them is deferred, but
 * entity-store no longer populates them (persistence allowlist, invariant 10).
 */
const MIGRATION_2 = `
ALTER TABLE operation_journal ADD COLUMN connection_id TEXT;
CREATE TABLE IF NOT EXISTS connection_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  connection_id TEXT,
  api_origin TEXT,
  created_at INTEGER NOT NULL
);
`;

export interface ConnectionBinding {
  connectionId?: string | undefined;
  apiOrigin?: string | undefined;
}

export function openDatabase(dbPath: string, binding?: ConnectionBinding): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    migrate(db);
    bindConnection(db, binding);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Write or verify the self-describing connection_meta row. When a bound
 * connection opens a file stamped for a different connection, the open
 * fails closed — two tenants can never share one database by accident.
 * Unbound opens (NINJA_DB_PATH, :memory:) skip binding entirely.
 */
function bindConnection(db: DatabaseSync, binding?: ConnectionBinding): void {
  if (!binding?.connectionId) return;
  const row = db
    .prepare('SELECT connection_id FROM connection_meta WHERE id = 1')
    .get() as { connection_id: string | null } | undefined;
  if (!row) {
    db.prepare(
      'INSERT INTO connection_meta (id, connection_id, api_origin, created_at) VALUES (1, ?, ?, ?)',
    ).run(binding.connectionId, binding.apiOrigin ?? null, Date.now());
    return;
  }
  if (row.connection_id !== binding.connectionId) {
    throw new Error(
      `Database belongs to connection ${row.connection_id}; refusing to open it as ${binding.connectionId}. ` +
        'Check connections.json or NINJA_CONNECTION_ID.',
    );
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = Number(row?.user_version ?? 0);
  if (version < 1) {
    db.exec(SCHEMA);
    // SCHEMA predates MIGRATION_12/13 (review tables + triage scoring); fold
    // them into the fresh-install path so new databases get the full surface.
    db.exec(MIGRATION_12);
    db.exec(MIGRATION_13);
    db.exec(MIGRATION_15);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (version < 2) {
    db.exec(MIGRATION_2);
    db.exec('PRAGMA user_version = 2');
  }
  if (version < 3) {
    db.exec(MIGRATION_3);
    db.exec('PRAGMA user_version = 3');
  }
  if (version < 4) {
    db.exec(MIGRATION_4);
    db.exec('PRAGMA user_version = 4');
  }
  if (version < 5) {
    db.exec(MIGRATION_5);
    db.exec('PRAGMA user_version = 5');
  }
  if (version < 6) {
    db.exec(MIGRATION_6);
    db.exec('PRAGMA user_version = 6');
  }
  if (version < 7) {
    db.exec(MIGRATION_7);
    db.exec('PRAGMA user_version = 7');
  }
  if (version < 8) {
    db.exec(MIGRATION_8);
    db.exec('PRAGMA user_version = 8');
  }
  if (version < 9) {
    db.exec(MIGRATION_9);
    db.exec('PRAGMA user_version = 9');
  }
  if (version < 10) {
    db.exec(MIGRATION_10);
    db.exec('PRAGMA user_version = 10');
  }
  if (version < 11) {
    db.exec(MIGRATION_11);
    db.exec('PRAGMA user_version = 11');
  }
  if (version < 12) {
    db.exec(MIGRATION_12);
    db.exec('PRAGMA user_version = 12');
  }
  if (version < 13) {
    db.exec(MIGRATION_13);
    db.exec('PRAGMA user_version = 13');
  }
  if (version < 14) {
    db.exec(MIGRATION_14);
    db.exec('PRAGMA user_version = 14');
  }
  if (version < 15) {
    db.exec(MIGRATION_15);
    db.exec('PRAGMA user_version = 15');
  }
  if (version < 16) {
    db.exec(MIGRATION_16);
    db.exec('PRAGMA user_version = 16');
  }
}

/** v2 → v3 (additive): indexed normalized device-name search column. */
const MIGRATION_3 = `
ALTER TABLE entities_device ADD COLUMN name_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_device_norm ON entities_device (name_norm);
`;

/**
 * v3 → v4 (additive): persistent investigations — durable scoped work units
 * with evidence snapshots and a last-seen change watermark (§16.1/16.2).
 * Snapshots are allowlisted field maps, never raw upstream blobs.
 */
const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  title TEXT NOT NULL,
  org_id INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS investigation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'entity',
  snapshot_json TEXT,
  note TEXT,
  captured_at INTEGER NOT NULL,
  watermark_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inv_items ON investigation_items (investigation_id);
`;

/** v4 → v5 (additive): M4 durable plans, approvals, operations, events. */
const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS operation_plans (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  args_canonical TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  plan_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  approval_id TEXT NOT NULL REFERENCES operation_approvals(id),
  dedupe_key TEXT UNIQUE NOT NULL,
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  upstream_ref TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_events ON operation_events (operation_id);
`;

/**
 * v5 → v6 (additive): per-device PowerShell sessions for chained stdio
 * commands after one trusted approval; operations gain session_id.
 */
const MIGRATION_6 = `
ALTER TABLE operations ADD COLUMN session_id TEXT;
CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL REFERENCES operation_plans(id),
  approval_id TEXT NOT NULL REFERENCES operation_approvals(id),
  status TEXT NOT NULL DEFAULT 'open',
  max_commands INTEGER NOT NULL,
  commands_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON device_sessions (device_id, status);
`;

/**
 * v6 → v7 (additive): M4.5 capture runs, resource observations, deduplicated
 * canonical payloads, sealed snapshot manifests, comparisons, schedules, and
 * exact-version investigation pins (snapshot_ref).
 */
const MIGRATION_7 = `
ALTER TABLE investigation_items ADD COLUMN snapshot_ref TEXT;
CREATE TABLE IF NOT EXISTS device_capture_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'on_demand',
  profile TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  slot_key TEXT UNIQUE,
  schedule_id TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  safe_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_resource_observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES device_capture_runs(id),
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  collector_version INTEGER NOT NULL DEFAULT 1,
  source_endpoint TEXT,
  fetched_at INTEGER NOT NULL,
  source_observed_at INTEGER,
  collection_status TEXT NOT NULL,
  completeness TEXT NOT NULL DEFAULT 'unknown',
  item_count INTEGER,
  returned_count INTEGER,
  pages_fetched INTEGER NOT NULL DEFAULT 1,
  payload_id TEXT,
  safe_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_device ON device_resource_observations (device_id, resource_type, fetched_at);
CREATE TABLE IF NOT EXISTS device_resource_payloads (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  resource_type TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payload_dedupe ON device_resource_payloads (connection_id, resource_type, id);
CREATE TABLE IF NOT EXISTS device_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  device_id INTEGER NOT NULL,
  capture_run_id TEXT NOT NULL REFERENCES device_capture_runs(id),
  profile TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'on_demand',
  coverage_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  sealed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_device ON device_snapshots (device_id, sealed_at);
CREATE TABLE IF NOT EXISTS device_snapshot_resources (
  snapshot_id TEXT NOT NULL REFERENCES device_snapshots(id),
  resource_type TEXT NOT NULL,
  observation_id TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, resource_type)
);
CREATE TABLE IF NOT EXISTS capture_schedules (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  name TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  profile TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  window_hhmm TEXT NOT NULL DEFAULT '02:00',
  budget_requests INTEGER NOT NULL DEFAULT 500,
  enabled INTEGER NOT NULL DEFAULT 1,
  policy_version INTEGER NOT NULL DEFAULT 1,
  last_slot TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_comparisons (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  baseline_id TEXT NOT NULL REFERENCES device_snapshots(id),
  comparison_id TEXT NOT NULL REFERENCES device_snapshots(id),
  diff_version INTEGER NOT NULL DEFAULT 1,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cmp_key ON snapshot_comparisons (baseline_id, comparison_id, diff_version);
`;

/**
 * v7 → v8 (additive):
 * - observations.adapter_version — per-resource adapter field-set version, so
 *   comparisons can normalize compatible versions instead of reporting schema
 *   additions as endpoint changes.
 * - runs.heartbeat_at — capture worker liveness, so crashed runs can be
 *   terminated honestly without killing a healthy in-flight capture.
 */
const MIGRATION_8 = `
ALTER TABLE device_resource_observations ADD COLUMN adapter_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE device_capture_runs ADD COLUMN heartbeat_at INTEGER;
`;

/**
 * v8 → v9 (additive): report-ready evidence links (plan §11).
 * - journal gains plan/operation/runbook refs so a report can join an
 *   attempt to its plan, approval lineage, and runbook version.
 * - operations gains denormalized runbook_id/runbook_version (the plan's
 *   canonical args remain authoritative; these columns make report and
 *   list queries not need JSON extraction).
 */
const MIGRATION_9 = `
ALTER TABLE operation_journal ADD COLUMN plan_id TEXT;
ALTER TABLE operation_journal ADD COLUMN operation_id TEXT;
ALTER TABLE operation_journal ADD COLUMN runbook_id TEXT;
ALTER TABLE operation_journal ADD COLUMN runbook_version INTEGER;
ALTER TABLE operations ADD COLUMN runbook_id TEXT;
ALTER TABLE operations ADD COLUMN runbook_version INTEGER;
CREATE INDEX IF NOT EXISTS idx_journal_operation ON operation_journal (operation_id);
CREATE INDEX IF NOT EXISTS idx_journal_plan ON operation_journal (plan_id);
`;

/**
 * v9 → v10 (additive): M5B frozen selections + batch per-target lifecycle.
 * - selections: an explicitly materialized device set — member ids are the
 *   frozen truth; re-evaluating a filter makes a NEW selection.
 * - operation_targets: per-device lifecycle under a parent batch operation.
 * - operations.target_count: conserved count for honest partial outcomes.
 */
const MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS selections (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  creator TEXT,
  entity_type TEXT NOT NULL DEFAULT 'device',
  source_query_json TEXT NOT NULL,
  org_id INTEGER,
  member_ids_json TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  exclusions_json TEXT,
  evaluated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sel_org ON selections (org_id, created_at);
CREATE TABLE IF NOT EXISTS operation_targets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  device_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  upstream_ref TEXT,
  result_json TEXT,
  safe_error TEXT,
  canary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_optargets_op ON operation_targets (operation_id, status);
ALTER TABLE operations ADD COLUMN target_count INTEGER;
`;

/**
 * v10 → v11 (additive): INFRA-1 knowns — evidence history + rebuildable
 * current projection (plan §5). Raw receipts stay immutable in operations;
 * these tables hold extracted, typed, provenance-linked infrastructure facts.
 */
const MIGRATION_11 = `
CREATE TABLE IF NOT EXISTS infra_entities (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  namespace TEXT NOT NULL,
  category TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  display_name TEXT,
  aliases_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source_device_id INTEGER,
  UNIQUE (connection_id, org_id, category, namespace, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_infra_entities_scope ON infra_entities (org_id, category, namespace);
CREATE TABLE IF NOT EXISTS collection_coverage (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  operation_id TEXT NOT NULL,
  target_seq INTEGER,
  runbook_id TEXT,
  runbook_version INTEGER,
  source_device_id INTEGER,
  namespace TEXT,
  section TEXT NOT NULL,
  status TEXT NOT NULL,
  completeness TEXT,
  enumerated_count INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  collected_at INTEGER,
  ingested_at INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverage_op ON collection_coverage (operation_id, section);
CREATE INDEX IF NOT EXISTS idx_coverage_scope ON collection_coverage (org_id, namespace, section, collected_at);
CREATE TABLE IF NOT EXISTS entity_observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES infra_entities(id),
  coverage_id TEXT NOT NULL REFERENCES collection_coverage(id),
  attrs_json TEXT NOT NULL,
  field_presence_json TEXT,
  observed_at INTEGER,
  collected_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eobs_entity ON entity_observations (entity_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_eobs_op ON entity_observations (operation_id);
CREATE TABLE IF NOT EXISTS relationship_observations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  attrs_json TEXT,
  coverage_id TEXT NOT NULL REFERENCES collection_coverage(id),
  observed_at INTEGER,
  collected_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relobs_from ON relationship_observations (from_entity_id, rel_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_relobs_to ON relationship_observations (to_entity_id, rel_type);
CREATE TABLE IF NOT EXISTS infra_current (
  entity_id TEXT PRIMARY KEY REFERENCES infra_entities(id),
  attrs_json TEXT NOT NULL,
  last_coverage_id TEXT,
  last_operation_id TEXT,
  observed_at INTEGER,
  collected_at INTEGER,
  status TEXT NOT NULL DEFAULT 'observed',
  conflicting INTEGER NOT NULL DEFAULT 0,
  conflict_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_infra_current_entity ON infra_current (entity_id);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  target_seq INTEGER,
  runbook_id TEXT,
  extractor_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingestion_status ON ingestion_jobs (status, created_at);
CREATE TABLE IF NOT EXISTS infra_annotations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER,
  entity_id TEXT,
  operation_id TEXT,
  kind TEXT NOT NULL,
  rule_id TEXT,
  rule_version INTEGER,
  title TEXT NOT NULL,
  detail TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  author TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_infra_ann_org ON infra_annotations (org_id, kind, status);
`;

/**
 * v11 → v12 (additive): REVIEW-1 — organization Review Center. Durable
 * review items (observation/risk/improvement) with versioned revisions,
 * append-only events, validated evidence links, first-class questions and
 * attributed answers, human org annotations, decisions, suppressions, and
 * operation links. Local collaboration state only — no row here can
 * authorize or dispatch an endpoint action.
 */
const MIGRATION_12 = `
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  item_type TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  workflow TEXT NOT NULL DEFAULT 'new',
  assessment TEXT NOT NULL DEFAULT 'unassessed',
  disposition TEXT NOT NULL DEFAULT 'none',
  review_state TEXT NOT NULL DEFAULT 'current',
  impact TEXT,
  urgency TEXT,
  subject_json TEXT,
  canonical_item_id TEXT,
  supersedes_item_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_by_kind TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due_at INTEGER,
  closed_at INTEGER,
  UNIQUE (connection_id, org_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_review_items_org ON review_items (org_id, workflow, disposition);
CREATE INDEX IF NOT EXISTS idx_review_items_due ON review_items (org_id, due_at);
CREATE TABLE IF NOT EXISTS review_item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES review_items(id),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  rationale TEXT,
  consequence TEXT,
  knowns_unknowns TEXT,
  proposed_impact TEXT,
  proposed_urgency TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  source_version TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (item_id, revision)
);
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES review_items(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT,
  provenance TEXT NOT NULL,
  payload_json TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_events_item ON review_events (item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_events_org ON review_events (org_id, event_type, created_at);
CREATE TABLE IF NOT EXISTS review_evidence_links (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES review_items(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  link_type TEXT NOT NULL,
  entity_id TEXT,
  observation_id TEXT,
  operation_id TEXT,
  annotation_id TEXT,
  field_path TEXT,
  note TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_links_item ON review_evidence_links (item_id);
CREATE TABLE IF NOT EXISTS review_questions (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES review_items(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  why_it_matters TEXT,
  answer_type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'open',
  created_by_kind TEXT NOT NULL,
  created_by TEXT,
  superseded_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_questions_org ON review_questions (org_id, status);
CREATE TABLE IF NOT EXISTS review_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES review_questions(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  answer_text TEXT NOT NULL,
  normalized_json TEXT,
  actor_kind TEXT NOT NULL,
  actor TEXT,
  provenance TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  conflicts_with TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_answers_q ON review_answers (question_id, created_at);
CREATE TABLE IF NOT EXISTS org_annotations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  annotation_type TEXT NOT NULL,
  subject_json TEXT,
  text TEXT NOT NULL,
  attribution TEXT NOT NULL,
  actor TEXT,
  source_note TEXT,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_ann ON org_annotations (org_id, annotation_type);
CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES review_items(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT,
  owner TEXT,
  scope_note TEXT,
  review_due_at INTEGER,
  evidence_basis_json TEXT,
  actor_kind TEXT NOT NULL,
  actor TEXT,
  provenance TEXT NOT NULL,
  superseded_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_decisions_item ON review_decisions (item_id, created_at);
CREATE TABLE IF NOT EXISTS review_suppressions (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_supp_org ON review_suppressions (org_id);
CREATE TABLE IF NOT EXISTS review_item_ops (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES review_items(id),
  connection_id TEXT,
  org_id INTEGER NOT NULL,
  operation_id TEXT,
  plan_id TEXT,
  link_kind TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_ops_item ON review_item_ops (item_id);
`;

// Structured triage: severity (how bad if true) × confidence (how sure the
// evidence is) → priority_score drives inbox ordering. Free-text
// impact/urgency remain as assessor overrides; these are the ranked fields.
const MIGRATION_13 = `
ALTER TABLE review_items ADD COLUMN severity TEXT;
ALTER TABLE review_items ADD COLUMN confidence TEXT;
ALTER TABLE review_items ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_item_revisions ADD COLUMN proposed_severity TEXT;
ALTER TABLE review_item_revisions ADD COLUMN proposed_confidence TEXT;
CREATE INDEX IF NOT EXISTS idx_review_items_score ON review_items (org_id, priority_score DESC);
`;

// v13 → v14 (destructive, scoped): retire Investigations — superseded by the
// Review Center evidence-link model; pin workflow + pinned items removed.
const MIGRATION_14 = `
DROP TABLE IF EXISTS investigation_items;
DROP TABLE IF EXISTS investigations;
`;

// v14 → v15 (additive): human-presence approvals. Approver passkeys
// (WebAuthn credentials — hardware keys or password-manager passkeys),
// single-use challenges bound to a plan hash, and per-approval assertion
// evidence so an approval row can be re-verified against its public key.
const MIGRATION_15 = `
CREATE TABLE IF NOT EXISTS approver_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  aaguid TEXT,
  backup_eligible INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  plan_id TEXT,
  plan_hash TEXT,
  subject TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
ALTER TABLE operation_approvals ADD COLUMN credential_id TEXT;
ALTER TABLE operation_approvals ADD COLUMN assertion_json TEXT;
`;

// v16: data correction. Extractor v1–v3 decoded Get-GPO GpoStatus as AD
// flags (0 = enabled) instead of the .NET enum it is (3 = AllSettingsEnabled),
// so every v1 annotation from the three GPO rules fired on the inverted
// condition. Retract them (system findings only — review items and their
// decisions are human records and are never rewritten here). Corrected v2
// rules re-fire on the next GPO collection only where the true condition holds.
const MIGRATION_16 = `
UPDATE infra_annotations
   SET status = 'retracted', reviewed_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE kind = 'finding' AND status = 'open'
   AND rule_id IN ('default-gpo-disabled', 'firewall-gpo-enabled', 'gpo-enabled-unlinked')
   AND COALESCE(rule_version, 1) < 2;
`;

/**
 * Deep-redact secret-shaped values from tool arguments before they are
 * persisted to the operation journal. Entity names and IDs are kept.
 */
export function redactArgs(value: unknown, depth: number = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STORED_STRING
      ? `${value.slice(0, MAX_STORED_STRING)}…[${value.length - MAX_STORED_STRING} more chars]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactArgs(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactArgs(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}
