import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerVisionProbe } from '../src/vision-probe.mjs';

test('vision probe preserves image bytes, excludes answers and handles missing/invalid fixtures', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'x14-vision-test-'));
  const folder = path.join(state, 'vision-probe');
  await mkdir(folder);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(folder, 'a.png'), png);
  await writeFile(path.join(folder, 'answers.json'), 'SECRET_ANSWER');
  const server = new McpServer({ name: 'test', version: '1' });
  registerVisionProbe(server, { state });
  const client = new Client({ name: 'test', version: '1' });
  const [s, c] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s); await client.connect(c);
    const call = sample_id => client.callTool({ name: 'vision_probe', arguments: { sample_id } });
    const result = await call('a');
    assert.equal(result.isError, false);
    assert.equal(result.content[1].type, 'image');
    assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), png);
    assert.ok(!JSON.stringify(result).includes('SECRET_ANSWER'));
    for (const id of ['missing', 'b']) {
      const missing = await call(id);
      assert.equal(missing.isError, true);
      assert.ok(missing.content.every(item => item.type === 'text'));
    }
    await writeFile(path.join(folder, 'b.png'), 'not a PNG');
    assert.equal((await call('b')).isError, true);
    assert.equal((await call('../answers.json')).isError, true);
  } finally {
    await client.close(); await server.close();
    assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir()) + path.sep + 'x14-vision-test-'));
    await rm(state, { recursive: true, force: true });
  }
});
