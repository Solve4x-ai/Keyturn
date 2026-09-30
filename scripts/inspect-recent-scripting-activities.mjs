import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--require', 'C:\\MCP\\NinjaOne\\node_modules\\dotenv\\config.js', 'C:\\MCP\\NinjaOne\\dist\\index.js'],
  cwd: 'C:\\MCP\\NinjaOne',
  env: { ...process.env, DOTENV_CONFIG_PATH: 'C:\\MCP\\NinjaOne\\config\\command.env' },
  stderr: 'pipe',
});
const client = new Client({ name: 'solve4x-activity-inspector', version: '1.0.0' });

try {
  await client.connect(transport);
  const deviceId = Number(process.env.DEVICE_ID || process.argv[2]);
  if (!Number.isInteger(deviceId)) throw new Error('Pass a device id: node scripts/inspect-recent-scripting-activities.mjs <deviceId>');
  const result = await client.callTool({ name: 'get_device_activities', arguments: { id: deviceId, pageSize: 200 } });
  const text = result.content?.find((item) => item.type === 'text')?.text || '{}';
  const data = JSON.parse(text);
  const activities = Array.isArray(data) ? data : data.activities || [];
  const scripting = activities
    .filter((entry) => entry.activityType === 'SCRIPTING' || JSON.stringify(entry).toLowerCase().includes('powershell runner'))
    .slice(0, 20);
  console.log(JSON.stringify({ lastActivityId: data.lastActivityId, scripting }, null, 2));
} finally {
  await transport.close();
}
