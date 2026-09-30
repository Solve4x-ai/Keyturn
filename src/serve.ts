/**
 * Integrated local server (M2+M3): a foreground Fastify process exposing the
 * SAME guarded dispatch path as the stdio MCP adapter (executeToolCall) plus
 * a read-only /api/v1 surface for the built-in UI.
 *
 * - Loopback only (127.0.0.1). Never binds a public interface.
 * - Bearer auth on every route: token generated per install at
 *   ~/.ninjaone-mcp/serve.token (0600) or supplied via NINJA_SERVE_TOKEN.
 * - Session scope is per `x-session-id` header (invariant 12).
 * - /api/v1/* routes are READ-ONLY over the local store; mutations go
 *   through the plan → approval → execute pipeline (never upstream).
 * - Optional sync scheduler via NINJA_SYNC_INTERVAL_MINUTES (default off).
 * - Static UI served from public/ at /. No SPA framework, no build step.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { EntityStore } from './entity-store.js';
import { NinjaOneMCPServer } from './index.js';
import { OperationService } from './operations.js';
import { SelectionService } from './selections.js';
import { buildOperationsReport, buildOrgReport, renderOrgReportMarkdown, renderReportMarkdown, resolveWindow } from './reports.js';
import { InfraService } from './infra.js';
import { ReviewService } from './review.js';
import { listRunbooks, getRunbook, summarizeRunbook, scriptDigest } from './runbooks.js';
import { SnapshotService } from './snapshots.js';
import { WRITE_TOOLS } from './security-profile.js';
import { buildHud } from './hud.js';
import { buildAnalytics } from './analytics.js';
import { buildInfraTopology } from './infra-topology.js';
import { ApproverService, WebAuthnError, type ClientCredential } from './webauthn.js';
import { SettingsService, policyHash } from './settings.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.NINJA_SERVE_PORT || 3939);
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT_DIR, 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveToken(): string {
  const configured = (process.env.NINJA_SERVE_TOKEN || '').trim();
  if (configured) return configured;
  const tokenFile = join(homedir(), '.ninjaone-mcp', 'serve.token');
  try {
    if (existsSync(tokenFile)) {
      const existing = readFileSync(tokenFile, 'utf8').trim();
      if (existing.length >= 24) return existing;
    }
  } catch {}
  const generated = randomBytes(24).toString('hex');
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, generated, { mode: 0o600 });
  console.error(`serve.token written to ${tokenFile} — pass as 'Authorization: Bearer <token>'`);
  return generated;
}

function requireStore(mcp: NinjaOneMCPServer): EntityStore {
  const store = mcp.getStore();
  if (!store) {
    const err = new Error('Local entity store is unavailable');
    (err as any).statusCode = 503;
    throw err;
  }
  return store;
}

async function main() {
  const token = serveToken();
  const mcp = new NinjaOneMCPServer();
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.addHook('onRequest', async (request, reply) => {
    const header = String(request.headers.authorization || '');
    // The UI shell itself is served unauthenticated — every data route still
    // requires the bearer token, so the page alone reveals nothing.
    const path = request.url.split('?')[0] || '/';
    if (path === '/' || path.startsWith('/assets/') || /\.(js|css|html|ico|svg|png)$/.test(path)) {
      return;
    }
    if (header !== `Bearer ${token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    // Authenticated operational data must never sit in an intermediary cache.
    reply.header('cache-control', 'no-store');
  });

  const sessionOf = (request: { headers: Record<string, unknown> }): string =>
    String(request.headers['x-session-id'] || 'default');

  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // ── Static UI (unauthenticated shell; data routes stay token-gated) ────
  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return createReadStream(join(PUBLIC_DIR, 'index.html'));
  });
  // Wildcard — UI modules live under /assets/js/ (nested path segments).
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const safe = normalize(request.params['*']).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, safe);
    if (!file.startsWith(normalize(PUBLIC_DIR)) || !existsSync(file) || !statSync(file).isFile()) {
      return reply.code(404).send({ error: 'not found' });
    }
    reply.type(CONTENT_TYPES[extname(file)] || 'application/octet-stream');
    return createReadStream(file);
  });

  // ── Meta ───────────────────────────────────────────────────────────────
  app.get('/health', async () => {
    const context = await mcp.executeToolCall('get_context', {}, 'health');
    const payload = JSON.parse(context.content?.[0]?.text ?? '{}');
    return {
      ok: true,
      principal: mcp.getPrincipal(),
      connectionId: payload.connectionId ?? null,
      cache: payload.cache ?? null,
      syncState: payload.syncState ?? null,
      uptimeSec: Math.round(process.uptime()),
      // Set by `npm run demo` (fictional data, sandboxed) so the UI can say so.
      demo: process.env.NINJA_DEMO === '1',
    };
  });

  app.get('/events', async () => ({ events: mcp.getRecentInvalidations() }));

  // SSE invalidation stream — compact post-commit events, resync_required
  // when the client's cursor is older than retained history (§17.3).
  app.get('/api/v1/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    // Flush headers now — otherwise Node holds them until the first event or
    // heartbeat (25 s) and the UI shows the stream as offline meanwhile.
    reply.raw.write(': connected\n\n');
    const retained = mcp.getRecentInvalidations();
    const cursor = Number(request.headers['last-event-id'] || 0);
    const oldest = retained.length ? Number(retained[0]!.seq) : 0;
    if (cursor > 0 && oldest > cursor + 1) {
      reply.raw.write(`event: resync_required\ndata: {"reason":"cursor too old","cursor":${cursor}}\n\n`);
      reply.raw.end();
      return;
    }
    for (const e of retained.filter((e) => Number(e.seq) > cursor)) {
      reply.raw.write(`id: ${e.seq}\nevent: entities\ndata: ${JSON.stringify(e)}\n\n`);
    }
    const onEntities = (e: Record<string, unknown>) => {
      reply.raw.write(`id: ${e.seq}\nevent: entities\ndata: ${JSON.stringify(e)}\n\n`);
    };
    mcp.invalidations.on('entities', onEntities);
    const heartbeat = setInterval(() => reply.raw.write(`: heartbeat ${Date.now()}\n\n`), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      mcp.invalidations.off('entities', onEntities);
    });
  });

  // ── Read-only UI data routes (/api/v1) ─────────────────────────────────
  app.get('/api/v1/overview', async () => requireStore(mcp).overview());

  app.get<{ Querystring: Record<string, string> }>('/api/v1/devices', async (request) =>
    requireStore(mcp).listDevices({
      orgId: num(request.query.orgId),
      q: request.query.q,
      offline: request.query.offline === undefined ? undefined : request.query.offline === '1' || request.query.offline === 'true',
      kind: request.query.kind,
      sort: request.query.sort,
      dir: request.query.dir,
      page: num(request.query.page),
      pageSize: num(request.query.pageSize),
    }),
  );

  app.get('/api/v1/organizations', async () => ({ organizations: requireStore(mcp).listOrganizations() }));

  app.get<{ Params: { id: string } }>('/api/v1/organizations/:id', async (request, reply) => {
    const detail = requireStore(mcp).orgDetail(Number(request.params.id));
    if (!detail.org) return reply.code(404).send({ error: 'organization not found in local inventory' });
    return detail;
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id', async (request, reply) => {
    const detail = requireStore(mcp).deviceDetail(Number(request.params.id));
    if (!detail.device) return reply.code(404).send({ error: 'device not found in local inventory' });
    return detail;
  });

  app.get<{ Querystring: Record<string, string> }>('/api/v1/changes', async (request) => {
    const store = requireStore(mcp);
    return {
      changes: store.getChangesLabeled({
        entityType: request.query.entityType,
        entityId: num(request.query.entityId),
        field: request.query.field,
        since: num(request.query.since),
        limit: num(request.query.limit) ?? 200,
      }),
      maxSeq: store.maxChangeSeq(),
    };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/v1/journal', async (request) =>
    requireStore(mcp).listJournalPaged({
      page: num(request.query.page),
      pageSize: num(request.query.pageSize),
      tool: request.query.tool,
    }),
  );

  // ── M4: plans → trusted approval → persist → dispatch → receipt ────────
  const ops = () => new OperationService(requireStore(mcp), mcp.getApi(), mcp.getSecurity());
  const infra = () => new InfraService(requireStore(mcp));

  app.post<{ Body: { operation?: string; targetType?: string; targetId?: number; selectionId?: string; canarySize?: number; args?: Record<string, unknown> } }>(
    '/api/v1/plans',
    async (request, reply) => {
      try {
        const plan = ops().createPlan({
          operation: String(request.body?.operation ?? ''),
          targetType: String(request.body?.targetType ?? ''),
          targetId: Number(request.body?.targetId),
          selectionId: request.body?.selectionId,
          canarySize: request.body?.canarySize,
          args: request.body?.args ?? {},
        });
        return reply.code(201).send(plan);
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'plan rejected', code: error?.code });
      }
    },
  );

  // ── Human-presence approvals (WebAuthn passkeys) ───────────────────────
  // WebAuthn forbids IP-address RP IDs, so ceremonies run on
  // http://localhost:<port> (same loopback socket). Override for other hosts
  // with NINJA_WEBAUTHN_RP_ID / NINJA_WEBAUTHN_ORIGINS (comma-separated).
  const rpId = (process.env.NINJA_WEBAUTHN_RP_ID || 'localhost').trim();
  const rpOrigins = (process.env.NINJA_WEBAUTHN_ORIGINS || `http://localhost:${PORT}`).split(',').map((s) => s.trim()).filter(Boolean);
  const approver = () => new ApproverService(requireStore(mcp), { id: rpId, name: 'Keyturn', origins: rpOrigins });
  const isCommand = () => mcp.getSecurity().profile === 'command';
  const waFail = (reply: any, error: any) =>
    reply.code(error instanceof WebAuthnError || error?.code ? 400 : 500).send({ error: error?.message ?? 'passkey ceremony failed', code: error?.code });

  app.get('/api/v1/approver/status', async () => {
    let sessionPolicy = null;
    try { sessionPolicy = ops().sessionPolicy(); } catch { /* reporting */ }
    return { ...approver().status(), profile: mcp.getSecurity().profile, sessionPolicy };
  });

  app.post<{ Body: { name?: string; stepUp?: { challengeId: string; assertion: ClientCredential } } }>('/api/v1/approver/register/options', async (request, reply) => {
    if (!isCommand()) return reply.code(403).send({ error: 'approver keys are managed on the command-profile server', code: 'forbidden' });
    try { return approver().registrationOptions(String(request.body?.name ?? ''), request.body?.stepUp); } catch (e) { return waFail(reply, e); }
  });

  app.post<{ Body: { challengeId?: string; credential?: ClientCredential } }>('/api/v1/approver/register', async (request, reply) => {
    if (!isCommand()) return reply.code(403).send({ error: 'approver keys are managed on the command-profile server', code: 'forbidden' });
    try { return reply.code(201).send(approver().register(String(request.body?.challengeId ?? ''), request.body?.credential as ClientCredential)); } catch (e) { return waFail(reply, e); }
  });

  app.post<{ Body: { purpose?: string; subject?: string } }>('/api/v1/approver/assert/options', async (request, reply) => {
    const purpose = request.body?.purpose;
    if (purpose !== 'enroll' && purpose !== 'revoke' && purpose !== 'settings') {
      return reply.code(400).send({ error: 'purpose must be enroll, revoke, or settings' });
    }
    try { return approver().assertionOptions(purpose, { subject: request.body?.subject }); } catch (e) { return waFail(reply, e); }
  });

  app.post<{ Params: { id: string }; Body: { challengeId?: string; assertion?: ClientCredential } }>('/api/v1/approver/credentials/:id/revoke', async (request, reply) => {
    if (!isCommand()) return reply.code(403).send({ error: 'approver keys are managed on the command-profile server', code: 'forbidden' });
    try { return approver().revoke(request.params.id, String(request.body?.challengeId ?? ''), request.body?.assertion as ClientCredential); } catch (e) { return waFail(reply, e); }
  });

  /** Challenge bound to this plan's id + current hash — a revised plan needs a new ceremony. */
  app.post<{ Params: { id: string } }>('/api/v1/plans/:id/approve/options', async (request, reply) => {
    const plan = ops().getPlan(request.params.id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    try { return approver().assertionOptions('approve', { planId: String(plan.id), planHash: String(plan.plan_hash) }); } catch (e) { return waFail(reply, e); }
  });

  app.post<{ Params: { id: string }; Body: { challengeId?: string; assertion?: ClientCredential } }>('/api/v1/plans/:id/approve', async (request, reply) => {
    try {
      const body = request.body ?? {};
      if (body.assertion) {
        const plan = ops().getPlan(request.params.id);
        if (!plan) return reply.code(404).send({ error: 'plan not found' });
        const v = approver().verifyApproval(String(plan.id), String(plan.plan_hash), String(body.challengeId ?? ''), body.assertion);
        return reply.code(201).send(ops().approvePlan(request.params.id, {
          approvedBy: `passkey:${v.name}`, method: 'webauthn', credentialId: v.credentialId, assertion: v.evidence,
        }));
      }
      // Bootstrap only: before any approver key is enrolled the bearer-
      // authenticated UI session is the approval context. approvePlan refuses
      // this path once a passkey exists.
      return reply.code(201).send(ops().approvePlan(request.params.id, { approvedBy: `ui-session`, method: 'ui' }));
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'approval rejected', code: error?.code });
    }
  });

  // ── Settings: connector status, credential tests, PKCE reconnect,
  //    passkey-gated policy/credential writes, MCP client config ──────────
  const settingsSvc = new SettingsService(ROOT_DIR);
  const journalSettings = (tool: string, detail: Record<string, unknown>) => {
    try {
      requireStore(mcp).database
        .prepare(`INSERT INTO operation_journal (ts, profile, connection_id, tool, args_redacted, dry_run, status) VALUES (?,?,?,?,?,0,'ok')`)
        .run(Date.now(), mcp.getSecurity().profile, null, tool, JSON.stringify(detail));
    } catch { /* journal is best-effort on stores without the schema */ }
  };
  // When approver keys exist, settings writes need a passkey assertion bound
  // to the exact payload hash — same "human hand on the lever" rule as plan
  // approval. Bootstrap: no keys enrolled → bearer session may write.
  // Fails closed: if enrollment can't be determined, the write is refused.
  const verifySettingsStepUp = (subject: string, stepUp: { challengeId?: string; assertion?: ClientCredential } | undefined) => {
    let enforced: boolean;
    try {
      enforced = approver().enforced();
    } catch {
      throw new WebAuthnError('approver_unavailable', 'cannot verify approver keys (local store unavailable) — settings write refused');
    }
    if (!enforced) return 'bootstrap';
    const v = approver().verifyAssertion('settings', String(stepUp?.challengeId ?? ''), stepUp?.assertion as ClientCredential);
    if (v.challenge.subject !== subject) {
      throw new WebAuthnError('challenge_mismatch', 'challenge was issued for a different settings change');
    }
    return `passkey:${v.name}`;
  };

  // Settings writes — and anything that spends or replaces the command
  // credential — run only on the command-profile server. The reporting
  // profile is read-only; it must not rewrite the policy the command server
  // enforces, nor rotate the command token.
  const settingsWriteRefused = (reply: any) =>
    isCommand() ? null : reply.code(403).send({ error: 'settings changes run on the command-profile server', code: 'forbidden' });

  app.get('/api/v1/settings', async () => ({ ...settingsSvc.status(), profile: mcp.getSecurity().profile }));

  app.post<{ Body: { profile?: string } }>('/api/v1/settings/test', async (request, reply) => {
    const profile = String(request.body?.profile ?? 'reporting');
    if (profile !== 'reporting') {
      const refused = settingsWriteRefused(reply);
      if (refused) return refused;
    }
    return settingsSvc.testConnection(profile);
  });

  app.post<{ Body: { profile?: string; values?: Record<string, string>; stepUp?: { challengeId?: string; assertion?: ClientCredential } } }>(
    '/api/v1/settings/env',
    async (request, reply) => {
      const refused = settingsWriteRefused(reply);
      if (refused) return refused;
      const profile = String(request.body?.profile ?? '');
      const values = request.body?.values ?? {};
      const subject = `env:${profile}:${policyHash(values)}`;
      try {
        const actor = verifySettingsStepUp(subject, request.body?.stepUp);
        const result = settingsSvc.updateEnv(profile, values);
        journalSettings('settings.env_update', { actor, profile, keys: Object.keys(values), subject });
        return { ...result, actor, restartRequired: true };
      } catch (error: any) {
        if (error instanceof WebAuthnError) return waFail(reply, error);
        return reply.code(400).send({ error: error?.message ?? 'env update failed', code: error?.code });
      }
    },
  );

  app.post<{ Body: { stepUp?: { challengeId?: string; assertion?: ClientCredential } } }>('/api/v1/settings/reconnect/start', async (request, reply) => {
    const refused = settingsWriteRefused(reply);
    if (refused) return refused;
    let actor: string;
    try {
      actor = verifySettingsStepUp('reconnect:command', request.body?.stepUp);
    } catch (error) {
      return waFail(reply, error);
    }
    const r = settingsSvc.startReconnect();
    if (r.state !== 'error') journalSettings('settings.reconnect_start', { actor });
    return r.state === 'error' ? reply.code(400).send(r) : r;
  });
  app.get('/api/v1/settings/reconnect/status', async () => settingsSvc.reconnectStatus());
  app.post('/api/v1/settings/reconnect/cancel', async () => settingsSvc.cancelReconnect());

  app.get('/api/v1/settings/policy', async () => settingsSvc.readPolicy());

  app.post<{ Body: { policy?: Record<string, unknown>; stepUp?: { challengeId?: string; assertion?: ClientCredential } } }>(
    '/api/v1/settings/policy',
    async (request, reply) => {
      const refused = settingsWriteRefused(reply);
      if (refused) return refused;
      const policy = request.body?.policy;
      const subject = `policy:${policyHash(policy)}`;
      try {
        const actor = verifySettingsStepUp(subject, request.body?.stepUp);
        const result = settingsSvc.writePolicy(policy);
        mcp.reloadPolicy(); // hot-apply for this process; stdio MCP clients reload on respawn
        // Without NINJA_POLICY_PATH this server runs built-in safe defaults and
        // never reads the file — say so instead of claiming it applied.
        const configured = (process.env.NINJA_POLICY_PATH || '').trim();
        const applied = !!configured && resolve(configured) === resolve(result.path);
        journalSettings('settings.policy_update', { actor, hash: result.hash, subject, applied });
        return { ...result, actor, applied };
      } catch (error: any) {
        if (error instanceof WebAuthnError) return waFail(reply, error);
        return reply.code(400).send({ error: error?.message ?? 'policy update failed', code: error?.code });
      }
    },
  );

  app.get('/api/v1/settings/mcp-clients', async () => ({ clients: settingsSvc.clients() }));

  app.get<{ Querystring: { client?: string } }>('/api/v1/settings/mcp-config', async (request, reply) => {
    const client = settingsSvc.clients().find((c) => c.id === request.query.client);
    if (!client) return reply.code(404).send({ error: 'unknown client' });
    return { client, ...settingsSvc.configBlock(client.format) };
  });

  app.post<{ Body: { client?: string; stepUp?: { challengeId?: string; assertion?: ClientCredential } } }>(
    '/api/v1/settings/mcp-config/merge',
    async (request, reply) => {
      const refused = settingsWriteRefused(reply);
      if (refused) return refused;
      const client = String(request.body?.client ?? '');
      try {
        const actor = verifySettingsStepUp(`mcp:${client}`, request.body?.stepUp);
        const result = settingsSvc.mergeClientConfig(client);
        journalSettings('settings.mcp_config_merge', { actor, client, path: result.path });
        return { ...result, actor, restartClient: true };
      } catch (error: any) {
        if (error instanceof WebAuthnError) return waFail(reply, error);
        return reply.code(400).send({ error: error?.message ?? 'merge failed', code: error?.code });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { approvalId?: string } }>(
    '/api/v1/plans/:id/execute',
    async (request, reply) => {
      if (!request.body?.approvalId) return reply.code(400).send({ error: 'approvalId is required' });
      try {
        return await ops().executeApproved(request.params.id, request.body.approvalId);
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'execution rejected' });
      }
    },
  );

  app.get('/api/v1/plans', async () => ({ plans: ops().listPlans() }));

  // Overview HUD — one bounded read-only aggregate (local store only).
  app.get<{ Querystring: { orgId?: string } }>('/api/v1/hud', async (request) => {
    let pendingPlans: Array<Record<string, unknown>> = [];
    try { pendingPlans = ops().listPlans().filter((p) => !p.approval_id); } catch { /* reporting stores may lack plan context */ }
    return buildHud(requireStore(mcp), { orgId: num(request.query.orgId), pendingPlans });
  });

  app.get<{ Querystring: { orgId?: string; days?: string } }>('/api/v1/analytics', async (request) =>
    buildAnalytics(requireStore(mcp), { orgId: num(request.query.orgId), days: num(request.query.days) }));

  app.get<{ Params: { id: string } }>('/api/v1/plans/:id', async (request, reply) => {
    const plan = ops().getPlan(request.params.id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    return plan;
  });

  app.get('/api/v1/runbooks', async (request) => {
    const q = (request.query as Record<string, string> | undefined) ?? {};
    return { runbooks: listRunbooks({ category: q.category, query: q.query }).map(summarizeRunbook) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/runbooks/:id', async (request, reply) => {
    try {
      const rb = getRunbook(request.params.id);
      return { runbook: { ...rb, digest: scriptDigest(rb.script) } };
    } catch {
      return reply.code(404).send({ error: 'runbook not found' });
    }
  });

  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string; sinceDays?: string } }>('/api/v1/operations', async (request) => {
    const q = request.query ?? {};
    const sinceDays = num(q.sinceDays);
    return {
      operations: ops().listOperations({
        status: q.status || undefined,
        limit: num(q.limit),
        cursor: num(q.cursor),
        sinceMs: sinceDays ? Date.now() - sinceDays * 86_400_000 : undefined,
      }),
    };
  });

  // M6 windowed management report — customizable duration (quarterly default).
  app.get<{ Querystring: { sinceDays?: string; since?: string; until?: string; orgId?: string; format?: string } }>(
    '/api/v1/reports/operations',
    async (request, reply) => {
      try {
        const q = request.query;
        const window = resolveWindow({
          sinceDays: q.sinceDays === undefined ? undefined : Number(q.sinceDays),
          since: q.since,
          until: q.until,
        });
        const report = buildOperationsReport(requireStore(mcp), window, q.orgId === undefined ? undefined : Number(q.orgId));
        if (q.format === 'markdown' || q.format === 'md') {
          return reply.type('text/markdown').send(renderReportMarkdown(report));
        }
        return report;
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'report failed' });
      }
    },
  );

  // ── INFRA-1 organization knowns — evidence history + current projection ─
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/infrastructure', async (request, reply) => {
    try {
      return infra().orgSummary(Number(request.params.orgId));
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'infra summary failed' });
    }
  });

  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>(
    '/api/v1/orgs/:orgId/infrastructure/entities',
    async (request, reply) => {
      try {
        const q = request.query;
        const orgId = Number(request.params.orgId);
        // Point-in-time browse: ?at=<ms-or-ISO> replays latest observations ≤ T.
        if (q.at !== undefined && q.at !== '') {
          const asOfMs = /^\d+$/.test(q.at) ? Number(q.at) : Date.parse(q.at);
          if (!Number.isFinite(asOfMs)) return reply.code(400).send({ error: 'at must be epoch ms or ISO date' });
          return infra().listEntitiesAsOf(orgId, asOfMs, {
            category: q.category, namespace: q.namespace, q: q.q,
            limit: q.limit === undefined ? undefined : Number(q.limit),
            cursor: q.cursor === undefined ? undefined : Number(q.cursor),
            linkCounts: q.linkCounts === '1',
          });
        }
        return infra().listEntities(orgId, {
          category: q.category, namespace: q.namespace, status: q.status, q: q.q,
          limit: q.limit === undefined ? undefined : Number(q.limit),
          cursor: q.cursor === undefined ? undefined : Number(q.cursor),
          linkCounts: q.linkCounts === '1',
        });
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'entity list failed' });
      }
    },
  );

  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>(
    '/api/v1/orgs/:orgId/report',
    async (request, reply) => {
      try {
        const q = request.query;
        const window = resolveWindow({ sinceDays: q.sinceDays === undefined ? undefined : Number(q.sinceDays), since: q.since, until: q.until });
        const report = buildOrgReport(requireStore(mcp), window, Number(request.params.orgId));
        if (q.format === 'markdown') {
          reply.header('content-type', 'text/markdown; charset=utf-8');
          return renderOrgReportMarkdown(report);
        }
        return report;
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'report failed' });
      }
    },
  );

  app.get<{ Params: { orgId: string; id: string } }>('/api/v1/orgs/:orgId/infrastructure/entities/:id', async (request, reply) => {
    const detail = infra().getEntity(Number(request.params.orgId), request.params.id);
    if (!detail) return reply.code(404).send({ error: 'entity not found' });
    return detail;
  });

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/infrastructure/topology', async (request) =>
    buildInfraTopology(requireStore(mcp), Number(request.params.orgId)));

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/infrastructure/coverage', async (request, reply) => {
    return infra().getCoverage(Number(request.params.orgId));
  });

  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>(
    '/api/v1/orgs/:orgId/infrastructure/changes',
    async (request, reply) => {
      try {
        const q = request.query;
        const window = resolveWindow({
          sinceDays: q.sinceDays === undefined ? undefined : Number(q.sinceDays),
          since: q.since,
          until: q.until,
        });
        return infra().getChanges(Number(request.params.orgId), {
          since: window.sinceMs, until: window.untilMs, category: q.category,
          limit: q.limit === undefined ? undefined : Number(q.limit),
        });
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'changes failed' });
      }
    },
  );

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/infrastructure/annotations', async (request) => {
    return { annotations: infra().annotations(Number(request.params.orgId)) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id/infrastructure-context', async (request, reply) => {
    const device = requireStore(mcp).getDeviceById(Number(request.params.id));
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return infra().endpointContext(Number(device.org_id ?? 0), Number(request.params.id));
  });

  // ── REVIEW-1: Review Center — local collaboration records ────────────
  // Reads are open to any authenticated profile. Writes are UI actions
  // (provenance 'direct') and still require the reviewWritesEnabled grant —
  // matching the MCP path where harness writes are reported/delegated.
  // Nothing here touches endpoint execution.
  const review = () => new ReviewService(requireStore(mcp));
  const reviewWriteGate = (reply: any): boolean => {
    if (!mcp.getSecurity().policy.reviewWritesEnabled) {
      reply.code(403).send({ error: 'review writes require the reviewWritesEnabled policy grant' });
      return false;
    }
    return true;
  };

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/review', async (request) => {
    return review().digest(Number(request.params.orgId));
  });

  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>('/api/v1/orgs/:orgId/review/items', async (request) => {
    const q = request.query;
    return review().listItems(Number(request.params.orgId), {
      type: q.type, workflow: q.workflow, disposition: q.disposition, assessment: q.assessment,
      category: q.category, severity: q.severity, reviewState: q.reviewState, q: q.q,
      limit: q.limit === undefined ? undefined : Number(q.limit),
      cursor: q.cursor === undefined ? undefined : Number(q.cursor),
    });
  });

  app.get<{ Params: { orgId: string; id: string } }>('/api/v1/orgs/:orgId/review/items/:id', async (request, reply) => {
    try {
      return review().getItem(Number(request.params.orgId), request.params.id);
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : 400).send({ error: error?.message ?? 'item lookup failed' });
    }
  });

  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>('/api/v1/orgs/:orgId/review/questions', async (request) => {
    return { questions: review().listQuestions(Number(request.params.orgId), request.query.status) };
  });

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/review/annotations', async (request) => {
    return { annotations: review().listOrgAnnotations(Number(request.params.orgId)) };
  });

  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/items', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return review().proposeItem({
        orgId: Number(request.params.orgId),
        itemType: String(b.itemType ?? 'observation') as never,
        category: b.category === undefined ? undefined : String(b.category),
        title: String(b.title ?? ''),
        summary: b.summary === undefined ? undefined : String(b.summary),
        rationale: b.rationale === undefined ? undefined : String(b.rationale),
        consequence: b.consequence === undefined ? undefined : String(b.consequence),
        knownsUnknowns: b.knownsUnknowns === undefined ? undefined : String(b.knownsUnknowns),
        impact: b.impact === undefined ? undefined : String(b.impact),
        urgency: b.urgency === undefined ? undefined : String(b.urgency),
        severity: b.severity === undefined ? undefined : String(b.severity),
        confidence: b.confidence === undefined ? undefined : String(b.confidence),
        subject: b.subject as Record<string, unknown> | undefined,
        evidence: b.evidence as never,
        questions: b.questions as never,
        sourceKind: 'human_ui',
        sourceId: 'ui',
        actor: 'ui',
        provenance: 'direct',
        idempotencyKey: b.idempotencyKey === undefined ? undefined : String(b.idempotencyKey),
      });
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : error?.code === 'forbidden' ? 403 : 400).send({ error: error?.message ?? 'proposal failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string; id: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/items/:id/revise', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return review().reviseItem(Number(request.params.orgId), request.params.id, Number(b.expectedRevision), {
        title: b.title === undefined ? undefined : String(b.title),
        summary: b.summary === undefined ? undefined : String(b.summary),
        rationale: b.rationale === undefined ? undefined : String(b.rationale),
        consequence: b.consequence === undefined ? undefined : String(b.consequence),
        knownsUnknowns: b.knownsUnknowns === undefined ? undefined : String(b.knownsUnknowns),
        impact: b.impact === undefined ? undefined : String(b.impact),
        urgency: b.urgency === undefined ? undefined : String(b.urgency),
        severity: b.severity === undefined ? undefined : String(b.severity),
        confidence: b.confidence === undefined ? undefined : String(b.confidence),
      }, { kind: 'human_ui', name: typeof b.actor === 'string' && b.actor.trim() ? b.actor.trim().slice(0, 80) : 'ui', provenance: 'direct' });
    } catch (error: any) {
      return reply.code(error?.code === 'revision_conflict' ? 409 : error?.code === 'not_found' ? 404 : 400).send({ error: error?.message ?? 'revise failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/questions', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return { question: review().addQuestion(Number(request.params.orgId), {
        itemId: b.itemId === undefined ? undefined : String(b.itemId),
        question: String(b.question ?? ''),
        whyItMatters: b.whyItMatters === undefined ? undefined : String(b.whyItMatters),
        answerType: b.answerType === undefined ? undefined : String(b.answerType),
      }, { kind: 'human_ui', name: 'ui' }) };
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : 400).send({ error: error?.message ?? 'question failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string; id: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/questions/:id/answer', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return review().answerQuestion(Number(request.params.orgId), request.params.id, {
        answerText: String(b.answer ?? ''),
        normalized: b.normalized as Record<string, unknown> | undefined,
        actorKind: 'human_ui', actor: typeof b.actor === 'string' && b.actor.trim() ? b.actor.trim().slice(0, 80) : 'ui', provenance: 'direct',
      }, b.idempotencyKey === undefined ? undefined : String(b.idempotencyKey));
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : 400).send({ error: error?.message ?? 'answer failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/annotations', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return { annotation: review().addOrgAnnotation(Number(request.params.orgId), {
        annotationType: String(b.annotationType ?? 'context'),
        subject: b.subject as Record<string, unknown> | undefined,
        text: String(b.text ?? ''),
        attribution: 'direct_human',
        actor: 'ui',
        sourceNote: b.sourceNote === undefined ? undefined : String(b.sourceNote),
      }) };
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'annotation failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string; id: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/items/:id/decision', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return review().recordDecision(Number(request.params.orgId), request.params.id, {
        disposition: String(b.disposition) as never,
        rationale: b.rationale === undefined ? undefined : String(b.rationale),
        owner: b.owner === undefined ? undefined : String(b.owner),
        scopeNote: b.scopeNote === undefined ? undefined : String(b.scopeNote),
        reviewDueAt: b.reviewDueAt === undefined ? undefined : Number(b.reviewDueAt),
        evidenceBasis: b.evidenceBasis,
        actorKind: 'human_ui', actor: typeof b.actor === 'string' && b.actor.trim() ? b.actor.trim().slice(0, 80) : 'ui', provenance: 'direct',
        canonicalItemId: b.canonicalItemId === undefined ? undefined : String(b.canonicalItemId),
      }, b.idempotencyKey === undefined ? undefined : String(b.idempotencyKey));
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : error?.code === 'forbidden' ? 403 : 400).send({ error: error?.message ?? 'decision failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/suppressions', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return { suppression: review().addSuppression(Number(request.params.orgId), {
        fingerprint: b.fingerprint === undefined ? undefined : String(b.fingerprint),
        ruleId: b.ruleId === undefined ? undefined : String(b.ruleId),
        itemId: b.itemId === undefined ? undefined : String(b.itemId),
        reason: String(b.reason ?? ''),
        actor: 'ui',
        expiresAt: b.expiresAt === undefined ? undefined : Number(b.expiresAt),
      }) };
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'suppression failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string; id: string }; Body: Record<string, unknown> }>('/api/v1/orgs/:orgId/review/items/:id/link-operation', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    const b = request.body ?? {};
    try {
      return { link: review().linkOperation(Number(request.params.orgId), request.params.id, {
        operationId: b.operationId === undefined ? undefined : String(b.operationId),
        planId: b.planId === undefined ? undefined : String(b.planId),
        linkKind: String(b.linkKind ?? 'proposed'),
        actor: 'ui',
      }) };
    } catch (error: any) {
      return reply.code(error?.code === 'not_found' ? 404 : error?.code === 'forbidden' ? 403 : 400).send({ error: error?.message ?? 'link failed', code: error?.code });
    }
  });

  app.post<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/review/import-findings', async (request, reply) => {
    if (!reviewWriteGate(reply)) return;
    return review().importFindings(Number(request.params.orgId));
  });

  // Local backfill (plan §9): dry-run reports eligibility; commit enqueues
  // extraction jobs. Local data only — never submits endpoint work. Commit
  // is command-profile-gated since it writes derived state.
  app.post<{ Body: { dryRun?: boolean; limit?: number } }>('/api/v1/infrastructure/backfill', async (request, reply) => {
    const dryRun = request.body?.dryRun !== false;
    if (!dryRun && mcp.getSecurity().principal?.profile !== 'command') {
      return reply.code(403).send({ error: 'backfill commit requires the command profile', hint: 'POST with dryRun:true for a read-only eligibility report' });
    }
    return infra().backfill({ dryRun, limit: request.body?.limit });
  });

  app.get<{ Params: { id: string } }>('/api/v1/operations/:id', async (request, reply) => {
    const op = await ops().reconcile(request.params.id);
    if (!op) return reply.code(404).send({ error: 'operation not found' });
    return op;
  });

  app.post<{ Params: { id: string } }>('/api/v1/operations/:id/cancel', async (request, reply) => {
    try {
      return ops().cancelOperation(request.params.id);
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'cancel rejected' });
    }
  });

  // ── M5B selections + batch surface ─────────────────────────────────────
  // Selections are frozen device sets — creating one is read-tier (no
  // execution); using one in a plan is command-gated downstream.
  const selections = () => new SelectionService(requireStore(mcp), mcp.getSecurity());

  app.post<{ Body: { orgId?: number; offline?: boolean; q?: string; deviceIds?: number[] } }>(
    '/api/v1/selections',
    async (request, reply) => {
      try {
        return selections().create(request.body ?? {}, 'ui');
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'selection rejected', code: error?.code });
      }
    },
  );

  app.get('/api/v1/selections', async () => ({ selections: selections().list() }));

  app.get<{ Params: { id: string } }>('/api/v1/selections/:id', async (request, reply) => {
    const sel = selections().describe(request.params.id);
    if (!sel) return reply.code(404).send({ error: 'selection not found' });
    return sel;
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; cursor?: string; limit?: string } }>(
    '/api/v1/operations/:id/targets',
    async (request, reply) => {
      try {
        return ops().listTargets(request.params.id, {
          status: request.query.status,
          cursor: request.query.cursor === undefined ? undefined : Number(request.query.cursor),
          limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
        });
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message ?? 'targets unavailable' });
      }
    },
  );

  // Trusted release of a canary-paused remainder — command profile only.
  app.post<{ Params: { id: string } }>('/api/v1/operations/:id/release', async (request, reply) => {
    try {
      return ops().releaseHeld(request.params.id);
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? 'release rejected', code: error?.code });
    }
  });

  // ── Tool dispatch bridge (same guarded path as stdio) ──────────────────
  app.get('/context', async (request) =>
    mcp.executeToolCall('get_context', {}, sessionOf(request)),
  );

  app.put('/context', async (request) =>
    mcp.executeToolCall('set_context', request.body ?? {}, sessionOf(request)),
  );

  app.post<{ Params: { name: string }; Body: Record<string, unknown> }>(
    '/tools/:name',
    async (request, reply) => {
      // M4 migration: on the command-center surface, writes go through the
      // plan→approve→execute pipeline — confirm:true cannot bypass it.
      // (Reporting profile still denies them inside executeToolCall anyway.)
      if (WRITE_TOOLS.has(request.params.name) && mcp.getSecurity().profile === 'command') {
        return reply.code(403).send({
          error: 'writes on this surface require the approval pipeline: POST /api/v1/plans → /approve → /execute',
        });
      }
      try {
        return await mcp.executeToolCall(request.params.name, request.body ?? {}, sessionOf(request));
      } catch (error: any) {
        return { error: true, message: error?.message ?? String(error), code: error?.code };
      }
    },
  );

  // ── M4.5: snapshots, captures, comparisons, pins, schedules, reports ────
  const snaps = () => new SnapshotService(requireStore(mcp), mcp.getApi(), mcp.getPrincipal().profile);

  app.post<{ Params: { id: string }; Body: { profile?: string; resources?: string[] } }>(
    '/api/v1/devices/:id/capture',
    async (request, reply) => {
      const deviceId = num(request.params.id);
      if (deviceId === undefined) return reply.code(400).send({ error: 'invalid device id' });
      try {
        return await snaps().capture({
          deviceId,
          profile: request.body?.profile,
          resources: request.body?.resources,
          kind: 'on_demand',
        });
      } catch (error: any) {
        return reply.code(500).send({ error: 'capture_failed', message: error?.message ?? String(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/captures/:id', async (request, reply) => {
    const run = snaps().getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: 'capture not found' });
    return { run };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/devices/:id/snapshots',
    async (request, reply) => {
      const deviceId = num(request.params.id);
      if (deviceId === undefined) return reply.code(400).send({ error: 'invalid device id' });
      return {
        snapshots: snaps().listSnapshots(deviceId, {
          since: num(request.query.since),
          until: num(request.query.until),
          limit: num(request.query.limit),
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/snapshots/:id', async (request, reply) => {
    const s = snaps().getSnapshot(request.params.id);
    if (!s) return reply.code(404).send({ error: 'snapshot not found' });
    return { snapshot: s };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/observations/:id',
    async (request, reply) => {
      const o = snaps().getObservation(
        request.params.id,
        request.query.detail === 'full' ? 'full' : 'summary',
      );
      if (!o) return reply.code(404).send({ error: 'observation not found' });
      return { observation: o };
    },
  );

  app.post<{ Body: { baselineId?: string; comparisonId?: string } }>(
    '/api/v1/compare',
    async (request, reply) => {
      const { baselineId, comparisonId } = request.body ?? {};
      if (!baselineId || !comparisonId) {
        return reply.code(400).send({ error: 'baselineId and comparisonId required' });
      }
      const result = snaps().compare(baselineId, comparisonId);
      if (result.error) return reply.code(400).send(result);
      return { comparison: result };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/devices/:id/changes',
    async (request, reply) => {
      const deviceId = num(request.params.id);
      if (deviceId === undefined) return reply.code(400).send({ error: 'invalid device id' });
      const since = num(request.query.since) ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
      return { changes: snaps().changeSummary(deviceId, since) };
    },
  );

  app.get('/api/v1/schedules', async () => ({ schedules: snaps().listSchedules() }));

  app.post<{ Body: Record<string, unknown> }>('/api/v1/schedules', async (request, reply) => {
    const b = request.body ?? {};
    if (!b.name || (!b.orgId && !Array.isArray(b.deviceIds))) {
      return reply.code(400).send({ error: 'name and scope (orgId or deviceIds) required' });
    }
    return snaps().upsertSchedule({
      name: String(b.name),
      scope: { orgId: num(b.orgId), deviceIds: Array.isArray(b.deviceIds) ? b.deviceIds.map(Number) : undefined },
      profile: typeof b.profile === 'string' ? b.profile : undefined,
      timezone: typeof b.timezone === 'string' ? b.timezone : undefined,
      windowHhmm: typeof b.windowHhmm === 'string' ? b.windowHhmm : undefined,
      budgetRequests: num(b.budgetRequests),
      enabled: b.enabled !== false,
    });
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/schedules/:id',
    async (request, reply) => {
      const b = request.body ?? {};
      if (b.enabled === undefined && b.windowHhmm === undefined) {
        return reply.code(400).send({ error: 'enabled or windowHhmm required' });
      }
      const existing = snaps().listSchedules().find((s: any) => s.id === request.params.id);
      if (!existing) return reply.code(404).send({ error: 'schedule not found' });
      return snaps().upsertSchedule({
        id: request.params.id,
        name: existing.name,
        scope: existing.scope,
        profile: existing.profile,
        timezone: existing.timezone,
        windowHhmm: typeof b.windowHhmm === 'string' ? b.windowHhmm : existing.window_hhmm,
        budgetRequests: existing.budget_requests,
        enabled: b.enabled === undefined ? existing.enabled : Boolean(b.enabled),
      });
    },
  );

  app.get<{ Params: { kind: string; ref: string } }>(
    '/api/v1/report/:kind/:ref',
    async (request, reply) => {
      const kind = request.params.kind as 'snapshot' | 'comparison' | 'work_evidence';
      if (!['snapshot', 'comparison', 'work_evidence'].includes(kind)) {
        return reply.code(400).send({ error: 'unknown report kind' });
      }
      reply.type('text/markdown; charset=utf-8');
      return snaps().renderReport(kind, request.params.ref);
    },
  );

  // M4.5 daily schedule ticker — foreground process, deterministic slots.
  // NINJA_SCHEDULE_TICK_MS overrides the interval (tests); default 60 s.
  const scheduleTickMs = Math.max(250, Number(process.env.NINJA_SCHEDULE_TICK_MS) || 60_000);
  const scheduleTimer = setInterval(() => {
    snaps()
      .tickSchedules()
      .then((fired) => {
        if (fired.length) console.error(`[schedule] ran ${fired.length} slot(s)`);
      })
      .catch((error) => console.error('[schedule] tick failed:', error));
  }, scheduleTickMs);
  scheduleTimer.unref();

  // M5A/M5B worker sweep — this long-lived serve process is the reconciler
  // of record (plan §5): polls accepted/dispatching operations for receipts
  // AND drains the batch dispatch queue (queued targets resume after a
  // restart — the queue is durable, not in-memory).
  // NINJA_RECONCILE_TICK_MS overrides the interval; 0 disables the sweep.
  const reconcileMs = Number(process.env.NINJA_RECONCILE_TICK_MS ?? 45_000);
  const reconcileTimer = reconcileMs > 0
    ? setInterval(() => {
        const svc = ops();
        svc.dispatchQueued()
          .catch((error) => console.error('[dispatch] queue drain failed:', error instanceof Error ? error.message : error));
        const pending = svc.listPendingReconcile(10);
        for (const row of pending) {
          svc
            .reconcile(String(row.id))
            .catch((error) => console.error(`[reconcile] op ${String(row.id).slice(0, 8)} failed:`, error instanceof Error ? error.message : error));
        }
        try {
          const ing = infra().processIngestionJobs(10);
          if (ing.errors > 0) console.error(`[ingest] ${ing.errors} extraction error(s) this pass`);
          // REVIEW-1: findings become proposed review items — bounded,
          // idempotent (fingerprint dedupe), local records only.
          const orgs = requireStore(mcp).listOrganizations();
          for (const o of orgs) {
            const imp = review().importFindings(Number(o.org_id));
            if (imp.imported > 0) console.error(`[review] imported ${imp.imported} finding(s) for org ${o.org_id}`);
            const re = review().reassessDecidedItems(Number(o.org_id));
            if (re.flagged > 0) console.error(`[review] flagged ${re.flagged} item(s) for reassessment in org ${o.org_id}`);
          }
        } catch (error) {
          console.error('[ingest] worker pass failed:', error instanceof Error ? error.message : error);
        }
      }, Math.max(1000, reconcileMs))
    : null;
  reconcileTimer?.unref();

  // Controlled job scheduler — opt-in via NINJA_SYNC_INTERVAL_MINUTES.
  const intervalMinutes = Number(process.env.NINJA_SYNC_INTERVAL_MINUTES || 0);
  let timer: NodeJS.Timeout | null = null;
  if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
    timer = setInterval(() => {
      mcp.executeToolCall('sync_entities', {}, 'scheduler').then(
        () => console.error(`[scheduler] sync_entities completed`),
        (error) => console.error(`[scheduler] sync_entities failed:`, error),
      );
    }, intervalMinutes * 60_000);
    timer.unref();
    console.error(`[scheduler] entity sync every ${intervalMinutes} minute(s)`);
  }

  const shutdown = async (signal: string) => {
    console.error(`${signal} — shutting down local server`);
    if (timer) clearInterval(timer);
    clearInterval(scheduleTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: HOST, port: PORT });
  console.error(`ninjaone local server on http://${HOST}:${PORT} (loopback only, bearer required)`);
}

main().catch((error) => {
  console.error('Local server startup failed:', error);
  process.exit(1);
});
