// Isolated protocol experiment; does not modify or restart the running Bridge.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=', 'base64');
const csv = Buffer.from('id,value\n1,12\n2,25\n3,-4\n', 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const assetUri = 'bridge-probe://fixture/sample.csv';
const connections = new Set();
function createServer() {
  const mcp = new McpServer({ name: 'isolated-multimodal-probe', version: '0.1.0' });
  mcp.registerTool('probe_image', { inputSchema: {} }, async () => ({
    content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]
  }));
  mcp.registerTool('probe_file_input', {
    inputSchema: { file: z.object({ download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() }).strict() },
    _meta: { 'openai/fileParams': ['file'] }
  }, async ({ file }) => ({ content: [{ type: 'text', text: JSON.stringify({ received_reference: Boolean(file.file_id && file.download_url), downloaded: false }) }] }));
  mcp.registerTool('probe_blob', { inputSchema: {} }, async () => ({ content: [{
    type: 'resource', resource: { uri: assetUri, mimeType: 'text/csv', blob: csv.toString('base64') }
  }] }));
  mcp.registerTool('probe_link', { inputSchema: {} }, async () => ({ content: [{
    type: 'resource_link', uri: assetUri, name: 'sample.csv', mimeType: 'text/csv'
  }] }));
  mcp.registerResource('fixture', assetUri, { mimeType: 'text/csv' }, async () => ({ contents: [{ uri: assetUri, mimeType: 'text/csv', blob: csv.toString('base64') }] }));
  return mcp;
}
const listener = http.createServer(async (req, res) => {
  // Test-only loopback listener with fixed non-private fixtures and no URL fetching.
  if (req.headers.origin || req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(403).end(); return; }
  const mcp = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  connections.add(mcp);
  res.on('close', () => { void transport.close(); void mcp.close(); connections.delete(mcp); });
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { if (!res.headersSent) res.writeHead(400).end(); }
});
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const client = new Client({ name: 'multimodal-probe-client', version: '0.1.0' });
const checks = [];
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`)));
  const listing = await client.listTools();
  const fileTool = listing.tools.find(t => t.name === 'probe_file_input');
  assert.deepEqual(fileTool._meta['openai/fileParams'], ['file']);
  assert.deepEqual([...fileTool.inputSchema.properties.file.required].sort(), ['download_url', 'file_id']);
  checks.push({ name: 'fileParams metadata and schema survive HTTP discovery', status: 'PASS' });
  const image = await client.callTool({ name: 'probe_image', arguments: {} });
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].mimeType, 'image/png');
  assert.equal(digest(Buffer.from(image.content[0].data, 'base64')), digest(png));
  checks.push({ name: 'image content and bytes survive HTTP tool call', status: 'PASS', bytes: png.length });
  const fileInput = await client.callTool({ name: 'probe_file_input', arguments: { file: { file_id: 'synthetic-fixture', download_url: 'https://example.invalid/not-fetched' } } });
  assert.equal(JSON.parse(fileInput.content[0].text).received_reference, true);
  checks.push({ name: 'synthetic file reference accepted; no download attempted', status: 'PASS' });
  const blob = await client.callTool({ name: 'probe_blob', arguments: {} });
  assert.equal(digest(Buffer.from(blob.content[0].resource.blob, 'base64')), digest(csv));
  checks.push({ name: 'embedded resource bytes survive HTTP tool call', status: 'PASS', bytes: csv.length });
  const link = await client.callTool({ name: 'probe_link', arguments: {} });
  assert.equal(link.content[0].type, 'resource_link');
  const resource = await client.readResource({ uri: link.content[0].uri });
  assert.equal(digest(Buffer.from(resource.contents[0].blob, 'base64')), digest(csv));
  checks.push({ name: 'resource link followed explicitly with resources/read', status: 'PASS' });
  const report = { at: new Date().toISOString(), scope: 'Isolated SDK client/server over loopback Streamable HTTP; not the production Bridge or ChatGPT', checks,
    not_tested: ['ChatGPT model vision', 'Secure MCP Tunnel multimodal response', 'real ChatGPT attachment injection and download', 'resource auto-fetch by ChatGPT', 'native ChatGPT data-analysis file ingestion', 'PDF/Excel parsing', 'large payload limits'] };
  const folder = fileURLToPath(new URL('../tmp/multimodal-probe/', import.meta.url));
  await mkdir(folder, { recursive: true });
  await writeFile(folder + '/result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
  for (const connection of connections) await connection.close();
  listener.closeAllConnections();
  await new Promise(resolve => listener.close(resolve));
}
