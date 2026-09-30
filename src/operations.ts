/**
 * M4 — durable plans, trusted approvals, and one safe write path.
 *
 * Slice delivered per authorization: a single low-risk operation
 * (`run_device_powershell` via the approved runner script), single target,
 * trusted UI approval, persist-before-dispatch, honest lifecycle states, and
 * one receipt. §13/§14 rules implemented here:
 *
 *  - Immutable plans: canonical args + sha256 hash; any edit = new plan.
 *  - Approvals: bound to plan_hash, 5-min expiry, single-consume (unique).
 *  - Persist-before-dispatch: operation + intent event committed in one
 *    transaction BEFORE any upstream call. Commit failure → no dispatch.
 *  - Fresh preflight (§5.5): target device is re-fetched upstream and its
 *    organization re-checked against policy immediately before dispatch.
 *  - accepted ≠ verified: reconciliation polls activities for the runner's
 *    S4X_RUNNER_RESULT block; unknown outcomes stay unknown.
 *  - Dedup: one operation per plan (unique dedupe_key) — re-execute returns
 *    the existing row, never a second dispatch.
 */
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { EntityStore } from './entity-store.js';
import { getRunbook, resolveRunbookScript, parseRunbookResult, RunbookError } from './runbooks.js';

/** Stable error codes for the harness-neutral contract (plan §6). */
export class OpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const PLAN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 10 * 60_000;
export const SESSION_MAX_COMMANDS = 5;

/**
 * NINJA_REQUIRE_PLAN_APPROVAL — default ON. When set to 0/false/no the
 * legacy stdio confirm:true path is restored (documented escape hatch).
 */
export function planApprovalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.NINJA_REQUIRE_PLAN_APPROVAL ?? '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/** Only this operation is dispatchable in the M4 slice. */
export const OPERATION_REGISTRY = {
  run_device_powershell: { targetType: 'device', risk: 'low' },
} as const;

export type OperationName = keyof typeof OPERATION_REGISTRY;

export interface OperationSecurity {
  profile: string;
  policy: {
    deviceScriptsEnabled?: boolean;
    powershellRunnerScriptId?: number | null;
    allowedOrganizationIds?: number[];
    powershellSessionTtlSeconds?: number | undefined;
    powershellSessionMaxCommands?: number | undefined;
  };
  principal?: { profile?: string; credentialKind?: string } | undefined;
}

export interface OperationApi {
  getDevice(id: number): Promise<any>;
  runDeviceScript(
    deviceId: number,
    body: { type?: string; id: number; runAs?: string; parameters?: string },
  ): Promise<any>;
  getDeviceActivities(id: number, pageSize?: number): Promise<any>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Transport encoding for the approved PowerShell runner channel.
 *
 * The runner receives the command as a single positional parameter
 * (UTF-16LE base64). Upstream transport (agent command line) has a hard
 * practical ceiling near 8K chars — v2 sectioned runbooks exceeded it and
 * the runner never started upstream (observed 2026-09-22: four v2
 * dispatches produced a generic failure line, no runner report, no runId).
 *
 * When the plain encoding exceeds PLAIN_PARAM_SAFE, the command is wrapped
 * in a deterministic self-inflating bootstrapper: gzip the UTF-8 source,
 * embed as base64, inflate + ScriptBlock-invoke on the endpoint.
 * $?/$LASTEXITCODE/exit semantics propagate unchanged through the child
 * envelope. The plan still binds the READABLE command; the wire form is a
 * pure function of it, and wireSha256 links to receipt commandSha256.
 */
const PLAIN_PARAM_SAFE = 4200;
const WIRE_PARAM_MAX = 7000;

export function transportEncodeCommand(command: string): {
  paramBase64: string;
  encoding: 'plain' | 'gzip-b64';
  wireSha256: string;
} {
  const plain = Buffer.from(command, 'utf16le').toString('base64');
  if (plain.length <= PLAIN_PARAM_SAFE) {
    return { paramBase64: plain, encoding: 'plain', wireSha256: createHash('sha256').update(command, 'utf8').digest('hex') };
  }
  const blob = gzipSync(Buffer.from(command, 'utf8'), { level: 9 }).toString('base64');
  const wire =
    `$__z=[Convert]::FromBase64String('${blob}');` +
    `$__gs=New-Object IO.Compression.GzipStream((New-Object IO.MemoryStream(,$__z)),[IO.Compression.CompressionMode]::Decompress);` +
    `$__ms=New-Object IO.MemoryStream;$__gs.CopyTo($__ms);$__gs.Close();` +
    `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($__ms.ToArray())))`;
  const packed = Buffer.from(wire, 'utf16le').toString('base64');
  if (packed.length > WIRE_PARAM_MAX) {
    throw new OpError(
      'invalid_params',
      `PowerShell command exceeds transport capacity (${packed.length} encoded chars, limit ${WIRE_PARAM_MAX}) even after compression — split the runbook`,
    );
  }
  return { paramBase64: packed, encoding: 'gzip-b64', wireSha256: createHash('sha256').update(wire, 'utf8').digest('hex') };
}

/**
 * Extract the runner's structured result from a device activity payload. Uses lastIndexOf so command output containing marker-like text cannot
 * shadow the authoritative result block.
 */
export function extractRunnerResult(activity: unknown, runId: string): Record<string, unknown> | null {
  const textValues: string[] = [];
  const collectText = (value: unknown, depth = 0): void => {
    if (depth > 8 || textValues.length > 500) return;
    if (typeof value === 'string') textValues.push(value);
    else if (Array.isArray(value)) for (const item of value) collectText(item, depth + 1);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collectText(item, depth + 1);
  };
  collectText(activity);

  let runnerResult: Record<string, unknown> | null = null;
  for (const value of textValues) {
    const begin = value.lastIndexOf('S4X_RUNNER_RESULT_BEGIN');
    const end = value.lastIndexOf('S4X_RUNNER_RESULT_END');
    if (begin < 0 || end <= begin) continue;
    const payload = value.slice(begin + 'S4X_RUNNER_RESULT_BEGIN'.length, end).trim();
    try {
      runnerResult = JSON.parse(payload) as Record<string, unknown>;
      break;
    } catch {
      runnerResult = null;
    }
  }
  if (!runnerResult || Number(runnerResult.schemaVersion) < 2) return runnerResult;

  const extractStream = (streamName: 'STDOUT' | 'STDERR'): string | null => {
    const beginMarker = `S4X_RUNNER_${streamName}_BEGIN:${runId}`;
    const endMarker = `S4X_RUNNER_${streamName}_END:${runId}`;
    for (const value of textValues) {
      const begin = value.lastIndexOf(beginMarker);
      if (begin < 0) continue;
      const contentStart = begin + beginMarker.length;
      const end = value.indexOf(endMarker, contentStart);
      if (end < contentStart) continue;
      const content = value.slice(contentStart, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      return content === '(none)' ? '' : content;
    }
    return null;
  };

  const stdout = extractStream('STDOUT');
  const stderr = extractStream('STDERR');
  return { ...runnerResult, stdout, stderr, streamsComplete: stdout !== null && stderr !== null };
}

/** Terminal NinjaOne activity — upstream finished (regardless of result recovery). */
function isTerminalActivity(activity: unknown): boolean {
  const a = activity as Record<string, unknown>;
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(String(a.statusCode)) || Boolean(a.activityResult);
}

/**
 * INFRA-1 K0 — terminal status from TRANSPORT outcome + COLLECTION outcome.
 * Transport: did the runner report failure / nonzero exit?
 * Collection: v2 runbooks emit collection.status = complete|partial|failed —
 * a validated aggregate of per-section results. The two are kept distinct:
 *   - exit≠0 + complete collection  → 'partial' (disagreement stays honest;
 *     unknown exits never silently become success)
 *   - clean exit + partial collection → 'partial' (measured incompletely)
 *   - collection failed               → 'failed' regardless of transport
 * v1 receipts (no collection block) keep the original verified/failed rule.
 */
export function deriveCollectionStatus(
  transportFailed: boolean,
  parsed: Record<string, unknown> | null,
): 'verified' | 'failed' | 'partial' {
  const coll = (parsed?.collection as Record<string, unknown> | undefined)?.status;
  if (coll === 'failed') return 'failed';
  if (coll === 'partial' || coll === 'unverified') return 'partial';
  if (transportFailed) return coll === 'complete' ? 'partial' : 'failed';
  return 'verified';
}

export class OperationService {
  private readonly store: EntityStore;
  private readonly api: OperationApi;
  private readonly security: OperationSecurity;

  constructor(store: EntityStore, api: OperationApi, security: OperationSecurity) {
    this.store = store;
    this.api = api;
    this.security = security;
  }

  private get db() {
    return this.store.database;
  }

  private event(operationId: string, kind: string, data?: unknown): void {
    this.db
      .prepare('INSERT INTO operation_events (operation_id, kind, at, data_json) VALUES (?, ?, ?, ?)')
      .run(operationId, kind, Date.now(), data === undefined ? null : JSON.stringify(data));
  }

  /**
   * INFRA-1 K1 — enqueue durable ingestion for a terminal receipt.
   * Idempotent on (operation_id, target_seq, extractor_version): reconcile
   * re-runs and restarts can never inflate observation counts. Extraction
   * itself happens outside this transaction in the ingestion worker.
   */
  private enqueueIngestion(operationId: string, targetSeq: number | null, runbookId: string | null): void {
    if (!runbookId) return;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ingestion_jobs (id, operation_id, target_seq, runbook_id, extractor_version, idempotency_key, status, attempts, created_at)
           VALUES (?, ?, ?, ?, 1, ?, 'pending', 0, ?)`,
        )
        .run(randomUUID(), operationId, targetSeq, runbookId, `${operationId}:${targetSeq ?? 'op'}`, Date.now());
    } catch {
      // Ingestion is best-effort around the receipt path — a missing table
      // (pre-migration DB) must never break reconciliation.
    }
  }

  private requireSupported(operation: string): void {
    if (!(operation in OPERATION_REGISTRY)) {
      throw new Error(`operation_not_supported: only [${Object.keys(OPERATION_REGISTRY).join(', ')}] is dispatchable in this release`);
    }
  }

  /**
   * Journal an operation-lifecycle event with report-ready evidence links
   * (plan §11): plan/operation/runbook refs travel on the journal row.
   */
  private journalOp(input: {
    operationId?: string | undefined;
    planId?: string | undefined;
    status: 'ok' | 'error' | 'blocked' | 'partial';
    error?: unknown;
    args?: unknown;
  }): void {
    try {
      let runbookId: string | null = null;
      let runbookVersion: number | null = null;
      let targetDeviceId: number | null = null;
      if (input.planId) {
        const plan = this.db.prepare('SELECT args_canonical, target_id, target_type FROM operation_plans WHERE id = ?').get(input.planId) as Record<string, unknown> | undefined;
        if (plan) {
          const args = JSON.parse(String(plan.args_canonical));
          runbookId = args?.runbook?.id ?? null;
          runbookVersion = args?.runbook?.version ?? null;
          if (plan.target_type === 'device') targetDeviceId = Number(plan.target_id);
        }
      }
      if (!targetDeviceId && input.operationId) {
        const op = this.db.prepare('SELECT target_id, target_type FROM operations WHERE id = ?').get(input.operationId) as Record<string, unknown> | undefined;
        if (op?.target_type === 'device') targetDeviceId = Number(op.target_id);
      }
      this.db
        .prepare(
          `INSERT INTO operation_journal (ts, profile, connection_id, tool, args_redacted, target_device_id, target_org_id, dry_run, status, error, plan_id, operation_id, runbook_id, runbook_version)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          this.security.profile,
          this.store.connId,
          'run_device_powershell',
          input.args === undefined ? null : JSON.stringify(input.args),
          targetDeviceId,
          input.status,
          input.error === undefined ? null : String(input.error instanceof Error ? input.error.message : input.error),
          input.planId ?? null,
          input.operationId ?? null,
          runbookId,
          runbookVersion,
        );
    } catch {
      // Journaling must never break the operation path.
    }
  }

