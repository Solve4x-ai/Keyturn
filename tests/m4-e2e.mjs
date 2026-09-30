// M4 end-to-end receipt — MOCKED DISPATCH. No live upstream write occurs.
// Exercises the full pipeline against a file-backed store:
//   plan → trusted approve → fresh preflight → persist-before-dispatch →
//   dispatch adapter → reconcile → receipt
// Target: WS-001 (device 131, Solve4x org 3), command "ipconfig",
// runner script 106 per command policy.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { EntityStore } from '../dist/entity-store.js';
import { OperationService } from '../dist/operations.js';

const dir = mkdtempSync(join(tmpdir(), 'ninjaone-m4-e2e-'));
const dbPath = join(dir, 'm4.db');

const ORG = { id: 3, name: 'Solve4x' };
const DEVICE = {
  id: 131,
  systemName: 'WS-001',
  displayName: '(Solve4x) WS-001',
  dnsName: 'WS-001',
  organizationId: 3,
  nodeClass: 'WINDOWS_WORKSTATION',
  offline: false,
  lastContact: 1789515863.96,
};

const commandPolicy = {
  allowedOrganizationIds: [2, 3],
  defaultOrganizationId: 2,
  deviceManagementEnabled: true,
  deviceScriptsEnabled: true,
  powershellRunnerScriptId: 106,
  administrativeWritesEnabled: false,
  softwareDeploymentEnabled: false,
  remoteControlEnabled: false,
  destructiveOperationsEnabled: false,
};

const security = {
  profile: 'command',
  principal: { profile: 'command', credentialKind: 'native_pkce' },
  policy: commandPolicy,
};

// Mocked upstream API. runDeviceScript records what would have been sent;
// getDeviceActivities returns a runner activity containing the run id, a
// result block, and realistic ipconfig stdout inside the stream markers.
const api = {
  calls: [],
  async getDevice(id) {
    assert.equal(id, 131);
    return { id: 131, organizationId: 3, offline: false, systemName: 'WS-001' };
  },
  async runDeviceScript(deviceId, body) {
    this.calls.push({ deviceId, body });
    return { id: 555001, status: 'QUEUED' };
  },
  async getDeviceActivities(deviceId) {
    const call = this.calls.find((c) => c.deviceId === deviceId);
    const runId = call.body.parameters.split(' ')[1];
    const ipconfigOut = [
      '',
      'Windows IP Configuration',
      '',
      'Ethernet adapter Ethernet0:',
      '   IPv4 Address. . . . . . . . . . . : 10.20.30.41',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : 10.20.30.1',
    ].join('\r\n');
    const result = {
      schemaVersion: 2,
      runId,
      exitCode: 0,
      durationMs: 940,
      timedOut: false,
      stdoutChars: ipconfigOut.length,
      stderrChars: 0,
    };
    return {
      activities: [
        {
          id: 900777,
          statusCode: 'COMPLETED',
          result:
            `S4X_RUNNER_RESULT_BEGIN\n${JSON.stringify(result)}\nS4X_RUNNER_RESULT_END` +
            ` S4X_RUNNER_STDOUT_BEGIN:${runId}\n${ipconfigOut}\nS4X_RUNNER_STDOUT_END:${runId}` +
            ` S4X_RUNNER_STDERR_BEGIN:${runId}\n\nS4X_RUNNER_STDERR_END:${runId}`,
        },
      ],
    };
  },
};

let store = null;
try {
  // ── Phase 1: seed + plan + approve + execute ──────────────────────────
  store = new EntityStore(dbPath, { connectionId: 'conn-m4-e2e' });
  store.syncOrganizations([ORG]);
  store.syncDevices([DEVICE]);

  let ops = new OperationService(store, api, security);

  const plan = ops.createPlan({
    operation: 'run_device_powershell',
    targetType: 'device',
    targetId: 131,
    args: { command: 'ipconfig' },
  });
  console.log('PLAN', JSON.stringify({ id: plan.id, planHash: plan.planHash, expiresAt: plan.expiresAt }));

  const approval = ops.approvePlan(plan.id, { approvedBy: 'ui-session', method: 'ui' });
  console.log('APPROVAL', JSON.stringify({ id: approval.id, planHash: approval.planHash }));

  const op = await ops.executeApproved(plan.id, approval.id);

  // Dispatch assertions — exactly one upstream call, runner script 106,
  // UTF-16LE base64 decodes to exactly "ipconfig".
  assert.equal(api.calls.length, 1, 'exactly one upstream dispatch');
  assert.equal(api.calls[0].body.id, 106, 'runner script id 106');
  const b64 = api.calls[0].body.parameters.split(' ')[0];
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), 'ipconfig');
  assert.equal(op.status, 'accepted');

  // ── Phase 2: restart + reconcile → receipt ────────────────────────────
  store.close();
  store = new EntityStore(dbPath, { connectionId: 'conn-m4-e2e' }); // reopen = restart
  ops = new OperationService(store, api, security);

  const receipt = await ops.reconcile(op.id);
  assert.equal(receipt.status, 'verified', 'expected verified receipt');
  assert.equal(receipt.result.exitCode, 0);
  assert.match(receipt.result.stdout, /IPv4 Address/);

  console.log('RECEIPT', JSON.stringify(receipt, null, 2));
  console.log('E2E-OK: plan → approve → persist → dispatch(mock) → reconcile → verified receipt');
} catch (error) {
  console.error('E2E-FAIL:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
