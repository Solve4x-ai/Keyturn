/**
 * Settings service — the administrative surface behind the Settings page.
 *
 * Everything here is local: env-file parsing, the policy file, the OAuth
 * token file, and MCP client config discovery/merge. The only network
 * calls are explicit user-triggered checks (credential test, PKCE
 * reconnect). Write paths are passkey-gated at the route layer when
 * approver keys are enrolled; secrets are write-only and never returned
 * to the UI.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseDotenv } from 'dotenv';
import { parsePolicy, type LocalPolicy } from './security-profile.js';
import { withTokenLock } from './oauth-user.js';

const REGION_MAP: Record<string, string> = {
  us: 'https://app.ninjarmm.com',
  us2: 'https://us2.ninjarmm.com',
  eu: 'https://eu.ninjarmm.com',
  ca: 'https://ca.ninjarmm.com',
  oc: 'https://oc.ninjarmm.com',
};

/** Keys the UI may write into each profile's env file. Anything else (policy path, auth profile) stays hand-managed. */
const ENV_KEYS: Record<string, string[]> = {
  reporting: ['NINJA_CLIENT_ID', 'NINJA_CLIENT_SECRET', 'NINJA_BASE_URL', 'NINJA_SCOPES'],
  command: ['NINJA_NATIVE_CLIENT_ID', 'NINJA_BASE_URL', 'NINJA_REDIRECT_URI', 'NINJA_SCOPES'],
};
const SECRET_KEYS = new Set(['NINJA_CLIENT_SECRET']);

interface McpClient {
  id: string;
  name: string;
  format: 'json' | 'toml';
  /** Candidate config paths, in priority order; first existing wins for "detected", first overall is the write target. */
  paths: string[];
}

/**
 * The MSIX (Store/winget) build of Claude Desktop runs virtualized: its
 * `%APPDATA%\Claude` is redirected to
 * `%LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\Claude`.
 * The package folder only exists when that build is installed.
 */
