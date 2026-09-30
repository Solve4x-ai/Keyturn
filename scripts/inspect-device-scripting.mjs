import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '--require',
    `${ROOT}/node_modules/dotenv/config.js`,
    `${ROOT}/dist/index.js`,
  ],
  cwd: ROOT,
  env: {
    ...process.env,
    DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH ?? `${ROOT}/config/command.env`,
  },
  stderr: 'pipe',
});

const client = new Client({ name: 'ninjaone-device-scripting-inspector', version: '1.0.0' });
const targetName = process.argv[2] || 'Test';

function textResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

try {
  await client.connect(transport);
  const organizations = textResult(await client.callTool({
    name: 'get_organizations',
    arguments: {},
  }));
  const orgs = Array.isArray(organizations)
    ? organizations
    : organizations?.organizations || organizations?.results || [];
  const orgFilter = (process.env.INSPECT_ORG || '').toLowerCase();
  const solve4x = orgs.filter((org) => !orgFilter || String(org.name || '').toLowerCase() === orgFilter);
  const solve4xIds = new Set(solve4x.map((org) => org.id));
  const inventoryResults = [];
  for (const org of solve4x) {
    inventoryResults.push(textResult(await client.callTool({
      name: 'get_devices_complete',
      arguments: { organizationId: org.id, pageSize: 200, maxPages: 50 },
    })));
  }
  const devices = inventoryResults.flatMap((result) => result?.items || result?.devices || result?.results || []);
  const candidates = devices.filter((device) => {
    const organizationId = device.organizationId ?? device.orgId ?? device.clientId ?? device.organization?.id;
    const deviceName = device.systemName ?? device.displayName ?? device.name;
    const displayName = device.displayName ?? device.name;
    return solve4xIds.has(organizationId) && (
      String(deviceName || '').toLowerCase() === targetName.toLowerCase() ||
      String(displayName || '').toLowerCase() === targetName.toLowerCase()
    );
  });

  const inspected = [];
  for (const device of candidates) {
    const options = textResult(await client.callTool({
      name: 'get_device_scripting_options',
      arguments: { deviceId: device.id },
    }));
    inspected.push({ device, options });
  }

  const runnerMatches = inspected.flatMap(({ device, options }) =>
    (options?.scripts || [])
      .filter((script) => script.type === 'SCRIPT' && script.name === 'Solve4x Approved PowerShell Runner')
      .map((script) => ({ deviceId: device.id, systemName: device.systemName, script })),
  );
  console.log(JSON.stringify({ solve4x, exactCandidates: candidates, runnerMatches }, null, 2));
} finally {
  await transport.close();
}
