import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/bridge.mjs';
import { imageViewerUri } from '../src/project-images.mjs';
const c = await config(), client = new Client({ name: 'project-image-verifier', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${c.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.http_token}` } } }));
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find(t => t.name === 'view_project_images'));
  if (process.argv[3] === '--local') {
    const found = await client.callTool({ name: 'discover_local_images', arguments: { path: path.dirname(process.argv[2]), contains: path.basename(process.argv[2]) } });
    assert.equal(found.isError, false);
    assert.ok(found.structuredContent.result.images.some(i => path.resolve(i.path) === path.resolve(process.argv[2])));
  }
  const resource = (await client.readResource({ uri: imageViewerUri })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  const result = await client.callTool({ name: 'view_project_images', arguments: { ...(process.argv[3] === '--local' ? {} : { project_id: 'bridge' }), paths: [process.argv[2] || 'tmp/image-viewer-acceptance/web-experiment.png'], question: '分析截图中展示的实验状态与流程。' } });
  assert.equal(result.isError, false, JSON.stringify(result.content));
  for (const [i, info] of result.structuredContent.images.entries()) {
    const bytes = Buffer.from(result._meta['x14/images'].base64[i], 'base64');
    assert.equal(bytes.length, info.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256);
  }
  const args = { run_id: result.structuredContent.run_id, token: result._meta['x14/images'].token };
  const claims = await Promise.all([1,2].map(() => client.callTool({ name: 'claim_image_delivery', arguments: args })));
  assert.equal(claims.filter(r => r.structuredContent.granted).length, 1);
  const report = { at: new Date().toISOString(), scope: 'Running service image bytes/resource/atomic claim; webpage upload and CSP still require acceptance', tool_count: tools.length, resource: imageViewerUri, images: result.structuredContent.images, claim: 'one granted / one denied' };
  await mkdir(path.join(c.state, 'image-deliveries'), { recursive: true });
  await writeFile(path.join(c.state, 'image-deliveries', 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
