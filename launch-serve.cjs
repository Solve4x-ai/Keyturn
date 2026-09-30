// Launcher: reads env JSON (arg1) and spawns dist/serve.js detached.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const envFile = process.argv[2];
const env = { ...process.env, ...JSON.parse(fs.readFileSync(envFile, 'utf8')) };
const log = envFile.replace('.env.json', '.log');
const out = fs.openSync(log, 'a');
const child = spawn(process.execPath, ['dist/serve.js'], { env, cwd: 'C:\\MCP\\NinjaOne', detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log('spawned pid', child.pid, '->', log);
