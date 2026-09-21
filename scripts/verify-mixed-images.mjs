import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/bridge.mjs';
import { imageViewerUri } from '../src/project-images.mjs';

const c = await config(), client = new Client({ name: 'mixed-image-verifier', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${c.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.http_token}` } } }));
  assert.ok((await client.readResource({ uri: imageViewerUri })).contents[0].text.includes('project-images-v7'));
  const sources = [{ project_id: 'bridge', path: 'tmp/mixed-evidence-task-v2/evidence/RIT1.png' }, { project_id: 'volcengine-cszy', path: 'tmp/RIT1.png' }];
  const result = await client.callTool({ name: 'view_project_images', arguments: { sources, question: 'Service transport verification only; no webpage perception claimed.' } });
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const data = result.structuredContent;
  assert.equal(data.images.length, 2);
  assert.deepEqual(data.images.map(i => i.project_id), sources.map(i => i.project_id));
  assert.deepEqual(data.images.map(i => i.index), [1, 2]);
  assert.notEqual(data.images[0].source_target, data.images[1].source_target);
  const expectedHashes = ['a7450637469af7e3fe0c006076784ef34c6c292914b47344c90192d3b4a27c1c', '05902f8efa78a0f45194d652de991615c3ce307ae28bc4203be6ee210d40c348'];
  for (const [i, info] of data.images.entries()) {
    const bytes = Buffer.from(result._meta['x14/images'].base64[i], 'base64');
    assert.equal(bytes.length, info.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHashes[i]);
    assert.equal(info.sha256, expectedHashes[i]);
  }
  const report = { at: new Date().toISOString(), run_id: data.run_id, resource: imageViewerUri, scope: 'Actual service mixed-source bytes and order only; no upload or model vision', images: data.images };
  await writeFile(path.join(c.state, 'image-deliveries', 'mixed-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
