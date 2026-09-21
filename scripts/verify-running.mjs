import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/bridge.mjs';
const c = await config();
const client = new Client({ name: 'runtime-verification', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${c.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.http_token}` } } }));
  const tools = await client.listTools();
  for (const name of ['bridge_status', 'list_projects']) {
    const r = await client.callTool({name, arguments: {}});
    if (r.isError) throw new Error(`${name} failed`);
  }
  const r = await client.callTool({ name: 'read_files', arguments: { project_id: 'bridge', files: [{path: 'README.md', start_line: 1, end_line: 2}] } });
  if (r.isError || JSON.stringify(r.structuredContent).includes('NOT_FOUND')) throw new Error('README read failed');
  console.log(`Authenticated HTTP MCP: PASS; ${tools.tools.length} tools; status, projects and README read succeeded.`);
} finally { await client.close(); }