function claudePackagedConfigs(appData: string): string[] {
  const packages = join(dirname(appData), 'Local', 'Packages');
  try {
    return readdirSync(packages, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^Claude_[a-z0-9]+$/i.test(d.name))
      .map((d) => join(packages, d.name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } catch {
    return [];
  }
}

function clientPaths(home: string, appData: string, platform: NodeJS.Platform): McpClient[] {
  const mac = (p: string) => join(home, 'Library', 'Application Support', p);
  return [
    {
      id: 'devin',
      name: 'Devin',
      format: 'json',
      paths:
        platform === 'win32'
          ? [join(appData, 'devin', 'mcp_config.json')]
          : platform === 'darwin'
            ? [join(home, '.config', 'devin', 'mcp_config.json')]
            : [join(home, '.config', 'devin', 'mcp_config.json')],
    },
    { id: 'cursor', name: 'Cursor', format: 'json', paths: [join(home, '.cursor', 'mcp.json')] },
    {
      id: 'windsurf',
      name: 'Windsurf',
      format: 'json',
      paths: [join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    },
    {
      id: 'claude',
      name: 'Claude Desktop',
      format: 'json',
      paths:
        platform === 'win32'
          ? [...claudePackagedConfigs(appData), join(appData, 'Claude', 'claude_desktop_config.json')]
          : platform === 'darwin'
            ? [mac('Claude/claude_desktop_config.json')]
            : [join(home, '.config', 'Claude', 'claude_desktop_config.json')],
    },
    { id: 'codex', name: 'Codex CLI', format: 'toml', paths: [join(home, '.codex', 'config.toml')] },
  ];
}

export class SettingsError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type ReconnectState = 'idle' | 'waiting' | 'exchanging' | 'done' | 'error';
interface ReconnectPending {
  state: ReconnectState;
  error?: string | undefined;
  authorizationUrl?: string | undefined;
  server?: Server | undefined;
  timeout?: NodeJS.Timeout | undefined;
  verifier?: string | undefined;
  expectedState?: string | undefined;
  startedAt?: number | undefined;
}

export class SettingsService {
  private reconnect: ReconnectPending = { state: 'idle' };
  /** How the consent page is opened; tests replace it. */
  opener: (url: string) => void = openBrowser;

  constructor(
    private readonly root: string,
    private readonly home: string = homedir(),
    private readonly appData: string = process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private envPath(profile: string): string {
    return join(this.root, 'config', `${profile}.env`);
  }

  private envMap(profile: string): Record<string, string> {
    const path = this.envPath(profile);
    if (!existsSync(path)) return {};
    try {
      return parseDotenv(readFileSync(path));
    } catch {
      return {};
    }
  }

  /** Same resolution as the runtime (`NINJA_TOKEN_PATH` wins for the running profile), so both lock the same file. */
  private tokenPath(profile: string): string {
    const configured = (process.env.NINJA_TOKEN_PATH || '').trim();
    if (configured && (process.env.NINJA_AUTH_PROFILE || '').trim().toLowerCase() === profile) return resolve(configured);
    return join(this.home, '.ninjaone-mcp', profile, 'tokens.json');
  }

  private policyPath(): string {
    return (process.env.NINJA_POLICY_PATH || '').trim() || join(this.root, 'config', 'policy.json');
  }

  /* ── Status ────────────────────────────────────────────────────────── */

  status() {
    const profiles = (['reporting', 'command'] as const).map((profile) => {
      const env = this.envMap(profile);
      const required =
        profile === 'reporting'
          ? ['NINJA_CLIENT_ID', 'NINJA_CLIENT_SECRET', 'NINJA_BASE_URL']
          : ['NINJA_NATIVE_CLIENT_ID', 'NINJA_BASE_URL'];
      const missing = required.filter((k) => !(env[k] || '').trim());
      const tokenFile = this.tokenPath(profile);
      let token: Record<string, unknown> | null = null;
      if (existsSync(tokenFile)) {
        try {
          const stored = JSON.parse(readFileSync(tokenFile, 'utf8'));
          token = {
            path: tokenFile,
            savedAt: typeof stored.saved_at === 'number' ? stored.saved_at : null,
            scope: typeof stored.scope === 'string' ? stored.scope : null,
            baseUrl: typeof stored.base_url === 'string' ? stored.base_url : null,
          };
        } catch {
          token = { path: tokenFile, savedAt: null, unreadable: true };
        }
      }
      return {
        profile,
        envPath: this.envPath(profile),
        envPresent: existsSync(this.envPath(profile)),
        configured: missing.length === 0,
        missing,
        baseUrl: (env.NINJA_BASE_URL || '').trim() || null,
        clientId: (env.NINJA_CLIENT_ID || env.NINJA_NATIVE_CLIENT_ID || '').trim() || null,
        redirectUri: (env.NINJA_REDIRECT_URI || '').trim() || null,
        scopes: (env.NINJA_SCOPES || '').trim() || null,
        token,
      };
    });

    const policyPath = this.policyPath();
    let policy: { path: string; present: boolean; hash?: string; value?: LocalPolicy; error?: string } = {
      path: policyPath,
      present: false,
    };
    if (existsSync(policyPath)) {
      try {
        const raw = JSON.parse(readFileSync(policyPath, 'utf8'));
        const value = parsePolicy(raw);
        policy = {
          path: policyPath,
          present: true,
          hash: `sha256:${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16)}`,
          value,
        };
      } catch (error) {
        policy = { path: policyPath, present: true, error: error instanceof Error ? error.message : String(error) };
      }
    }

    return {
      profiles,
      policy,
      clients: this.clients(),
      runtime: {
        root: this.root,
        serveTokenPath: join(this.home, '.ninjaone-mcp', 'serve.token'),
        uptimeSec: Math.round(process.uptime()),
      },
    };
  }

  /* ── Credential env files ──────────────────────────────────────────── */

  /**
   * Replace allowlisted keys in `config/<profile>.env`, preserving order,
   * comments, and line endings. Unknown keys are ignored; blank values leave
   * the current value unchanged (secrets are write-only, so blank = keep).
   */
  updateEnv(profile: string, values: Record<string, unknown>) {
    if (profile !== 'reporting' && profile !== 'command') {
      throw new SettingsError('bad_profile', 'profile must be reporting or command');
    }
    const allowed = new Set(ENV_KEYS[profile]);
    const updates: Record<string, string> = {};
    for (const [key, raw] of Object.entries(values ?? {})) {
      if (!allowed.has(key)) continue;
      const value = String(raw ?? '').trim();
      if (value) updates[key] = envValue(key, value);
    }
    if (!Object.keys(updates).length) throw new SettingsError('empty_update', 'no recognized keys to update');

    const path = this.envPath(profile);
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw ? raw.split(/\r?\n/) : [];
    if (lines.at(-1) === '') lines.pop();
    const seen = new Set<string>();
    const out = lines.map((line) => {
      const m = /^([A-Z0-9_]+)\s*=/.exec(line);
      if (!m || !(m[1]! in updates)) return line;
      seen.add(m[1]!);
      return `${m[1]}=${updates[m[1]!]}`;
    });
    for (const [key, value] of Object.entries(updates)) {
      if (!seen.has(key)) out.push(`${key}=${value}`);
    }
    this.atomicWrite(path, `${out.join(eol)}${eol}`);
    return { path, updated: Object.keys(updates) };
  }

  /* ── Live credential checks ────────────────────────────────────────── */

  /** Exchange credentials for a token to prove they work — read-only test, rotates nothing on failure. */
  async testConnection(profile: string): Promise<{ ok: boolean; detail: string; checkedAt: number }> {
    const env = this.envMap(profile);
    const baseUrl = this.resolveBaseUrl(env);
    const checkedAt = Date.now();
    try {
      if (profile === 'reporting') {
        const clientId = (env.NINJA_CLIENT_ID || '').trim();
        const clientSecret = env.NINJA_CLIENT_SECRET || '';
        if (!clientId || !clientSecret) {
          return { ok: false, detail: 'NINJA_CLIENT_ID / NINJA_CLIENT_SECRET not set', checkedAt };
        }
        const res = await fetch(`${baseUrl}/ws/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: (env.NINJA_SCOPES || 'monitoring').trim(),
          }).toString(),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return res.ok && typeof body.access_token === 'string'
          ? { ok: true, detail: `client_credentials accepted — token valid ${Math.round(Number(body.expires_in ?? 0) / 60)} min`, checkedAt }
          : { ok: false, detail: `${res.status} ${String(body.error_description || body.error || res.statusText)}`, checkedAt };
      }

      if (profile === 'command') {
        const clientId = (env.NINJA_NATIVE_CLIENT_ID || '').trim();
        if (!clientId) return { ok: false, detail: 'NINJA_NATIVE_CLIENT_ID not set', checkedAt };
        const tokenFile = this.tokenPath('command');
        if (!existsSync(tokenFile)) {
          return { ok: false, detail: 'no stored token — use Reconnect to authorize', checkedAt };
        }
        // Refresh tokens are single-use and rotate. Take the runtime's
        // cross-process lock and re-read inside it — otherwise a concurrent
        // refresh by a live server spends the same token and one side burns it.
        return await withTokenLock(async () => {
          const stored = JSON.parse(readFileSync(tokenFile, 'utf8')) as Record<string, unknown>;
          if (typeof stored.refresh_token !== 'string') {
            return { ok: false, detail: 'token file has no refresh_token — reconnect', checkedAt };
          }
          const res = await fetch(`${String(stored.base_url || baseUrl)}/ws/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: stored.refresh_token,
              client_id: clientId,
            }).toString(),
          });
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (!res.ok || typeof body.access_token !== 'string') {
            return {
              ok: false,
              detail: `${res.status} ${String(body.error_description || body.error || 'refresh rejected')} — reconnect required`,
              checkedAt,
            };
          }
          // Refresh tokens rotate — persist the replacement the same way the
          // runtime does, or the file is left holding a burned token.
          this.saveTokens(tokenFile, {
            refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : stored.refresh_token,
            base_url: String(stored.base_url || baseUrl),
            scope: typeof body.scope === 'string' ? body.scope : String(stored.scope ?? ''),
            saved_at: Date.now(),
          });
          return { ok: true, detail: `refresh token healthy — scope ${String(body.scope || stored.scope || '')}`, checkedAt };
        }, tokenFile);
      }
      return { ok: false, detail: 'unknown profile', checkedAt };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }

  /* ── In-app PKCE reconnect (command profile) ───────────────────────── */

  startReconnect(): { state: ReconnectState; authorizationUrl?: string | undefined; error?: string | undefined } {
    if (this.reconnect.state === 'waiting' || this.reconnect.state === 'exchanging') {
      return { state: this.reconnect.state, authorizationUrl: this.reconnect.authorizationUrl };
    }
    const env = this.envMap('command');
    try {
      const clientId = (env.NINJA_NATIVE_CLIENT_ID || '').trim();
      if (!clientId) throw new SettingsError('not_configured', 'NINJA_NATIVE_CLIENT_ID is not set in config/command.env');
      if (env.NINJA_CLIENT_SECRET || env.NINJA_NATIVE_CLIENT_SECRET) {
        throw new SettingsError('has_secret', 'Native PKCE config must not contain a client secret');
      }
      const redirectUri = this.resolveRedirectUri(env);
      const baseUrl = this.resolveBaseUrl(env);
      const scopes = (env.NINJA_SCOPES || 'monitoring management offline_access').split(/\s+/).filter(Boolean);
      if (!scopes.includes('offline_access')) {
        throw new SettingsError('bad_scopes', 'NINJA_SCOPES must include offline_access for a refresh token');
      }
      if (scopes.includes('control')) {
        throw new SettingsError('bad_scopes', 'the control scope is intentionally disabled');
      }

      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const redirectValue = this.redirectUriValue(redirectUri);
      const authorizationUrl =
        `${baseUrl}/ws/oauth/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectValue,
          scope: scopes.join(' '),
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString();

      const pending: ReconnectPending = {
        state: 'waiting',
        authorizationUrl,
        verifier,
        expectedState: state,
        startedAt: Date.now(),
      };
      const port = redirectUri.port ? Number.parseInt(redirectUri.port, 10) : 80;
      const host = redirectUri.hostname.replace(/^\[|\]$/g, '');
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', redirectUri.origin);
        if (url.pathname !== redirectUri.pathname) {
          res.writeHead(404).end('Not found');
          return;
        }
        // Only the listener of the live attempt, and only once: a late or
        // duplicate callback must not start a second code exchange.
        if (this.reconnect.server !== server || this.reconnect.state !== 'waiting') {
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>No authorization in progress</h1><p>Start again from Settings.</p>');
          return;
        }
        const oauthError = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        // timingSafeEqual throws on unequal lengths — an uncaught throw here
        // would take down the whole local server.
        const got = Buffer.from(url.searchParams.get('state') ?? '', 'utf8');
        const want = Buffer.from(state, 'utf8');
        const okState = got.length === want.length && timingSafeEqual(want, got);
        if (oauthError || !okState || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Authorization failed</h1><p>You can close this tab and retry from Settings.</p>');
          this.finishReconnect(new Error(oauthError ? `denied: ${oauthError}` : !okState ? 'OAuth state mismatch' : 'no code returned'));
          return;
        }
        this.reconnect.state = 'exchanging';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Authorization complete</h1><p>You can close this tab — Keyturn is finishing up.</p>');
        void this.exchangeReconnectCode(code, baseUrl, clientId, redirectValue, verifier);
      });
      pending.server = server;
      pending.timeout = setTimeout(() => this.finishReconnect(new Error('timed out waiting for consent')), 5 * 60 * 1000);
      server.on('error', (error) => this.finishReconnect(error));
      server.listen(port, host, () => {
        this.opener(authorizationUrl);
      });
      this.reconnect = pending;
      return { state: 'waiting', authorizationUrl };
    } catch (error) {
      this.reconnect = { state: 'error', error: error instanceof Error ? error.message : String(error) };
      return this.reconnectStatus();
    }
  }

  reconnectStatus(): ReconnectPending {
    return {
      state: this.reconnect.state,
      error: this.reconnect.error,
      authorizationUrl: this.reconnect.authorizationUrl,
      startedAt: this.reconnect.startedAt,
    };
  }

  cancelReconnect() {
    this.teardownReconnect();
    this.reconnect = { state: 'idle' };
    return this.reconnectStatus();
  }

  private teardownReconnect() {
    if (this.reconnect.timeout) clearTimeout(this.reconnect.timeout);
    this.reconnect.server?.close();
  }

  private finishReconnect(error: Error) {
    this.teardownReconnect();
    this.reconnect = { ...this.reconnect, state: 'error', error: error.message, server: undefined, timeout: undefined };
  }

  private async exchangeReconnectCode(code: string, baseUrl: string, clientId: string, redirectUri: string, verifier: string) {
    this.reconnect.state = 'exchanging';
    try {
      const res = await fetch(`${baseUrl}/ws/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body.refresh_token !== 'string') {
        throw new Error(`${res.status} ${String(body.error_description || body.error || 'token exchange failed')}`);
      }
      const tokenFile = this.tokenPath('command');
      const refreshToken = body.refresh_token;
      await withTokenLock(async () => {
        this.saveTokens(tokenFile, {
          refresh_token: refreshToken,
          base_url: baseUrl,
          scope: typeof body.scope === 'string' ? body.scope : '',
          saved_at: Date.now(),
        });
      }, tokenFile);
      this.teardownReconnect();
      this.reconnect = { state: 'done' };
    } catch (error) {
      this.finishReconnect(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private saveTokens(path: string, tokens: Record<string, unknown>) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  /* ── Policy file ───────────────────────────────────────────────────── */

  readPolicy(): { path: string; raw: Record<string, unknown> | null; hash: string | null; error?: string } {
    const path = this.policyPath();
    if (!existsSync(path)) return { path, raw: null, hash: null };
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      parsePolicy(raw); // validation — throws on malformed shape
      return { path, raw, hash: policyHash(raw) };
    } catch (error) {
      return { path, raw: null, hash: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Validate, back up, and atomically replace the policy file. Returns the new hash. */
  writePolicy(raw: unknown): { path: string; hash: string; backup: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SettingsError('bad_policy', 'policy must be a JSON object');
    }
    parsePolicy(raw); // throws on malformed shape — normalized view, extras preserved on write
    const path = this.policyPath();
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    const backup = existsSync(path) ? `${path}.bak-${Date.now()}` : '';
    if (backup) writeFileSync(backup, readFileSync(path), { mode: 0o600 });
    this.atomicWrite(path, text);
    return { path, hash: policyHash(raw), backup };
  }

  /* ── MCP client config ─────────────────────────────────────────────── */

  clients() {
    return clientPaths(this.home, this.appData, this.platform).map((c) => {
      const existing = c.paths.find((p) => existsSync(p));
      return {
        id: c.id,
        name: c.name,
        format: c.format,
        detected: !!existing,
        path: existing ?? c.paths[0]!,
      };
    });
  }

  /** The server entries Keyturn registers in a client config. */
  private serverEntries(): Record<string, Record<string, unknown>> {
    // Absolute dotenv path: some clients (Claude Desktop) ignore `cwd`, and a
    // bare `dotenv/config` would then fail to resolve.
    const base = {
      command: process.execPath,
      args: ['--require', join(this.root, 'node_modules', 'dotenv', 'config.js'), join(this.root, 'dist', 'index.js')],
      cwd: this.root,
    };
    return {
      'ninjaone-command': { ...base, env: { DOTENV_CONFIG_PATH: join(this.root, 'config', 'command.env') } },
      'ninjaone-reporting': { ...base, env: { DOTENV_CONFIG_PATH: join(this.root, 'config', 'reporting.env') } },
    };
  }

  /** The config block Keyturn wants in a client, as text for copy or merge. */
  configBlock(format: 'json' | 'toml'): { block: string } {
    if (format === 'json') {
      return { block: `"mcpServers": ${JSON.stringify(this.serverEntries(), null, 2)}` };
    }
    const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const block = Object.entries(this.serverEntries())
      .map(([name, e]) => {
        const env = (e.env ?? {}) as Record<string, string>;
        const envLines = Object.entries(env)
          .map(([k, v]) => `${k} = ${literal(v)}`)
          .join('\n');
        return (
          `[mcp_servers.${name}]\n` +
          `command = ${literal(String(e.command))}\n` +
          `args = [${(e.args as string[]).map(literal).join(', ')}]\n` +
          `cwd = ${literal(String(e.cwd))}\n\n` +
          `[mcp_servers.${name}.env]\n${envLines}\n`
        );
      })
      .join('\n');
    return { block };
  }

  /** Merge Keyturn's server entries into a client's config file (backup first). */
  mergeClientConfig(clientId: string): { path: string; backup: string | null; merged: string[] } {
    const client = clientPaths(this.home, this.appData, this.platform).find((c) => c.id === clientId);
    if (!client) throw new SettingsError('unknown_client', 'unknown MCP client');
    const target = client.paths.find((p) => existsSync(p)) ?? client.paths[0]!;

    let backup: string | null = null;
    if (existsSync(target)) {
      backup = `${target}.bak-${Date.now()}`;
      writeFileSync(backup, readFileSync(target), { mode: 0o600 });
    }

    if (client.format === 'json') {
      let doc: Record<string, unknown> = {};
      if (existsSync(target)) {
        try {
          doc = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
        } catch {
          throw new SettingsError('invalid_json', `${target} is not valid JSON — backup kept at ${backup}`);
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new SettingsError('invalid_json', `${target} must contain a JSON object`);
        }
      }
      const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>;
      // Update our entries in place — keep any per-entry keys the operator
      // added (disabled, alwaysAllow, extra env vars…).
      for (const [name, entry] of Object.entries(this.serverEntries())) {
        const prior = isObject(servers[name]) ? (servers[name] as Record<string, unknown>) : {};
        const priorEnv = isObject(prior.env) ? (prior.env as Record<string, unknown>) : {};
        servers[name] = { ...prior, ...entry, env: { ...priorEnv, ...(entry.env as Record<string, unknown>) } };
      }
      doc.mcpServers = servers;
      this.atomicWrite(target, `${JSON.stringify(doc, null, 2)}\n`);
      return { path: target, backup, merged: ['ninjaone-command', 'ninjaone-reporting'] };
    }

    // TOML (Codex): replace only the tables Keyturn owns, in place;
    // operator-added sub-tables (per-tool approval_mode…) are kept.
    const text = existsSync(target) ? readFileSync(target, 'utf8') : '';
    this.atomicWrite(target, replaceTomlTables(text, OWNED_TOML_TABLES, `${TOML_MARKER}\n${this.configBlock('toml').block}`));
    return { path: target, backup, merged: ['ninjaone-command', 'ninjaone-reporting'] };
  }

  /* ── Internals ─────────────────────────────────────────────────────── */

  private atomicWrite(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  }

  private resolveBaseUrl(env: Record<string, string>): string {
    const explicit = (env.NINJA_BASE_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const region = (env.NINJA_REGION || '').trim().toLowerCase();
    if (region && REGION_MAP[region]) return REGION_MAP[region];
    throw new SettingsError('no_base_url', 'NINJA_BASE_URL (or NINJA_REGION) is not set');
  }

  private resolveRedirectUri(env: Record<string, string>): URL {
    const configured = (env.NINJA_REDIRECT_URI || '').trim();
    if (!configured) {
      throw new SettingsError('no_redirect', 'NINJA_REDIRECT_URI is not set in config/command.env');
    }
    const url = new URL(configured);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw new SettingsError('bad_redirect', 'NINJA_REDIRECT_URI must be http on a loopback host');
    }
    return url;
  }

  private redirectUriValue(url: URL): string {
    return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.toString();
  }
}

const isObject = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

/** Serialize a value so dotenv reads it back verbatim: whitespace, `#`, and quotes force quoting. */
function envValue(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new SettingsError('bad_value', `${key} must be a single line`);
  if (!/[\s#'"`]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`; // single quotes are literal in dotenv
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new SettingsError('bad_value', `${key} contains characters that cannot be quoted safely — edit the file directly`);
}

const TOML_MARKER = '# Keyturn — NinjaOne connector';
/** Markers written by earlier versions — stripped on merge so they never pile up. */
const LEGACY_TOML_MARKERS = new Set(['# Mission Control — NinjaOne connector']);
const OWNED_TOML_TABLES = new Set([
  'mcp_servers.ninjaone-command',
  'mcp_servers.ninjaone-command.env',
  'mcp_servers.ninjaone-reporting',
  'mcp_servers.ninjaone-reporting.env',
]);

/**
 * Line-level TOML table surgery. Drops every table whose header is in
 * `owned` (header through the line before the next header) plus our marker
 * comment, and puts `block` where the first owned table was — or at the end.
 * Bracket depth is tracked so a multi-line array is never read as a header.
 */
export function replaceTomlTables(text: string, owned: Set<string>, block: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  let skipping = false;
  let insertAt = -1;
  let depth = 0;
  for (const line of text ? text.split(/\r?\n/) : []) {
    const header = depth === 0 ? /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line) : null;
    if (header) {
      skipping = owned.has(normalizeTomlKey(header[1]!));
      if (skipping && insertAt < 0) insertAt = out.length;
    } else {
      if (depth === 0 && /^\s*\[\[/.test(line)) skipping = false;
      depth = Math.max(0, depth + bracketDelta(line));
    }
    if (skipping || line.trim() === TOML_MARKER || LEGACY_TOML_MARKERS.has(line.trim())) continue;
    out.push(line);
  }
  while (out.length && out.at(-1)!.trim() === '') out.pop();
  const lines = block.trimEnd().split(/\r?\n/);
  if (!out.length) out.push(...lines);
  else if (insertAt < 0 || insertAt >= out.length) out.push('', ...lines);
  else out.splice(insertAt, 0, ...lines, '');
  return `${out.join(eol)}${eol}`;
}

function normalizeTomlKey(key: string): string {
  return (key.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) ?? [])
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .join('.');
}

/** Net `[` minus `]` on a line, ignoring strings and comments. */
function bracketDelta(line: string): number {
  let delta = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') delta++;
    else if (c === ']') delta--;
  }
  return delta;
}

/** Binding subject for passkey-gated settings writes — the exact payload hash. */
export function policyHash(policy: unknown): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const arg = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  // A missing opener (headless box) emits 'error' — unhandled, that would
  // crash the server; the UI already shows the URL as a manual fallback.
  const child = spawn(cmd, arg, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
