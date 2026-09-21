import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, configPath, root } from '../src/bridge.mjs';

test('real MCP stdio discovery and read tools', async () => {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs'), '--stdio'], env: { ...process.env, X14_BRIDGE_CONFIG: configPath } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 15);
    assert.ok(!tools.tools.some(t => t.name === 'vision_probe' || t.name === 'vision_widget_probe'));
    assert.ok(tools.tools.some(t => t.name === 'view_project_images'));
    assert.deepEqual(tools.tools.find(t => t.name === 'claim_image_delivery')._meta.ui.visibility, ['app']);
    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.ok(projects.structuredContent.projects.some(p => p.project_id === 'bridge'));
    const read = await client.callTool({ name: 'read_files', arguments: { project_id: 'bridge', files: [{ path: 'package.json' }] } });
    assert.equal(read.isError, false);
    assert.match(read.structuredContent.result.files[0].content, /x14-plus-project-bridge/);
    const denied = await client.callTool({ name: 'read_files', arguments: { project_id: 'missing', files: [{ path: 'package.json' }] } });
    assert.equal(denied.isError, true);
  } finally { await client.close(); }
});

test('HTTP rejects unauthenticated and browser-origin requests; authenticated MCP works', async () => {
  const c = await config();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'x14-http-test-'));
  const testConfig = path.join(temp, 'config.json');
  await writeFile(testConfig, JSON.stringify({ ...c, port: 0 }));
  const server = spawn(process.execPath, [path.join(root, 'src/server.mjs')], { env: { ...process.env, X14_BRIDGE_CONFIG: testConfig }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      server.stderr.once('data', data => {
        const match = data.toString().match(/loopback port (\d+)/);
        match ? resolve(Number(match[1])) : reject(new Error(data.toString()));
      });
      server.once('error', reject);
      server.once('exit', code => reject(new Error('HTTP server exited ' + code)));
    });
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(url + '/healthz')).status, 401);
    const headers = { Authorization: 'Bearer ' + c.http_token };
    assert.equal((await fetch(url + '/healthz', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(url + '/healthz', { headers })).status, 200);
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }));
      assert.equal((await client.listTools()).tools.length, 15);
      assert.equal((await client.callTool({ name: 'bridge_status', arguments: {} })).isError, false);
    } finally { await client.close(); }
  } finally {
    server.kill();
    assert.ok(temp.startsWith(path.join(os.tmpdir(), 'x14-http-test-')));
    await rm(temp, { recursive: true, force: true });
  }
});
