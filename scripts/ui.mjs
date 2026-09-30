#!/usr/bin/env node
// Start the dashboard on the command profile and open it signed in.
//
//   npm run ui                      command profile on http://localhost:39300
//   npm run ui -- --profile=reporting --port=39301   read-only instance
//   npm run ui -- --no-open
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const profile = arg('profile', 'command');
const envFile = join(ROOT, 'config', `${profile}.env`);

if (!existsSync(join(ROOT, 'dist', 'serve.js'))) { console.error('Build first:  npm run build'); process.exit(1); }
if (!existsSync(envFile)) { console.error(`Missing config/${profile}.env — run:  npm run setup`); process.exit(1); }

const port = arg('port', process.env.NINJA_SERVE_PORT || (profile === 'command' ? '39300' : '39301'));
const env = {
  ...process.env,
  DOTENV_CONFIG_PATH: envFile,
  NINJA_SERVE_PORT: port,
  NINJA_SYNC_INTERVAL_MINUTES: process.env.NINJA_SYNC_INTERVAL_MINUTES ?? '5',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --no-warnings`.trim(),
};
const child = spawn(process.execPath, ['--require', 'dotenv/config', join(ROOT, 'dist', 'serve.js')], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'pipe'] });

let opened = false;
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  if (opened || !/local server on/.test(String(d))) return;
  opened = true;
  const tokenFile = join(homedir(), '.ninjaone-mcp', 'serve.token');
  const token = process.env.NINJA_SERVE_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
  // localhost, not 127.0.0.1 — browsers only allow passkeys on a hostname.
  const url = `http://localhost:${port}/${token ? `?token=${token}` : ''}`;
  console.log(`\n  Keyturn (${profile}) → http://localhost:${port}\n  Ctrl+C to stop\n`);
  if (!process.argv.includes('--no-open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
