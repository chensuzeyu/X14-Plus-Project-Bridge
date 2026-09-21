import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/bridge.mjs';
const c = await config();
const client = new Client({ name: 'vision-runtime-check', version: '1' });
const checks = [];
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${c.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.http_token}` } } }));
  assert.ok((await client.listTools()).tools.some(t => t.name === 'vision_probe'));
  for (const sample_id of ['a', 'b']) {
    const result = await client.callTool({ name: 'vision_probe', arguments: { sample_id } });
    assert.equal(result.isError, false);
    const image = result.content.find(item => item.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    const actual = Buffer.from(image.data, 'base64');
    assert.deepEqual(actual, await readFile(path.join(c.state, 'vision-probe', sample_id + '.png')));
    checks.push({ sample_id, status: 'PASS', bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') });
  }
  const missing = await client.callTool({ name: 'vision_probe', arguments: { sample_id: 'missing' } });
  assert.equal(missing.isError, true);
  assert.ok(missing.content.every(item => item.type !== 'image'));
  checks.push({ sample_id: 'missing', status: 'PASS' });
  const report = { at: new Date().toISOString(), scope: 'Running Bridge authenticated local HTTP; not cloud/model vision', checks };
  await writeFile(path.join(c.state, 'vision-probe', 'local-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
