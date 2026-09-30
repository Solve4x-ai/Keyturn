import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const commandEnv = 'C:\\MCP\\NinjaOne\\config\\command.env';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '--require',
    'C:\\MCP\\NinjaOne\\node_modules\\dotenv\\config.js',
    'C:\\MCP\\NinjaOne\\dist\\index.js',
  ],
  cwd: 'C:\\MCP\\NinjaOne',
  env: {
    ...process.env,
    DOTENV_CONFIG_PATH: commandEnv,
  },
  stderr: 'pipe',
});

const client = new Client({ name: 'ninjaone-command-verifier', version: '1.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const required = ['list_automations', 'get_device_scripting_options', 'run_device_script', 'get_script_result'];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing command scripting tools: ${missing.join(', ')}`);
  }

  const profile = await client.callTool({ name: 'get_auth_profile', arguments: {} });
  const automations = await client.callTool({
    name: 'list_automations',
    arguments: {},
  });

  const profileText = profile.content?.find((item) => item.type === 'text')?.text || '{}';
  const automationText = automations.content?.find((item) => item.type === 'text')?.text || '[]';
  const profileData = JSON.parse(profileText);
  const automationData = JSON.parse(automationText);
  const scripts = Array.isArray(automationData)
    ? automationData
    : Array.isArray(automationData?.scripts)
      ? automationData.scripts
      : [];

  console.log(JSON.stringify({
    profile: profileData.profile,
    grantedScopes: profileData.grantedScopes,
    requiredToolsExposed: true,
    automationCount: scripts.length,
    automations: scripts.map((script) => ({
      id: script.id,
      name: script.name,
      language: script.language,
      active: script.active,
    })),
  }, null, 2));
} finally {
  await transport.close();
}
