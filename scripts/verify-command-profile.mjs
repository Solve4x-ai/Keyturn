import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = 'C:\\MCP\\NinjaOne\\dist\\index.js';
const envPath = 'C:\\MCP\\NinjaOne\\config\\command.env';

function parseToolResult(result) {
  assert.equal(result.isError, undefined, 'MCP tool returned an error');
  const text = result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');
  assert.ok(text, 'MCP tool returned no text result');
  return JSON.parse(text);
}

function resultCount(value) {
  if (Array.isArray(value)) return value.length;
  for (const key of ['results', 'data', 'items', 'devices', 'organizations', 'alerts', 'activities']) {
    if (Array.isArray(value?.[key])) return value[key].length;
  }
  return null;
}

async function verifyOnce(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', 'dotenv/config', serverPath],
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: envPath,
    },
  });
  const client = new Client({ name: `solve4x-command-verifier-${run}`, version: '1.0.0' });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));

    for (const required of [
      'get_auth_profile',
      'get_organizations',
      'get_devices',
      'get_alerts',
      'get_activities',
      'get_ticket_boards',
      'get_ticket_statuses',
      'create_ticket',
      'update_ticket',
      'add_ticket_comment',
      'reboot_device',
    ]) {
      assert.ok(names.has(required), `Required command tool is missing: ${required}`);
    }

    for (const prohibited of [
      'run_device_script',
      'scan_device_os_patches',
      'apply_device_os_patches',
      'scan_device_software_patches',
      'apply_device_software_patches',
      'delete_end_user',
      'delete_contact',
      'delete_webhook_config',
      'create_organization',
      'set_webhook_config',
    ]) {
      assert.ok(!names.has(prohibited), `Prohibited command tool is exposed: ${prohibited}`);
    }

    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(result);
    };

    const auth = await call('get_auth_profile');
    assert.equal(auth.profile, 'command');
    assert.equal(auth.tokenSource, 'native_pkce');
    assert.deepEqual(new Set(auth.configuredScopes), new Set(['monitoring', 'management', 'offline_access']));
    assert.deepEqual(new Set(auth.grantedScopes), new Set(['monitoring', 'management', 'offline_access']));

    const organizations = await call('get_organizations');
    const devices = await call('get_devices', { pageSize: 5 });
    const alerts = await call('get_alerts', { pageSize: 5 });
    const activities = await call('get_activities', { pageSize: 5 });
    const boards = await call('get_ticket_boards');
    const statuses = await call('get_ticket_statuses');

    console.log(JSON.stringify({
      run,
      toolCount: listed.tools.length,
      profile: auth.profile,
      tokenSource: auth.tokenSource,
      configuredScopes: auth.configuredScopes,
      grantedScopes: auth.grantedScopes,
      readCounts: {
        organizations: resultCount(organizations),
        devices: resultCount(devices),
        alerts: resultCount(alerts),
        activities: resultCount(activities),
        ticketBoards: resultCount(boards),
        ticketStatuses: resultCount(statuses),
      },
    }));
  } finally {
    await client.close();
  }
}

await verifyOnce(1);
await verifyOnce(2);

