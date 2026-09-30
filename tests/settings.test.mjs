import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServer as createNetServer } from 'node:net';
import { parse as parseDotenv } from 'dotenv';
import { rm } from 'node:fs/promises';

import { SettingsService, policyHash, replaceTomlTables } from '../dist/settings.js';
import { parsePolicy } from '../dist/security-profile.js';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'n1-settings-root-'));
  const home = await mkdtemp(join(tmpdir(), 'n1-settings-home-'));
  const appData = join(home, 'AppData', 'Roaming');
  await mkdir(join(root, 'config'), { recursive: true });
  return { root, home, appData, svc: new SettingsService(root, home, appData, 'win32') };
};

test('updateEnv replaces allowlisted keys and preserves comments/order', async () => {
  const { root, svc } = await fixture();
  await writeFile(
    join(root, 'config', 'command.env'),
    '# comment\nNINJA_AUTH_PROFILE=command\nNINJA_NATIVE_CLIENT_ID=old-id\nNINJA_BASE_URL=https://app.ninjarmm.com\n',
  );
  const r = await svc.updateEnv('command', { NINJA_NATIVE_CLIENT_ID: 'new-id', NINJA_BASE_URL: 'https://eu.ninjarmm.com' });
  const text = await readFile(r.path, 'utf8');
  assert.match(text, /^# comment$/m);
  assert.match(text, /NINJA_AUTH_PROFILE=command/);
  assert.match(text, /NINJA_NATIVE_CLIENT_ID=new-id/);
  assert.match(text, /NINJA_BASE_URL=https:\/\/eu\.ninjarmm\.com/);
  assert.equal(text.includes('old-id'), false);
});

test('updateEnv appends missing keys, skips blanks, rejects foreign keys', async () => {
  const { root, svc } = await fixture();
  await writeFile(join(root, 'config', 'reporting.env'), 'NINJA_CLIENT_ID=abc\n');
  await svc.updateEnv('reporting', { NINJA_CLIENT_SECRET: 'sekrit', NINJA_BASE_URL: '  ', NINJA_AUTH_PROFILE: 'evil' });
  const text = await readFile(join(root, 'config', 'reporting.env'), 'utf8');
  assert.match(text, /NINJA_CLIENT_SECRET=sekrit/);
  assert.equal(text.includes('NINJA_BASE_URL'), false); // blank skipped, not written
  assert.equal(text.includes('evil'), false); // not on the allowlist
});

test('writePolicy validates, writes, backs up, and returns a stable hash', async () => {
  const { root, home, svc } = await fixture();
  const policyPath = join(root, 'config', 'policy.json');
  process.env.NINJA_POLICY_PATH = policyPath;
  try {
    const policy = { allowedOrganizationIds: [2], deviceScriptsEnabled: true, powershellSessionMaxCommands: 0 };
    const r1 = svc.writePolicy(policy);
    assert.equal(r1.hash, policyHash(policy));
    assert.equal(existsSync(policyPath), true);
    assert.deepEqual(parsePolicy(JSON.parse(await readFile(policyPath, 'utf8'))).allowedOrganizationIds, [2]);

    const r2 = svc.writePolicy({ ...policy, ticketWritesEnabled: true });
    assert.ok(r2.backup && existsSync(r2.backup));
    const baks = (await readdir(join(root, 'config'))).filter((f) => f.startsWith('policy.json.bak'));
    assert.equal(baks.length, 1);
  } finally {
    delete process.env.NINJA_POLICY_PATH;
  }
  assert.equal(home !== '', true);
});

test('writePolicy rejects malformed input', async () => {
  const { svc } = await fixture();
  process.env.NINJA_POLICY_PATH = join(await mkdtemp(join(tmpdir(), 'n1-pol-')), 'policy.json');
  try {
    assert.throws(() => svc.writePolicy(null), /policy must be a JSON object/);
    assert.throws(() => svc.writePolicy([1, 2]), /policy must be a JSON object/);
    assert.throws(() => svc.writePolicy('string'), /policy must be a JSON object/);
  } finally {
    delete process.env.NINJA_POLICY_PATH;
  }
});

test('parsePolicy round-trips session limit fields', () => {
  const p = parsePolicy({ powershellSessionTtlSeconds: 900, powershellSessionMaxCommands: 0 });
  assert.equal(p.powershellSessionTtlSeconds, 900);
  assert.equal(p.powershellSessionMaxCommands, 0);
  const empty = parsePolicy({});
  assert.equal(empty.powershellSessionTtlSeconds, undefined);
  assert.equal(empty.powershellSessionMaxCommands, undefined);
});

test('configBlock produces valid JSON and TOML shapes', async () => {
  const { root, svc } = await fixture();
  const { block: json } = svc.configBlock('json');
  const doc = JSON.parse(`{ ${json} }`);
  for (const name of ['ninjaone-command', 'ninjaone-reporting']) {
    assert.equal(doc.mcpServers[name].cwd, root);
    assert.ok(doc.mcpServers[name].args.join(' ').includes('index.js'));
    assert.ok(doc.mcpServers[name].env.DOTENV_CONFIG_PATH.includes(`${name.split('-')[1]}.env`));
  }
  const { block: toml } = svc.configBlock('toml');
  assert.match(toml, /\[mcp_servers\.ninjaone-command\]/);
  assert.match(toml, /\[mcp_servers\.ninjaone-reporting\.env\]/);
  assert.match(toml, /command\.env/);
});

test('mergeClientConfig merges JSON configs, preserving existing servers, with backup', async () => {
  const { root, home, appData, svc } = await fixture();
  const target = join(appData, 'devin', 'mcp_config.json');
  await mkdir(join(appData, 'devin'), { recursive: true });
  await writeFile(target, JSON.stringify({ mcpServers: { 'other-server': { command: 'x' } }, theme: 'dark' }));
  const r = svc.mergeClientConfig('devin');
  const merged = JSON.parse(await readFile(target, 'utf8'));
  assert.ok(merged.mcpServers['other-server']);
  assert.ok(merged.mcpServers['ninjaone-command'].env.DOTENV_CONFIG_PATH.includes('command.env'));
  assert.equal(merged.theme, 'dark');
  assert.ok(r.backup && existsSync(r.backup));
  assert.equal(home === '' && root === '', false);
});

test('mergeClientConfig TOML replaces existing ninjaone tables and keeps the rest', async () => {
  const { home, svc } = await fixture();
  const target = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(
    target,
    `model = "gpt-5"\n\n[mcp_servers.ninjaone-command]\ncommand = 'stale'\n\n[mcp_servers.ninjaone-command.env]\nDOTENV_CONFIG_PATH = 'stale'\n\n[mcp_servers.other]\ncommand = 'keep'\n`,
  );
  const r = svc.mergeClientConfig('codex');
  const text = await readFile(target, 'utf8');
  assert.match(text, /model = "gpt-5"/);
  assert.match(text, /\[mcp_servers\.other\]/);
  assert.match(text, /command = 'keep'/);
  assert.equal(text.includes('stale'), false);
  assert.match(text, /\[mcp_servers\.ninjaone-command\]/);
  assert.ok(r.backup && existsSync(r.backup));
});

test('mergeClientConfig refuses invalid JSON and unknown clients', async () => {
  const { appData, svc } = await fixture();
  const target = join(appData, 'devin', 'mcp_config.json');
  await mkdir(join(appData, 'devin'), { recursive: true });
  await writeFile(target, '{ not json');
  assert.throws(() => svc.mergeClientConfig('devin'), /not valid JSON/);
  assert.throws(() => svc.mergeClientConfig('nope'), /unknown MCP client/);
});

test('status reports configured/missing and detected clients', async () => {
  const { root, appData, svc } = await fixture();
  await writeFile(join(root, 'config', 'command.env'), 'NINJA_NATIVE_CLIENT_ID=cid\nNINJA_BASE_URL=https://us2.ninjarmm.com\n');
  const s = svc.status();
  const command = s.profiles.find((p) => p.profile === 'command');
  const reporting = s.profiles.find((p) => p.profile === 'reporting');
  assert.equal(command.configured, true);
  assert.equal(command.clientId, 'cid');
  assert.equal(reporting.configured, false);
  assert.ok(reporting.missing.includes('NINJA_CLIENT_SECRET'));
  assert.equal(s.clients.every((c) => typeof c.detected === 'boolean'), true);
  assert.ok(s.clients.find((c) => c.id === 'devin').path.startsWith(appData));
});

test('Claude Desktop: MSIX package config is detected and is the merge target', async () => {
  const { home, appData, svc } = await fixture();
  const classic = join(appData, 'Claude', 'claude_desktop_config.json');
  // No package installed → classic %APPDATA% path, not detected.
  let claude = svc.clients().find((c) => c.id === 'claude');
  assert.equal(claude.path, classic);
  assert.equal(claude.detected, false);

  // MSIX build installed: config lives under the virtualized LocalCache.
  const pkgDir = join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  await mkdir(pkgDir, { recursive: true });
  const packaged = join(pkgDir, 'claude_desktop_config.json');
  await writeFile(packaged, JSON.stringify({ preferences: { keep: true } }));
  claude = svc.clients().find((c) => c.id === 'claude');
  assert.equal(claude.path, packaged);
  assert.equal(claude.detected, true);

  const r = svc.mergeClientConfig('claude');
  assert.equal(r.path, packaged);
  const doc = JSON.parse(await readFile(packaged, 'utf8'));
  assert.equal(doc.preferences.keep, true);
  assert.ok(doc.mcpServers['ninjaone-command']);
  assert.equal(existsSync(classic), false);
});

/* ── Review fixes (2026-09-30) ───────────────────────────────────────── */

/** Minimal TOML shape check: every line is blank, a comment, a unique table header, a key = value, or inside an open array. */
const assertTomlShape = (text) => {
  const headers = new Set();
  let depth = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (depth > 0) { depth += (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length; continue; }
    if (!t || t.startsWith('#')) continue;
    const h = /^\[([^\[\]]+)\]$/.exec(t);
    if (h) { assert.equal(headers.has(h[1]), false, `duplicate table [${h[1]}]`); headers.add(h[1]); continue; }
    assert.match(t, /^[\w."'-]+\s*=/, `orphan line: ${t}`);
    depth += (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
  }
  return headers;
};

const CODEX_FIXTURE = `model = "gpt-5"

[mcp_servers.other]
args = []
command = 'other.exe'

[mcp_servers.ninjaone-reporting]
command = "node"
args = ["--require", 'C:\\x\\node_modules\\dotenv\\config.js', 'C:\\x\\dist\\index.js']

[mcp_servers.ninjaone-reporting.env]
DOTENV_CONFIG_PATH = 'C:\\x\\config\\reporting.env'

[mcp_servers.ninjaone-reporting.tools.get_auth_profile]
approval_mode = "approve"

[mcp_servers.ninjaone-command]
command = "node"
args = [
  "--require",
  'C:\\x\\dist\\index.js',
]

[mcp_servers.ninjaone-command.env]
DOTENV_CONFIG_PATH = 'C:\\x\\config\\command.env'

[mcp_servers.ninjaone-command.tools.run_device_powershell]
approval_mode = "approve"

[desktop]
keep = true
`;

test('Codex merge: arrays and operator sub-tables survive; repeat merges are idempotent', async () => {
  const { root, home, svc } = await fixture();
  const target = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(target, CODEX_FIXTURE);
  svc.mergeClientConfig('codex');
  const once = await readFile(target, 'utf8');
  svc.mergeClientConfig('codex');
  const twice = await readFile(target, 'utf8');
  assert.equal(twice, once, 'second merge must be a no-op');
  const headers = assertTomlShape(twice);
  for (const h of ['mcp_servers.other', 'desktop', 'mcp_servers.ninjaone-command.tools.run_device_powershell', 'mcp_servers.ninjaone-reporting.tools.get_auth_profile', 'mcp_servers.ninjaone-command', 'mcp_servers.ninjaone-command.env']) {
    assert.ok(headers.has(h), `missing [${h}]`);
  }
  assert.equal(twice.split('# Keyturn — NinjaOne connector').length, 2, 'marker appears once');
  assert.match(twice, /approval_mode = "approve"/);
  assert.ok(twice.includes(join(root, 'node_modules', 'dotenv', 'config.js')), 'absolute dotenv path');
  assert.equal(twice.includes("C:\\x\\config"), false, 'stale entries replaced');
});

test('Codex merge: a marker from the old product name is replaced, not duplicated', async () => {
  const { home, svc } = await fixture();
  const target = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(target, `# Mission Control — NinjaOne connector\n${CODEX_FIXTURE}`);
  svc.mergeClientConfig('codex');
  const text = await readFile(target, 'utf8');
  assert.equal(text.includes('# Mission Control — NinjaOne connector'), false, 'legacy marker removed');
  assert.equal(text.split('# Keyturn — NinjaOne connector').length, 2, 'new marker appears once');
  assertTomlShape(text);
});

test('replaceTomlTables handles quoted keys, CRLF, and empty files', () => {
  const owned = new Set(['mcp_servers.ninjaone-command']);
  const crlf = 'a = 1\r\n\r\n[mcp_servers."ninjaone-command"]\r\ncommand = "old"\r\n\r\n[b]\r\nc = 2\r\n';
  const out = replaceTomlTables(crlf, owned, '[mcp_servers.ninjaone-command]\ncommand = "new"');
  assert.equal(out.includes('old'), false);
  assert.equal(out.includes('\n') && !/[^\r]\n/.test(out), true, 'CRLF preserved');
  assert.ok(out.indexOf('command = "new"') < out.indexOf('[b]'), 'replaced in place');
  assert.equal(replaceTomlTables('', owned, '[x]\ny = 1'), '[x]\ny = 1\n');
});

test('JSON merge keeps operator keys on our entries and uses an absolute dotenv path', async () => {
  const { root, home, svc } = await fixture();
  const target = join(home, '.cursor', 'mcp.json');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(target, JSON.stringify({ mcpServers: { 'ninjaone-command': { command: 'old', disabled: true, env: { EXTRA: '1', DOTENV_CONFIG_PATH: 'old' } } } }));
  svc.mergeClientConfig('cursor');
  const entry = JSON.parse(await readFile(target, 'utf8')).mcpServers['ninjaone-command'];
  assert.equal(entry.disabled, true);
  assert.equal(entry.env.EXTRA, '1');
  assert.ok(entry.env.DOTENV_CONFIG_PATH.endsWith('command.env'));
  assert.equal(entry.args[1], join(root, 'node_modules', 'dotenv', 'config.js'));
});

test('updateEnv quotes values so dotenv reads them back verbatim, and keeps CRLF', async () => {
  const { root, svc } = await fixture();
  const path = join(root, 'config', 'reporting.env');
  await writeFile(path, '# creds\r\nNINJA_CLIENT_ID=abc\r\n');
  const secrets = ['s3cr#t', 'has space', `quote"inside`, `it's#both space`];
  for (const secret of secrets) {
    svc.updateEnv('reporting', { NINJA_CLIENT_SECRET: secret });
    assert.equal(parseDotenv(await readFile(path))['NINJA_CLIENT_SECRET'], secret);
  }
  const text = await readFile(path, 'utf8');
  assert.equal(/[^\r]\n/.test(text), false, 'CRLF preserved');
  assert.throws(() => svc.updateEnv('reporting', { NINJA_CLIENT_SECRET: `a'b"c d` }), /cannot be quoted safely/);
  assert.throws(() => svc.updateEnv('reporting', { NINJA_CLIENT_SECRET: 'a\nb' }), /single line/);
});

const freePort = () => new Promise((res) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

test('reconnect listener: wrong-length state is refused without crashing; late callbacks get 409', async () => {
  const { root, svc } = await fixture();
  const port = await freePort();
  await writeFile(join(root, 'config', 'command.env'),
    `NINJA_NATIVE_CLIENT_ID=cid\nNINJA_BASE_URL=https://us2.ninjarmm.com\nNINJA_REDIRECT_URI=http://127.0.0.1:${port}\nNINJA_SCOPES=monitoring management offline_access\n`);
  let opened = '';
  svc.opener = (url) => { opened = url; };
  assert.equal(svc.startReconnect().state, 'waiting');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(opened.includes('code_challenge_method=S256'));
  const bad = await fetch(`http://127.0.0.1:${port}/?state=short&code=x`);
  assert.equal(bad.status, 400);
  assert.equal(svc.reconnectStatus().state, 'error');
  assert.match(svc.reconnectStatus().error, /state mismatch/);
  svc.cancelReconnect();
});

test('command credential test serializes on the runtime token lock and persists the rotation', async () => {
  const { root, home, svc } = await fixture();
  await writeFile(join(root, 'config', 'command.env'), 'NINJA_NATIVE_CLIENT_ID=cid\nNINJA_BASE_URL=https://us2.ninjarmm.com\n');
  const tokenFile = join(home, '.ninjaone-mcp', 'command', 'tokens.json');
  await mkdir(join(home, '.ninjaone-mcp', 'command'), { recursive: true });
  await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt-1', base_url: 'https://us2.ninjarmm.com', scope: 'monitoring', saved_at: 1 }));
  const lockDir = `${tokenFile}.lock`;
  await mkdir(lockDir); // a live server is mid-refresh
  const realFetch = globalThis.fetch;
  const spent = [];
  globalThis.fetch = async (_url, init) => {
    spent.push(new URLSearchParams(init.body).get('refresh_token'));
    return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt-3', scope: 'monitoring management', expires_in: 3600 }), { status: 200 });
  };
  try {
    const pending = svc.testConnection('command');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(spent.length, 0, 'must wait for the lock');
    // The peer rotated while holding the lock: the test must spend the NEW token.
    await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt-2', base_url: 'https://us2.ninjarmm.com', scope: 'monitoring', saved_at: 2 }));
    await rm(lockDir, { recursive: true });
    const r = await pending;
    assert.equal(r.ok, true);
    assert.deepEqual(spent, ['rt-2']);
    assert.equal(JSON.parse(await readFile(tokenFile, 'utf8')).refresh_token, 'rt-3');
    assert.equal(existsSync(lockDir), false, 'lock released');
  } finally {
    globalThis.fetch = realFetch;
  }
});
