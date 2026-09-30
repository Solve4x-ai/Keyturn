#!/usr/bin/env node
// First-run setup: creates config/*.env and config/policy.json from the
// examples with paths filled in for this checkout, asks for your NinjaOne
// region and app IDs, and builds. Safe to re-run — existing values are kept
// unless you type a new one. Secrets are written only to the git-ignored
// config/ folder, never echoed.
//
//   npm run setup
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'config');
const POLICY = join(CONFIG, 'policy.json');
const REGIONS = { us: 'https://app.ninjarmm.com', us2: 'https://us2.ninjarmm.com', eu: 'https://eu.ninjarmm.com', ca: 'https://ca.ninjarmm.com', oc: 'https://oc.ninjarmm.com' };
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`, ok = (s) => `\x1b[32m✔\x1b[0m ${s}`;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13+ is required (you have ${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}

// Line queue instead of rl.question(): works the same typed or piped.
const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines = [], waiters = [];
let muted = false, closed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
if (process.stdin.isTTY) rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
const ask = async (q, { secret = false, current = '' } = {}) => {
  const hint = current ? dim(secret ? ' [keep existing]' : ` [${current}]`) : '';
  process.stdout.write(`${q}${hint}: `);
  muted = secret;
  const a = lines.length ? lines.shift() : closed ? '' : await new Promise((res) => waiters.push(res));
  muted = false;
  if (secret || !process.stdin.isTTY) process.stdout.write('\n');
  return a.trim() || current;
};

/** Rewrite KEY=value lines in place, appending missing keys; comments and order survive. */
function setEnv(file, values) {
  let text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, raw] of Object.entries(values)) {
    if (raw == null) continue;
    // Single quotes are literal in dotenv (backslashes in Windows paths survive).
    const value = /[\s#"'`]/.test(raw) ? (raw.includes("'") ? JSON.stringify(raw) : `'${raw}'`) : raw;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}${eol}${key}=${value}${eol}`;
  }
  writeFileSync(file, text);
}

console.log(`\n${bold('Mission Control setup')}\n${dim('Creates git-ignored files in config/. Press Enter to keep a value.')}\n`);

for (const name of ['reporting.env', 'command.env']) {
  const target = join(CONFIG, name);
  if (!existsSync(target)) { copyFileSync(join(CONFIG, `${name}.example`), target); console.log(ok(`created config/${name}`)); }
}
if (!existsSync(POLICY)) { copyFileSync(join(CONFIG, 'policy.example.json'), POLICY); console.log(ok('created config/policy.json (every write disabled)')); }

const rep = parse(readFileSync(join(CONFIG, 'reporting.env')));
const cmd = parse(readFileSync(join(CONFIG, 'command.env')));
const placeholder = (v) => !v || /^REPLACE_WITH/.test(v);

const configured = !placeholder(cmd.NINJA_NATIVE_CLIENT_ID) || !placeholder(rep.NINJA_CLIENT_ID);
const currentRegion = configured ? Object.entries(REGIONS).find(([, url]) => url === (cmd.NINJA_BASE_URL || rep.NINJA_BASE_URL))?.[0] || '' : '';
console.log(`\n${bold('1. NinjaOne region')} ${dim('— the host you sign in to: app=us, us2, eu, ca, oc')}`);
let region = '';
while (!REGIONS[region]) {
  region = (await ask('Region (us / us2 / eu / ca / oc)', { current: currentRegion })).toLowerCase();
  if (!REGIONS[region] && closed) { console.error('No region given.'); process.exit(1); }
}

console.log(`\n${bold('2. Reporting app')} ${dim('— NinjaOne → Administration → Apps → API → Add: API Services, scope Monitoring, grant Client credentials')}`);
const repId = await ask('Client ID', { current: placeholder(rep.NINJA_CLIENT_ID) ? '' : rep.NINJA_CLIENT_ID });
const repSecret = await ask('Client secret (hidden)', { secret: true, current: placeholder(rep.NINJA_CLIENT_SECRET) ? '' : rep.NINJA_CLIENT_SECRET });

console.log(`\n${bold('3. Command app')} ${dim('— Add: Native, scopes Monitoring + Management, grants Authorization code + Refresh token, redirect URI http://127.0.0.1')}`);
const cmdId = await ask('Native client ID', { current: placeholder(cmd.NINJA_NATIVE_CLIENT_ID) ? '' : cmd.NINJA_NATIVE_CLIENT_ID });
rl.close();

const base = REGIONS[region];
setEnv(join(CONFIG, 'reporting.env'), { NINJA_BASE_URL: base, NINJA_CLIENT_ID: repId || null, NINJA_CLIENT_SECRET: repSecret || null, NINJA_POLICY_PATH: POLICY });
setEnv(join(CONFIG, 'command.env'), { NINJA_BASE_URL: base, NINJA_NATIVE_CLIENT_ID: cmdId || null, NINJA_POLICY_PATH: POLICY });
console.log(`\n${ok('config/reporting.env and config/command.env updated')}`);

console.log(dim('\nBuilding…'));
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

const missing = [!repId && 'reporting client ID', !repSecret && 'reporting secret', !cmdId && 'native client ID'].filter(Boolean);
console.log(`
${bold('Next steps')}
${missing.length ? `  • Still missing: ${missing.join(', ')} — re-run ${bold('npm run setup')} or edit config/*.env\n` : ''}  1. Authorize the command app once, from an ${bold('elevated')} PowerShell (the redirect listens on port 80):
       ${bold('npm run auth:command')}
  2. Start the Command Center:
       ${bold('npm run ui')}   → open the printed http://localhost:39300 link
  3. In the UI: ${bold('Security')} → enroll a passkey, then ${bold('Settings')} → review the policy
     and click ${bold('Merge')} next to your AI client (Claude Desktop, Cursor, Codex, …).
`);