  createPlan(input: {
    operation: string;
    targetType: string;
    targetId: number;
    args: Record<string, unknown>;
    selectionId?: string | undefined;
    canarySize?: number | undefined;
  }): Record<string, unknown> {
    this.requireSupported(input.operation);
    const isBatch = typeof input.selectionId === 'string' && input.selectionId.length > 0;
    if (!isBatch && (input.targetType !== 'device' || !Number.isInteger(input.targetId))) {
      throw new OpError('invalid_params', 'plans support a device target or a selectionId');
    }
    // Same validation the executor applies — args are frozen into the hash.
    let command: string;
    let runbookRef: { id: string; version: number; digest: string } | null = null;
    let resolvedParams: Record<string, unknown> | null = null;
    if (typeof input.args.runbookId === 'string' && input.args.runbookId.trim()) {
      // Runbook plan: params validated and bound as data (never concatenated
      // into executable text). The resolved script is what the hash binds.
      const rb = getRunbook(input.args.runbookId.trim(), input.args.runbookVersion === undefined ? undefined : Number(input.args.runbookVersion));
      const resolved = resolveRunbookScript(rb, input.args.params as Record<string, unknown> | undefined);
      command = resolved.command;
      runbookRef = { id: rb.id, version: rb.version, digest: resolved.digest };
      resolvedParams = resolved.params;
    } else {
      command = typeof input.args.command === 'string' ? input.args.command.trim() : '';
    }
    if (!command) throw new OpError('invalid_params', 'PowerShell command must not be empty');
    if (command.length > 16000) throw new OpError('invalid_params', 'PowerShell command exceeds the 16000 character safety limit');
    // Fail at plan time, not dispatch: the wire encoding must fit upstream
    // transport limits (throws invalid_params if even compressed won't fit).
    transportEncodeCommand(command);
    const timeoutSeconds = input.args.timeoutSeconds === undefined ? 120 : Number(input.args.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
      throw new OpError('invalid_params', 'timeoutSeconds must be an integer from 1 through 900');
    }
    const argsObj: Record<string, unknown> = { command, timeoutSeconds };
    if (runbookRef) argsObj.runbook = runbookRef;
    if (resolvedParams) argsObj.params = resolvedParams;

    // M5B batch path: the frozen member set is embedded in the plan args,
    // so the plan hash binds exactly the approved devices — filter drift
    // can never expand an approved plan.
    let targetType = input.targetType;
    let targetId = input.targetId;
    if (isBatch) {
      const sel = this.db.prepare('SELECT * FROM selections WHERE id = ?').get(input.selectionId!) as Record<string, unknown> | undefined;
      if (!sel) throw new OpError('selection_not_found', `Selection ${input.selectionId} not found`);
      if (Number(sel.expires_at) < Date.now()) throw new OpError('selection_expired', 'Selection expired — re-evaluate to create a fresh handle');
      const memberIds = JSON.parse(String(sel.member_ids_json)) as number[];
      if (memberIds.length === 0) throw new OpError('empty_selection', 'Selection has no members');
      // One organization per plan for the first batch implementation —
      // cross-org requests are separate scoped plans (plan §9).
      if (sel.org_id === null || sel.org_id === undefined) {
        throw new OpError('cross_org_selection', 'Selection spans multiple organizations — create one scoped selection per org');
      }
      const canarySize = input.canarySize === undefined ? 0 : Number(input.canarySize);
      if (!Number.isInteger(canarySize) || canarySize < 0 || canarySize >= memberIds.length) {
        throw new OpError('invalid_params', `canarySize must be an integer 0..${memberIds.length - 1}`);
      }
      argsObj.selection = {
        selectionId: sel.id,
        orgId: sel.org_id,
        memberIds,
        evaluatedAt: sel.evaluated_at,
      };
      if (canarySize > 0) argsObj.canarySize = canarySize;
      targetType = 'selection';
      targetId = 0;
    }

    const canonicalArgs = canonicalJson(argsObj);
    const planHash = createHash('sha256')
      .update(
        canonicalJson({
          operation: input.operation,
          targetType,
          targetId,
          args: argsObj,
          connectionId: this.store.connId,
        }),
      )
      .digest('hex');
    const id = randomUUID();
    const now = Date.now();
    const principal = this.security.principal?.profile ?? this.security.profile;
    this.db
      .prepare(
        'INSERT INTO operation_plans (id, connection_id, operation, target_type, target_id, args_canonical, plan_hash, principal, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, this.store.connId, input.operation, targetType, targetId, canonicalArgs, planHash, principal, now, now + PLAN_TTL_MS);
    this.journalOp({ planId: id, status: 'ok', args: { planned: true, operation: input.operation, runbook: runbookRef ?? undefined, batch: isBatch || undefined } });
    const out: Record<string, unknown> = { id, operation: input.operation, targetType, targetId, args: argsObj, planHash, expiresAt: now + PLAN_TTL_MS };
    if (runbookRef) out.runbook = runbookRef;
    if (isBatch) out.targetCount = (argsObj.selection as Record<string, unknown>).memberIds ? (argsObj.selection as { memberIds: number[] }).memberIds.length : 0;
    return out;
  }

  /**
   * Human-presence enforcement: once any approver passkey is enrolled, only
   * WebAuthn-verified approvals may approve, dispatch, or back a session.
   * Old/unmigrated stores (no table) keep the legacy bearer behavior.
   */
  passkeyEnforced(): boolean {
    try {
      return !!this.db.prepare('SELECT 1 FROM approver_credentials WHERE revoked_at IS NULL LIMIT 1').get();
    } catch {
      return false;
    }
  }

  approvePlan(planId: string, opts: { approvedBy: string; method?: string | undefined; credentialId?: string | undefined; assertion?: Record<string, unknown> | undefined }): Record<string, unknown> {
    // Plan §12: the reporting profile cannot approve command work — shared
    // database does not confer command authority.
    if (this.security.principal?.profile !== 'command') {
      throw new OpError('forbidden', 'Approving command work requires the command profile');
    }
    const enforced = this.passkeyEnforced();
    if (enforced && opts.method !== 'webauthn') {
      throw new OpError('passkey_required', 'Approver passkeys are enrolled — approve with your security key or passkey');
    }
    const plan = this.db.prepare('SELECT * FROM operation_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
    if (!plan) throw new OpError('plan_not_found', `Plan ${planId} not found`);
    if (Number(plan.expires_at) < Date.now()) throw new Error('Plan expired — create a new plan');
    // Idempotent for UI double-clicks: an unconsumed live approval is reused
    // — but never a bearer-only approval once passkeys are enforced.
    const existing = this.db
      .prepare(`SELECT * FROM operation_approvals WHERE plan_id = ? AND consumed_by IS NULL AND expires_at > ?${enforced ? " AND method = 'webauthn'" : ''}`)
      .get(planId, Date.now()) as Record<string, unknown> | undefined;
    if (existing) return { id: existing.id, planId, planHash: existing.plan_hash, expiresAt: existing.expires_at, method: existing.method, reused: true };
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO operation_approvals (id, plan_id, plan_hash, approved_by, method, created_at, expires_at, credential_id, assertion_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, planId, String(plan.plan_hash), opts.approvedBy, opts.method ?? 'ui', now, now + PLAN_TTL_MS, opts.credentialId ?? null, opts.assertion ? JSON.stringify(opts.assertion) : null);
    return { id, planId, planHash: plan.plan_hash, expiresAt: now + PLAN_TTL_MS, method: opts.method ?? 'ui' };
  }

  /**
   * The only write path on the UI surface: verify approval → fresh preflight →
   * persist intent (transaction) → dispatch upstream → record acceptance.
   */
  async executeApproved(planId: string, approvalId: string): Promise<Record<string, unknown>> {
    this.requireSupported('run_device_powershell');
    if (this.security.principal?.profile !== 'command') {
      throw new OpError('forbidden', 'Remote writes require the command profile principal');
    }
    if (!this.security.policy.deviceScriptsEnabled || !this.security.policy.powershellRunnerScriptId) {
      throw new OpError('forbidden', 'PowerShell runner is not enabled in policy (deviceScriptsEnabled + powershellRunnerScriptId)');
    }
    const plan = this.db.prepare('SELECT * FROM operation_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
    if (!plan) throw new OpError('plan_not_found', `Plan ${planId} not found`);
    if (Number(plan.expires_at) < Date.now()) throw new OpError('stale_plan', 'Plan expired — replan required');
    const approval = this.db.prepare('SELECT * FROM operation_approvals WHERE id = ?').get(approvalId) as Record<string, unknown> | undefined;
    if (!approval || approval.plan_id !== planId || approval.plan_hash !== plan.plan_hash) {
      throw new OpError('approval_mismatch', 'Approval does not match this plan — replan required');
    }
    if (Number(approval.expires_at) < Date.now()) throw new OpError('approval_expired', 'Approval expired — re-approve');
    if (approval.method !== 'webauthn' && this.passkeyEnforced()) {
      throw new OpError('passkey_approval_required', 'This approval was not made with an approver passkey — re-approve with your security key or passkey');
    }

    // Dedup first: re-executing the same plan returns the existing operation
    // (idempotent UI retries), never a second dispatch.
    const dedupeKey = createHash('sha256').update(`${this.store.connId}:${planId}`).digest('hex');
    const existingOp = this.db.prepare('SELECT * FROM operations WHERE dedupe_key = ?').get(dedupeKey) as Record<string, unknown> | undefined;
    if (existingOp) return this.getOperation(existingOp.id as string)!;
    if (approval.consumed_by) throw new OpError('approval_consumed', 'Approval already consumed');

    const canonicalArgs = JSON.parse(plan.args_canonical as string) as {
      command: string; timeoutSeconds: number;
      runbook?: { id: string; version: number };
      selection?: { selectionId: string; orgId: number; memberIds: number[]; evaluatedAt: number };
      canarySize?: number;
    };
    // Batch path: one parent operation + per-target rows. Per-target preflight
    // happens at dispatch time (dispatchQueued), not here.
    if (plan.target_type === 'selection' && canonicalArgs.selection) {
      return this.executeApprovedBatch(plan, approval, canonicalArgs, dedupeKey);
    }

    // Fresh preflight (§5.5): cached org membership must not authorize a write.
    const targetId = Number(plan.target_id);
    const device = await this.api.getDevice(targetId);
    if (!device) throw new OpError('target_not_found', `Target device ${targetId} not found upstream`);
    const allowed = this.security.policy.allowedOrganizationIds;
    if (allowed && allowed.length > 0 && !allowed.includes(Number(device.organizationId))) {
      throw new OpError('forbidden', `Device ${targetId} is in organization ${device.organizationId}, outside the allowed set`);
    }
    if (device.offline === true) {
      throw new OpError('target_offline', `Device ${targetId} is offline upstream — cannot dispatch`);
    }
    const rbId = canonicalArgs.runbook?.id ?? null;
    const rbVersion = canonicalArgs.runbook?.version ?? null;

    const opId = randomUUID();
    const runId = randomUUID();
    const now = Date.now();

    // Persist-before-dispatch (§14.3): commit intent BEFORE the upstream call.
    // If this transaction fails, the remote write must not occur.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO operations (id, connection_id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, upstream_ref, runbook_id, runbook_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?)`,
        )
        .run(opId, this.store.connId, planId, approvalId, dedupeKey, String(plan.operation), String(plan.target_type), targetId, runId, rbId, rbVersion, now, now);
      this.event(opId, 'preflight_ok', { organizationId: device.organizationId, systemName: device.systemName });
      this.event(opId, 'intent_persisted', { planId, approvalId, runId });
      // Single-consume enforcement: the unique consumed_by constraint rejects
      // a second consume of the same approval inside this transaction.
      const consumed = this.db
        .prepare('UPDATE operation_approvals SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL')
        .run(opId, approvalId);
      if (Number(consumed.changes) === 0) throw new Error('Approval already consumed');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    // Dispatch — outside the transaction (§14.3). Transport encoding is a
    // pure function of the bound command: oversized commands ride a
    // self-inflating bootstrapper (see transportEncodeCommand).
    const wire = transportEncodeCommand(canonicalArgs.command);
    try {
      const submission = await this.api.runDeviceScript(targetId, {
        type: 'SCRIPT',
        id: this.security.policy.powershellRunnerScriptId,
        runAs: 'system',
        parameters: `${wire.paramBase64} ${runId} ${canonicalArgs.timeoutSeconds}`,
      });
      this.db
        .prepare("UPDATE operations SET status = 'accepted', updated_at = ? WHERE id = ?")
        .run(Date.now(), opId);
      this.event(opId, 'dispatch_accepted', { submission: safeSubmissionMeta(submission), wireEncoding: wire.encoding, wireSha256: wire.wireSha256 });
      this.journalOp({ operationId: opId, planId, status: 'ok', args: { dispatched: true, runId } });
      // One trusted approval opens a bounded per-device session: later
      // stdio commands on the SAME device attach to it (expiry + cap).
      this.openSession(targetId, planId, approvalId, opId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db
        .prepare("UPDATE operations SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(Date.now(), opId);
      this.event(opId, 'dispatch_failed', { error: message });
      this.journalOp({ operationId: opId, planId, status: 'error', error: message });
      throw new OpError('dispatch_failed', `Dispatch failed (operation ${opId} persisted as failed): ${message}`);
    }
    return this.getOperation(opId)!;
  }

  /**
   * M5B batch dispatch: ONE parent operation + one operation_targets row per
   * frozen member, persisted in a single transaction — the approved set can
   * never silently lose or gain a device after approval.
   * Targets enter 'queued' (or 'held' behind the canary gate); the bounded
   * dispatcher — invoked here and by the serve sweep — advances them.
   */
  private async executeApprovedBatch(
    plan: Record<string, unknown>,
    approval: Record<string, unknown>,
    args: { command: string; timeoutSeconds: number; runbook?: { id: string; version: number }; selection?: { selectionId: string; orgId: number; memberIds: number[]; evaluatedAt: number }; canarySize?: number },
    dedupeKey: string,
  ): Promise<Record<string, unknown>> {
    const sel = args.selection!;
    const canarySize = args.canarySize ?? 0;
    const opId = randomUUID();
    const planId = String(plan.id);
    const approvalId = String(approval.id);
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO operations (id, connection_id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, upstream_ref, runbook_id, runbook_version, target_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'selection', 0, 'dispatching', ?, ?, ?, ?, ?, ?)`,
        )
        .run(opId, this.store.connId, planId, approvalId, dedupeKey, String(plan.operation), null, args.runbook?.id ?? null, args.runbook?.version ?? null, sel.memberIds.length, now, now);
      const insert = this.db.prepare(
        'INSERT INTO operation_targets (operation_id, device_id, status, canary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      sel.memberIds.forEach((deviceId, i) => {
        const isCanary = i < canarySize ? 1 : 0;
        // 'held' only exists behind a real canary gate — without one every
        // target is simply queued (a canarySize of 0 must not freeze the set).
        insert.run(opId, deviceId, canarySize > 0 && i >= canarySize ? 'held' : 'queued', isCanary, now, now);
      });
      this.event(opId, 'intent_persisted', { planId, approvalId, targetCount: sel.memberIds.length, canarySize, selectionId: sel.selectionId });
      const consumed = this.db
        .prepare('UPDATE operation_approvals SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL')
        .run(opId, approvalId);
      if (Number(consumed.changes) === 0) throw new Error('Approval already consumed');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.journalOp({ operationId: opId, planId, status: 'ok', args: { batchIntent: true, targetCount: sel.memberIds.length, canarySize } });
    await this.dispatchQueued(opId);
    return this.getOperation(opId)!;
  }

  /**
   * Bounded dispatcher — claims 'queued' targets one at a time (atomic claim
   * prevents double-dispatch) and submits upstream. Called after batch
   * approval and on every serve sweep tick, so a crashed process leaves
   * 'queued' work that resumes on next tick. BATCH_TICK_MAX bounds work
   * per pass; serial submission is the conservative concurrency default.
   */
  async dispatchQueued(operationId?: string): Promise<number> {
    if (this.security.principal?.profile !== 'command') return 0;
    const tickMax = Math.max(1, Number(process.env.NINJA_BATCH_TICK_MAX ?? 5));
    const opIds: string[] = operationId
      ? [operationId]
      : (this.db.prepare("SELECT DISTINCT operation_id FROM operation_targets WHERE status = 'queued'").all() as Array<{ operation_id: string }>).map((r) => r.operation_id);
    let dispatched = 0;
    for (const opId of opIds) {
      const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(opId) as Record<string, unknown> | undefined;
      if (!op || !['dispatching', 'accepted'].includes(String(op.status))) continue;
      const plan = this.db.prepare('SELECT * FROM operation_plans WHERE id = ?').get(String(op.plan_id)) as Record<string, unknown> | undefined;
      if (!plan) continue;
      const args = JSON.parse(String(plan.args_canonical)) as { command: string; timeoutSeconds: number; selection?: { orgId: number } };
      const wire = transportEncodeCommand(args.command);
      const allowed = this.security.policy.allowedOrganizationIds;

      while (dispatched < tickMax) {
        const next = this.db
          .prepare("SELECT seq, device_id FROM operation_targets WHERE operation_id = ? AND status = 'queued' ORDER BY seq LIMIT 1")
          .get(opId) as { seq: number; device_id: number } | undefined;
        if (!next) break;
        // Atomic claim: only the worker that flips queued→submitting dispatches.
        const claimed = this.db
          .prepare("UPDATE operation_targets SET status = 'submitting', updated_at = ? WHERE seq = ? AND status = 'queued'")
          .run(Date.now(), next.seq);
        if (Number(claimed.changes) === 0) continue;

        try {
          // Per-target preflight — dispatch-time revalidation (§9): fresh
          // upstream identity, org scope, plan org, online state.
          const device = await this.api.getDevice(next.device_id);
          if (!device) { this.setTarget(next.seq, opId, 'skipped', { error: 'not found upstream at dispatch time' }); continue; }
          if (allowed && allowed.length > 0 && !allowed.includes(Number(device.organizationId))) {
            this.setTarget(next.seq, opId, 'skipped', { error: `org ${device.organizationId} outside allowed set` });
            continue;
          }
          if (args.selection && Number(device.organizationId) !== Number(args.selection.orgId)) {
            this.setTarget(next.seq, opId, 'skipped', { error: `org drifted to ${device.organizationId} — outside plan org ${args.selection.orgId}` });
            continue;
          }
          if (device.offline === true) { this.setTarget(next.seq, opId, 'skipped', { error: 'offline at dispatch time' }); continue; }

          const runId = randomUUID();
          await this.api.runDeviceScript(next.device_id, {
            type: 'SCRIPT',
            id: this.security.policy.powershellRunnerScriptId!,
            runAs: 'system',
            parameters: `${wire.paramBase64} ${runId} ${args.timeoutSeconds}`,
          });
          this.setTarget(next.seq, opId, 'accepted', { upstreamRef: runId, wireEncoding: wire.encoding });
          dispatched += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.setTarget(next.seq, opId, 'failed', { error: `dispatch_failed: ${message.slice(0, 400)}` });
          dispatched += 1;
        }
      }
      this.rollupBatch(opId);
    }
    return dispatched;
  }

  private setTarget(seq: number, opId: string, status: string, extra?: { upstreamRef?: string; error?: string; result?: unknown; wireEncoding?: string }): void {
    if (extra?.upstreamRef) {
      this.db.prepare('UPDATE operation_targets SET status = ?, upstream_ref = ?, safe_error = NULL, updated_at = ? WHERE seq = ?')
        .run(status, extra.upstreamRef, Date.now(), seq);
    } else if (extra?.error !== undefined) {
      this.db.prepare('UPDATE operation_targets SET status = ?, safe_error = ?, updated_at = ? WHERE seq = ?')
        .run(status, extra.error, Date.now(), seq);
    } else if (extra?.result !== undefined) {
      this.db.prepare('UPDATE operation_targets SET status = ?, result_json = ?, updated_at = ? WHERE seq = ?')
        .run(status, JSON.stringify(extra.result), Date.now(), seq);
    } else {
      this.db.prepare('UPDATE operation_targets SET status = ?, updated_at = ? WHERE seq = ?').run(status, Date.now(), seq);
    }
    this.event(opId, `target_${status}`, { seq, ...(extra?.error ? { error: extra.error } : {}) });
  }

  /**
   * Parent status from per-target truth — count conservation: the parent
   * total always equals the frozen member count. Never flattens a mixed
   * terminal set into 'verified' (partial stays partial).
   */
  rollupBatch(opId: string): void {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM operation_targets WHERE operation_id = ? GROUP BY status').all(opId) as Array<{ status: string; c: number }>;
    const c = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    const total = rows.reduce((a, r) => a + r.c, 0);
    if (total === 0) return;
    const terminal = (c.verified ?? 0) + (c.failed ?? 0) + (c.skipped ?? 0) + (c.canceled ?? 0) + (c.unknown ?? 0) + (c.partial ?? 0);
    const inFlight = (c.submitting ?? 0) + (c.accepted ?? 0) + (c.cancel_requested ?? 0);
    let status: string;
    if ((c.held ?? 0) > 0 && inFlight === 0 && (c.queued ?? 0) === 0) {
      // Canary gate resolved: all canaries verified → release the remainder;
      // any failed/unknown canary pauses it for trusted review.
      const canaryBad = this.db
        .prepare("SELECT COUNT(*) AS n FROM operation_targets WHERE operation_id = ? AND canary = 1 AND status IN ('failed', 'unknown', 'canceled', 'skipped', 'partial')")
        .get(opId) as { n: number };
      const canaryOpen = this.db
        .prepare("SELECT COUNT(*) AS n FROM operation_targets WHERE operation_id = ? AND canary = 1 AND status NOT IN ('verified','failed','skipped','canceled','unknown','partial')")
        .get(opId) as { n: number };
      if (canaryOpen.n === 0 && canaryBad.n === 0) {
        this.db.prepare("UPDATE operation_targets SET status = 'queued', updated_at = ? WHERE operation_id = ? AND status = 'held'").run(Date.now(), opId);
        this.event(opId, 'canary_released', { remaining: c.held });
        status = 'dispatching';
      } else if (canaryOpen.n === 0) {
        status = 'canary_paused';
      } else {
        status = 'accepted';
      }
    } else if (terminal === total) {
      status = (c.verified ?? 0) === total ? 'verified'
        : (c.canceled ?? 0) === total ? 'canceled'
        : ((c.verified ?? 0) + (c.partial ?? 0)) > 0 ? 'partial'
        : 'failed';
      const planId = (this.db.prepare('SELECT plan_id FROM operations WHERE id = ?').get(opId) as { plan_id: string } | undefined)?.plan_id;
      this.journalOp({ operationId: opId, planId, status: status === 'verified' ? 'ok' : status === 'partial' ? 'partial' : 'error', args: { terminal: true, counts: c } });
    } else {
      status = inFlight > 0 ? 'accepted' : 'dispatching';
    }
    this.db.prepare('UPDATE operations SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), opId);
  }

  /** Trusted UI action: release a canary-paused remainder after review. */
  releaseHeld(opId: string): Record<string, unknown> {
    if (this.security.principal?.profile !== 'command') throw new OpError('forbidden', 'Canary release requires the command profile');
    const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(opId) as Record<string, unknown> | undefined;
    if (!op) throw new OpError('operation_not_found', `Operation ${opId} not found`);
    const released = this.db.prepare("UPDATE operation_targets SET status = 'queued', updated_at = ? WHERE operation_id = ? AND status = 'held'").run(Date.now(), opId);
    if (Number(released.changes) === 0) throw new OpError('nothing_held', 'No held targets — nothing to release');
    this.event(opId, 'canary_released_manual', { remaining: released.changes });
    this.rollupBatch(opId);
    return this.getOperation(opId)!;
  }

  /** Per-target rows for a batch op — compact, paginated by seq. */
  listTargets(operationId: string, opts: { status?: string | undefined; cursor?: number | undefined; limit?: number | undefined } = {}): Record<string, unknown> {
    const op = this.db.prepare('SELECT id FROM operations WHERE id = ?').get(operationId);
    if (!op) throw new OpError('operation_not_found', `Operation ${operationId} not found`);
    const clauses = ['operation_id = ?'];
    const params: unknown[] = [operationId];
    if (opts.status) { clauses.push('status = ?'); params.push(opts.status); }
    if (opts.cursor !== undefined) { clauses.push('seq > ?'); params.push(opts.cursor); }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM operation_targets WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`)
      .all(...(params as never[]), limit) as Array<Record<string, unknown>>;
    const targets = rows.map((r) => ({
      seq: r.seq, deviceId: r.device_id, deviceLabel: this.store.getDeviceById(Number(r.device_id))?.display_name ?? null,
      status: r.status, canary: r.canary === 1,
      upstreamRef: r.upstream_ref ?? null, error: r.safe_error ?? null,
      result: r.result_json ? JSON.parse(String(r.result_json)) : null,
      updatedAt: r.updated_at,
    }));
    return { operationId, targets, nextCursor: rows.length === limit ? (rows[rows.length - 1]!.seq as number) : null };
  }

  /** Ops whose targets still need dispatch — the sweep advances them. */
  listPendingDispatch(): string[] {
    return (this.db.prepare("SELECT DISTINCT operation_id FROM operation_targets WHERE status IN ('queued')").all() as Array<{ operation_id: string }>).map((r) => r.operation_id);
  }

  /**
   * Harness contract: dispatch an ALREADY-approved plan by id. The trusted
   * approval happened in the UI; this looks up the live unconsumed approval
   * bound to the plan's current hash. No approval → approval_required.
   */
  async dispatchPlan(planId: string): Promise<Record<string, unknown>> {
    const plan = this.db.prepare('SELECT * FROM operation_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
    if (!plan) throw new OpError('plan_not_found', `Plan ${planId} not found`);
    const approval = this.db
      .prepare('SELECT * FROM operation_approvals WHERE plan_id = ? AND consumed_by IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(planId, Date.now()) as Record<string, unknown> | undefined;
    if (!approval) {
      throw new OpError('approval_required', `Plan ${planId} has no live approval — approve it in the command-center UI`);
    }
    return this.executeApproved(planId, String(approval.id));
  }

  /**
   * Honest cancel (plan §6): only undispatched work is cancelable. Once
   * upstream accepted the submission we cannot retract it — the operation is
   * flagged and reconcile continues so the result stays auditable.
   */
  cancelOperation(operationId: string): Record<string, unknown> {
    const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as Record<string, unknown> | undefined;
    if (!op) throw new OpError('operation_not_found', `Operation ${operationId} not found`);
    const terminal = new Set(['verified', 'failed', 'canceled', 'partial', 'canary_paused']);
    if (['verified', 'failed', 'canceled', 'partial'].includes(String(op.status))) {
      return { id: op.id, status: op.status, code: 'already_terminal', message: `Operation already in terminal state '${op.status}'` };
    }
    this.event(operationId, 'cancel_requested', { at: Date.now() });
    // Batch: undispatched targets (queued/held) cancel outright — they never
    // reach upstream. Dispatched targets are flagged; their real results
    // still reconcile so nothing silently disappears.
    if (String(op.target_type) === 'selection') {
      const blocked = this.db
        .prepare("UPDATE operation_targets SET status = 'canceled', safe_error = 'canceled before dispatch', updated_at = ? WHERE operation_id = ? AND status IN ('queued', 'held')")
        .run(Date.now(), operationId);
      const flagged = this.db
        .prepare("UPDATE operation_targets SET status = 'cancel_requested', updated_at = ? WHERE operation_id = ? AND status IN ('submitting', 'accepted')")
        .run(Date.now(), operationId);
      this.db.prepare("UPDATE operations SET status = 'cancel_requested', updated_at = ? WHERE id = ?").run(Date.now(), operationId);
      this.event(operationId, 'cancel_applied', { canceledBeforeDispatch: blocked.changes, flaggedInFlight: flagged.changes });
      this.rollupBatch(operationId);
      return {
        id: op.id,
        status: this.db.prepare('SELECT status FROM operations WHERE id = ?').get(operationId)!.status,
        code: 'batch_cancel_applied',
        canceledBeforeDispatch: blocked.changes,
        flaggedInFlight: flagged.changes,
        message: Number(flagged.changes) > 0
          ? `${blocked.changes} target(s) canceled before dispatch; ${flagged.changes} already submitted — upstream cannot retract them, their results will still reconcile.`
          : `${blocked.changes} undispatched target(s) canceled.`,
      };
    }
    if (terminal.has(String(op.status))) {
      return { id: op.id, status: op.status, code: 'already_terminal', message: `Operation already in terminal state '${op.status}'` };
    }
    if (op.status === 'dispatching') {
      this.db.prepare("UPDATE operations SET status = 'cancel_requested', updated_at = ? WHERE id = ?").run(Date.now(), operationId);
      return {
        id: op.id,
        status: 'cancel_requested',
        code: 'cancel_requested',
        message: 'Cancel recorded during dispatch window — upstream submission state is unknown; reconcile will resolve the true outcome.',
      };
    }
    return {
      id: op.id,
      status: op.status,
      code: 'upstream_cancel_unsupported',
      message: 'Upstream transport does not support canceling an accepted script run. Flagged cancel_requested; reconcile will still record the real result.',
    };
  }

  private sessionLimits(): { ttlMs: number; maxCommands: number } {
    const ttl = Number(this.security.policy.powershellSessionTtlSeconds);
    const rawMax = this.security.policy.powershellSessionMaxCommands;
    const max = rawMax === undefined || rawMax === null ? NaN : Number(rawMax);
    return {
      ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : SESSION_TTL_MS,
      // An explicit 0 disables chained sessions: every command needs its own approval.
      maxCommands: Number.isInteger(max) && max >= 0 ? max : SESSION_MAX_COMMANDS,
    };
  }

  private openSession(deviceId: number, planId: string, approvalId: string, opId: string): void {
    const { ttlMs, maxCommands } = this.sessionLimits();
    if (maxCommands <= 0) return;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO device_sessions (id, connection_id, device_id, plan_id, approval_id, status, max_commands, commands_used, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 0, ?, ?)`,
      )
      .run(id, this.store.connId, deviceId, planId, approvalId, maxCommands, now, now + ttlMs);
    this.event(opId, 'session_opened', { sessionId: id, deviceId, maxCommands, expiresAt: now + ttlMs });
  }

  /** The currently open session for a device on this connection, if any. */
  findOpenSession(deviceId: number): Record<string, unknown> | null {
    // Under passkey enforcement a session only counts if the approval that
    // opened it was itself passkey-verified.
    const enforced = this.passkeyEnforced();
    const row = this.db
      .prepare(
        `SELECT s.* FROM device_sessions s
         ${enforced ? 'JOIN operation_approvals a ON a.id = s.approval_id' : ''}
         WHERE s.device_id = ? AND s.connection_id IS ? AND s.status = 'open'
           AND s.expires_at > ? AND s.commands_used < s.max_commands
           ${enforced ? "AND a.method = 'webauthn'" : ''}
         ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get(deviceId, this.store.connId, Date.now()) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /** Session policy for disclosure on the approval card. */
  sessionPolicy(): { ttlSeconds: number; maxCommands: number; enabled: boolean } {
    const { ttlMs, maxCommands } = this.sessionLimits();
    return { ttlSeconds: Math.round(ttlMs / 1000), maxCommands, enabled: maxCommands > 0 };
  }

  /**
   * Chained stdio entry point: an open session on this device dispatches the
   * command as its own plan + operation + events (persist-before-dispatch
   * unchanged); otherwise a plan is created and APPROVAL_REQUIRED is
   * returned — no upstream call is made.
   */
  async executeSessionCommand(
    deviceId: number,
    input: { command: string; timeoutSeconds?: number | undefined },
  ): Promise<Record<string, unknown>> {
    this.requireSupported('run_device_powershell');
    if (this.security.principal?.profile !== 'command') {
      throw new Error('Remote writes require the command profile principal');
    }
    if (!this.security.policy.deviceScriptsEnabled || !this.security.policy.powershellRunnerScriptId) {
      throw new Error('PowerShell runner is not enabled in policy (deviceScriptsEnabled + powershellRunnerScriptId)');
    }
    const session = this.findOpenSession(deviceId);
    if (!session) {
      const plan = this.createPlan({
        operation: 'run_device_powershell',
        targetType: 'device',
        targetId: deviceId,
        args: { command: input.command, timeoutSeconds: input.timeoutSeconds ?? 120 },
      });
      return {
        code: 'APPROVAL_REQUIRED',
        approvalRequired: true,
        planId: plan.id,
        planHash: plan.planHash,
        expiresAt: plan.expiresAt,
        message: 'No open session for this device. Approve the plan in the command-center UI to open a session.',
      };
    }

    // Fresh preflight — every dispatch, including chained commands.
    const device = await this.api.getDevice(deviceId);
    if (!device) throw new Error(`Target device ${deviceId} not found upstream`);
    const allowed = this.security.policy.allowedOrganizationIds;
    if (allowed && allowed.length > 0 && !allowed.includes(Number(device.organizationId))) {
      throw new Error(`Device ${deviceId} is in organization ${device.organizationId}, outside the allowed set`);
    }
    if (device.offline === true) throw new Error(`Device ${deviceId} is offline upstream — cannot dispatch`);

    const command = String(input.command).trim();
    const timeoutSeconds = input.timeoutSeconds === undefined ? 120 : Number(input.timeoutSeconds);
    const opId = randomUUID();
    const runId = randomUUID();
    const stepPlanId = randomUUID();
    const sessionId = String(session.id);
    const now = Date.now();
    const canonicalArgs = canonicalJson({ command, timeoutSeconds });
    const stepHash = createHash('sha256')
      .update(canonicalJson({ operation: 'run_device_powershell', targetType: 'device', targetId: deviceId, args: { command, timeoutSeconds }, connectionId: this.store.connId, sessionId }))
      .digest('hex');

    this.db.exec('BEGIN');
    try {
      // Command text is stored per step as an immutable plan row.
      this.db
        .prepare(
          'INSERT INTO operation_plans (id, connection_id, operation, target_type, target_id, args_canonical, plan_hash, principal, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(stepPlanId, this.store.connId, 'run_device_powershell', 'device', deviceId, canonicalArgs, stepHash, `session:${sessionId.slice(0, 8)}`, now, now + 60_000);
      this.db
        .prepare(
          `INSERT INTO operations (id, connection_id, plan_id, approval_id, dedupe_key, operation, target_type, target_id, status, upstream_ref, session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?)`,
        )
        .run(opId, this.store.connId, stepPlanId, String(session.approval_id), createHash('sha256').update(`${this.store.connId}:${stepPlanId}`).digest('hex'), 'run_device_powershell', 'device', deviceId, runId, sessionId, now, now);
      // Atomic slot claim — closes the double-spend / expiry race.
      const claimed = this.db
        .prepare(
          `UPDATE device_sessions SET commands_used = commands_used + 1
           WHERE id = ? AND status = 'open' AND commands_used < max_commands AND expires_at > ?`,
        )
        .run(sessionId, now);
      if (Number(claimed.changes) === 0) throw new Error('Session closed, expired, or exhausted — replan required');
      this.event(opId, 'session_attached', { sessionId, deviceId });
      this.event(opId, 'preflight_ok', { organizationId: device.organizationId, systemName: device.systemName });
      this.event(opId, 'intent_persisted', { planId: stepPlanId, sessionId, runId });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const wire = transportEncodeCommand(command);
    try {
      const submission = await this.api.runDeviceScript(deviceId, {
        type: 'SCRIPT',
        id: this.security.policy.powershellRunnerScriptId,
        runAs: 'system',
        parameters: `${wire.paramBase64} ${runId} ${timeoutSeconds}`,
      });
      this.db.prepare("UPDATE operations SET status = 'accepted', updated_at = ? WHERE id = ?").run(Date.now(), opId);
      this.event(opId, 'dispatch_accepted', { submission: safeSubmissionMeta(submission) });
      this.db.prepare("UPDATE device_sessions SET status = 'exhausted' WHERE id = ? AND commands_used >= max_commands").run(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE operations SET status = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), opId);
      this.event(opId, 'dispatch_failed', { error: message });
      throw new Error(`Dispatch failed (operation ${opId} persisted as failed): ${message}`);
    }
    const op = this.getOperation(opId)!;
    const used = Number(this.db.prepare('SELECT commands_used FROM device_sessions WHERE id = ?').get(sessionId)?.commands_used ?? 0);
    return { ...op, sessionId, commandsUsed: used, commandsRemaining: Math.max(0, Number(session.max_commands) - used) };
  }

  /** Pending (unconsumed, unexpired) plans — the UI approval queue. */
  listPlans(limit = 50): Array<Record<string, unknown>> {
    return (this.db
      .prepare(
        `SELECT p.*, a.id AS approval_id, a.consumed_by AS approval_consumed
         FROM operation_plans p
         LEFT JOIN operation_approvals a ON a.plan_id = p.id
         WHERE p.expires_at > ? AND (a.consumed_by IS NULL)
         ORDER BY p.created_at DESC LIMIT ?`,
      )
      .all(Date.now(), Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>)
      .map((p) => ({
        ...p,
        args: typeof p.args_canonical === 'string' ? JSON.parse(p.args_canonical as string) : null,
        device_label: p.target_type === 'device' ? (this.store.getDeviceById(Number(p.target_id))?.display_name ?? null) : null,
      }));
  }

  /**
   * Poll upstream activities for the runner result. `accepted` stays
   * `accepted` until the result block is observed — never force-verified.
   */
  async reconcile(operationId: string): Promise<Record<string, unknown> | null> {
    const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as Record<string, unknown> | undefined;
    if (!op) return null;
    if (String(op.target_type) === 'selection') return this.reconcileBatch(operationId, op);
    if (op.status !== 'accepted' && op.status !== 'dispatching' && op.status !== 'cancel_requested') return this.getOperation(operationId);
    const runId = op.upstream_ref as string;
    const targetId = Number(op.target_id);
    const activitiesResponse = await this.api.getDeviceActivities(targetId, 200);
    const activities = Array.isArray(activitiesResponse) ? activitiesResponse : (activitiesResponse?.activities || []);
    const activity = activities.find((entry: unknown) => JSON.stringify(entry).includes(runId));
    if (!activity) return this.getOperation(operationId); // still accepted — honest
    const result = extractRunnerResult(activity, runId);
    if (!result && isTerminalActivity(activity)) {
      // Upstream finished but the runner's structured envelope never made it
      // through — NinjaOne caps activity output (~10K) so a large stdout can
      // truncate away STDOUT_END/RESULT markers, or the runner never started.
      // Generic action SUCCESS is NOT evidence; close failed, do not ingest.
      const statusCode = (activity as Record<string, unknown>).statusCode;
      const bounded = {
        exitCode: null,
        durationMs: null,
        stdout: null,
        stderr: null,
        streamsComplete: false,
        parsed: null,
        parser: 'result-unrecoverable',
      };
      this.db
        .prepare('UPDATE operations SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
        .run('failed', JSON.stringify(bounded), Date.now(), operationId);
      this.event(operationId, 'failed', { statusCode, reason: 'result_truncated_or_missing', note: 'upstream activity terminal but runner result envelope absent — output likely exceeded activity size cap' });
      this.journalOp({ operationId, planId: String(op.plan_id), status: 'error', error: `result unrecoverable: statusCode=${String(statusCode ?? 'null')}` });
      return this.getOperation(operationId);
    }
    if (result) {
      const statusCode = (activity as Record<string, unknown>).statusCode;
      const failed = statusCode === 'FAILED' || (result.exitCode !== undefined && Number(result.exitCode) !== 0);
      // stdout bound must exceed the max RBJGZ wire (~8.3K) or the stored
      // receipt truncates the payload before the parser can recover it.
      const stdout = typeof result.stdout === 'string' ? result.stdout.slice(0, 12000) : null;
      const parsed = op.runbook_id ? parseRunbookResult(stdout) : null;
      const status = deriveCollectionStatus(failed, parsed);
      // Bound the stored result — stdout/stderr capped, no raw activity blob.
      // Runbook ops also store the parsed RBJSON interpretation SEPARATELY
      // from the raw receipt: exit 0 ≠ healthy, malformed JSON ≠ clean diag.
      const bounded = {
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs ?? null,
        stdout,
        stderr: typeof result.stderr === 'string' ? result.stderr.slice(0, 8000) : null,
        streamsComplete: result.streamsComplete ?? false,
        parsed: parsed ?? null,
        parser: op.runbook_id ? (parsed ? 'rbjson-v1' : 'rbjson-v1:no-result') : null,
      };
      this.db
        .prepare('UPDATE operations SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
        .run(status, JSON.stringify(bounded), Date.now(), operationId);
      this.event(operationId, status, { statusCode, exitCode: bounded.exitCode });
      this.journalOp({ operationId, planId: String(op.plan_id), status: status === 'verified' ? 'ok' : status === 'partial' ? 'partial' : 'error', error: status === 'verified' ? undefined : `exitCode=${bounded.exitCode ?? 'null'} statusCode=${String(statusCode ?? 'null')}` });
      this.enqueueIngestion(operationId, null, op.runbook_id as string | null);
    }
    return this.getOperation(operationId);
  }

  /**
   * Batch reconcile: per-target receipts via each device's activity feed.
   * A 'submitting' target older than the fence means the process may have
   * crashed between claim and upstream write — that target becomes
   * 'unknown' (never silently retried; a non-idempotent replay needs
   * review). Results are stored per-target with the same RBJSON parse as
   * single-device ops.
   */
  private async reconcileBatch(opId: string, op: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const STALE_SUBMIT_MS = 5 * 60_000;
    const inFlight = this.db
      .prepare("SELECT seq, device_id, status, upstream_ref, updated_at FROM operation_targets WHERE operation_id = ? AND status IN ('submitting', 'accepted', 'cancel_requested')")
      .all(opId) as Array<{ seq: number; device_id: number; status: string; upstream_ref: string | null; updated_at: number }>;
    const now = Date.now();
    for (const t of inFlight) {
      if (t.status === 'submitting') {
        if (now - Number(t.updated_at) > STALE_SUBMIT_MS) {
          this.setTarget(t.seq, opId, 'unknown', { error: 'crash window: submitting marker aged out — upstream acceptance undetermined; review before any retry' });
        }
        continue;
      }
      if (!t.upstream_ref) continue;
      try {
        const activitiesResponse = await this.api.getDeviceActivities(t.device_id, 200);
        const activities = Array.isArray(activitiesResponse) ? activitiesResponse : (activitiesResponse?.activities || []);
        const activity = activities.find((entry: unknown) => JSON.stringify(entry).includes(t.upstream_ref!));
        if (!activity) continue; // still running upstream — honest
        const result = extractRunnerResult(activity, t.upstream_ref);
        if (!result) {
          if (isTerminalActivity(activity)) {
            this.setTarget(t.seq, opId, 'failed', {
              result: { exitCode: null, stdout: null, stderr: null, parsed: null, parser: 'result-unrecoverable' },
              error: 'upstream terminal but runner result envelope absent — output likely exceeded activity size cap',
            });
          }
          continue;
        }
        const statusCode = (activity as Record<string, unknown>).statusCode;
        const failed = statusCode === 'FAILED' || (result.exitCode !== undefined && Number(result.exitCode) !== 0);
        const stdout = typeof result.stdout === 'string' ? result.stdout.slice(0, 12000) : null;
        const parsed = op.runbook_id ? parseRunbookResult(stdout) : null;
        const status = deriveCollectionStatus(failed, parsed);
        this.setTarget(t.seq, opId, status, {
          result: {
            exitCode: result.exitCode ?? null,
            durationMs: result.durationMs ?? null,
            stdout,
            stderr: typeof result.stderr === 'string' ? result.stderr.slice(0, 8000) : null,
            parsed: parsed ?? null,
            parser: op.runbook_id ? (parsed ? 'rbjson-v1' : 'rbjson-v1:no-result') : null,
          },
        });
        this.enqueueIngestion(opId, t.seq, op.runbook_id as string | null);
      } catch (error) {
        // Reconciliation impossible for this target right now — keep it
        // in-flight; repeated failure will surface via events, not silence.
        this.event(opId, 'reconcile_target_error', { seq: t.seq, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      }
    }
    this.rollupBatch(opId);
    return this.getOperation(opId);
  }

  getOperation(id: string): Record<string, unknown> | null {
    const op = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!op) return null;
    const events = this.db
      .prepare('SELECT kind, at, data_json FROM operation_events WHERE operation_id = ? ORDER BY seq')
      .all(id) as Array<Record<string, unknown>>;
    const out: Record<string, unknown> = {
      ...op,
      result: typeof op.result_json === 'string' ? JSON.parse(op.result_json as string) : null,
      events: events.map((e) => ({ kind: e.kind, at: e.at, data: typeof e.data_json === 'string' ? JSON.parse(e.data_json as string) : null })),
      device_label: op.target_type === 'device' ? (this.store.getDeviceById(Number(op.target_id))?.display_name ?? null) : null,
    };
    if (op.target_type === 'selection') {
      const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM operation_targets WHERE operation_id = ? GROUP BY status').all(id) as Array<{ status: string; c: number }>;
      out.targets = { total: op.target_count, counts: Object.fromEntries(rows.map((r) => [r.status, r.c])) };
      out.selection_label = `${op.target_count} devices`;
    }
    return out;
  }

  getPlan(id: string): Record<string, unknown> | null {
    const p = this.db.prepare('SELECT * FROM operation_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!p) return null;
    const approvals = this.db
      .prepare('SELECT id, plan_hash, approved_by, method, created_at, expires_at, consumed_by FROM operation_approvals WHERE plan_id = ? ORDER BY created_at DESC')
      .all(id) as Array<Record<string, unknown>>;
    const op = this.db.prepare('SELECT id, status, created_at FROM operations WHERE plan_id = ?').get(id) as Record<string, unknown> | undefined;
    return {
      ...p,
      args: typeof p.args_canonical === 'string' ? JSON.parse(p.args_canonical as string) : null,
      device_label: p.target_type === 'device' ? (this.store.getDeviceById(Number(p.target_id))?.display_name ?? null) : null,
      expired: Number(p.expires_at) < Date.now(),
      approvals,
      operation: op ?? null,
    };
  }

  /**
   * Bounded list for cross-session resume (plan §6): status/since filters,
   * keyset cursor on created_at desc. Compact rows — no result payloads.
   */
  listOperations(filter?: { status?: string | undefined; sinceMs?: number | undefined; limit?: number | undefined; cursor?: number | undefined }): Array<Record<string, unknown>> {
    const limit = Math.min(Math.max(filter?.limit ?? 20, 1), 200);
    const clauses: string[] = [];
    const vals: unknown[] = [];
    if (filter?.status) { clauses.push('status = ?'); vals.push(filter.status); }
    if (filter?.sinceMs) { clauses.push('created_at >= ?'); vals.push(filter.sinceMs); }
    // rowid keyset cursor — created_at ties within a millisecond must never
    // silently drop a row between pages.
    if (filter?.cursor) { clauses.push('rowid < ?'); vals.push(filter.cursor); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT rowid AS _seq, id, connection_id, plan_id, operation, target_type, target_id, status, runbook_id, runbook_version, session_id, created_at, updated_at FROM operations ${where} ORDER BY rowid DESC LIMIT ?`)
      .all(...(vals as never[]), limit) as Array<Record<string, unknown>>;
    return rows.map((op) => ({
      ...op,
      device_label: op.target_type === 'device' ? (this.store.getDeviceById(Number(op.target_id))?.display_name ?? null) : null,
    }));
  }

  /** Operations still needing upstream resolution — the worker sweep set. */
  listPendingReconcile(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT id FROM operations WHERE status IN ('accepted', 'dispatching', 'cancel_requested') ORDER BY created_at ASC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
  }
}

/** Only safe upstream metadata — never the raw submission blob. */
function safeSubmissionMeta(submission: unknown): Record<string, unknown> {
  if (!submission || typeof submission !== 'object') return {};
  const s = submission as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['id', 'activityId', 'uid', 'status', 'statusCode']) if (k in s) out[k] = s[k];
  return out;
}
