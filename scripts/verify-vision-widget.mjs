import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/bridge.mjs';
import { widgetUri } from '../src/vision-widget-probe.mjs';
const c = await config();
const client = new Client({ name: 'vision-widget-runtime-check', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${c.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.http_token}` } } }));
  const tools = (await client.listTools()).tools;
  const tool = tools.find(t => t.name === 'vision_widget_probe');
  assert.ok(tool, 'Running service has not loaded vision_widget_probe');
  assert.equal(tool._meta.ui.resourceUri, widgetUri);
  const resource = (await client.readResource({ uri: widgetUri })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /window.openai.uploadFile/);
  const checks = [];
  for (const sample_id of ['a', 'b', 'missing', ...process.argv.slice(2)]) {
    const result = await client.callTool({ name: tool.name, arguments: { sample_id, mode: 'auto', publish_images: true } });
    assert.equal(result.isError, false);
    if (sample_id === 'missing') {
      assert.equal(result.structuredContent.status, 'CONTROL_NO_IMAGE');
      assert.ok(!result._meta?.['x14/vision']);
    } else {
      const bytes = Buffer.from(result._meta['x14/vision'].base64, 'base64');
      assert.deepEqual(bytes, await readFile(path.join(c.state, 'vision-probe', sample_id + '.png')));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.structuredContent.sha256);
      assert.ok(!JSON.stringify(result.structuredContent).includes(result._meta['x14/vision'].base64));
    }
    checks.push({ ...result.structuredContent, transport: 'PASS' });
  }
  const report = { at: new Date().toISOString(), scope: 'Authenticated running HTTP MCP; webpage upload and vision NOT tested', tool_count: tools.length, resource: { uri: widgetUri, mime_type: resource.mimeType, bytes: Buffer.byteLength(resource.text) }, checks };
  await writeFile(path.join(c.state, 'vision-probe/widget-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
