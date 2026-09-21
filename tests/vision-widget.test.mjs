import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerVisionWidgetProbe, widgetUri } from '../src/vision-widget-probe.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=', 'base64');
const sample = (overrides = {}) => ({ structuredContent: { run_id: 'test-run', sample_id: 'a', mode: 'auto', publish_images: true, ui_version: 'v1', status: 'ready', mime_type: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), ...overrides }, _meta: { 'x14/vision': { base64: png.toString('base64') } } });
test('widget MCP resource, private image transport and negative controls', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'x14-widget-'));
  await mkdir(path.join(state, 'vision-probe'));
  await writeFile(path.join(state, 'vision-probe/a.png'), png);
  await writeFile(path.join(state, 'vision-probe/c.png'), png);
  await writeFile(path.join(state, 'vision-probe/answers.json'), 'SECRET_ANSWER');
  const server = new McpServer({ name: 'test', version: '1' });
  registerVisionWidgetProbe(server, { state });
  const client = new Client({ name: 'test', version: '1' });
  const [s, c] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s); await client.connect(c);
    const tool = (await client.listTools()).tools[0];
    assert.equal(tool._meta.ui.resourceUri, widgetUri);
    const resource = await client.readResource({ uri: widgetUri });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /window.openai.uploadFile/);
    assert.ok(!resource.contents[0].text.includes('INLINE_SCRIPT'));
    const result = await client.callTool({ name: tool.name, arguments: { sample_id: 'a' } });
    assert.deepEqual(Buffer.from(result._meta['x14/vision'].base64, 'base64'), png);
    assert.ok(!JSON.stringify({ content: result.content, data: result.structuredContent }).includes(png.toString('base64')));
    assert.ok(!JSON.stringify(result).includes('SECRET_ANSWER'));
    assert.equal(result.structuredContent.mode, 'auto');
    const control = await client.callTool({ name: tool.name, arguments: { sample_id: 'c', publish_images: false } });
    assert.equal(control.isError, false);
    assert.equal(control.structuredContent.publish_images, false);
    assert.deepEqual(Buffer.from(control._meta['x14/vision'].base64, 'base64'), png);
    const missing = await client.callTool({ name: tool.name, arguments: { sample_id: 'missing' } });
    assert.equal(missing.isError, false);
    assert.equal(missing.structuredContent.status, 'CONTROL_NO_IMAGE');
    assert.deepEqual(missing._meta, {});
    assert.equal((await client.callTool({ name: tool.name, arguments: { sample_id: 'b' } })).isError, true);
    assert.equal((await client.callTool({ name: tool.name, arguments: { sample_id: '../answers.json' } })).isError, true);
  } finally {
    await client.close(); await server.close();
    assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir()) + path.sep + 'x14-widget-'));
    await rm(state, { recursive: true, force: true });
  }
});
const script = await readFile(new URL('../src/ui/vision-probe.js', import.meta.url), 'utf8');
function harness({ upload = async () => ({ fileId: 'real-host-file' }), missingApi = false, followupError = false, storage = new Map(), widgetState } = {}) {
  const listeners = {}, elements = {}, calls = [], states = [], messages = [];
  const window = { addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, openai: { widgetState,
    uploadFile: missingApi ? undefined : async file => { calls.push(file); return upload(file); },
    setWidgetState: state => { states.push(state); window.openai.widgetState = state; }
  } };
  const dispatch = data => { for (const fn of listeners.message || []) fn({ source: window.parent, data }); };
  window.parent = { postMessage: message => {
    if (message.id === undefined) return;
    if (message.method === 'ui/message') messages.push(message);
    queueMicrotask(() => dispatch({ jsonrpc: '2.0', id: message.id, ...(followupError && message.method === 'ui/message' ? { error: { message: 'host refused follow-up' } } : { result: {} }) }));
  } };
  const timers = new Set();
  vm.runInNewContext(script, { window, document: { getElementById: id => elements[id] ||= {} }, sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, val) => storage.set(key, val) }, crypto: webcrypto, File, Uint8Array, atob, setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; }, clearTimeout: id => { clearTimeout(id); timers.delete(id); } });
  return { calls, states, messages, elements, storage,
    send: result => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    settle: async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 2)); },
    dispose: () => { for (const id of timers) clearTimeout(id); },
    report: () => JSON.parse(elements.diagnostics.textContent)
  };
}
test('mock host: auto bytes → real file ID → imageIds → one follow-up; duplicate and remount', async () => {
  const h = harness();
  try {
    await h.settle(); h.send(sample()); await h.settle();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(Buffer.from(await h.calls[0].arrayBuffer()), png);
    assert.deepEqual(Array.from(h.states.at(-1).imageIds), ['real-host-file']);
    assert.equal(h.messages.length, 1);
    h.send(sample()); await h.settle();
    assert.equal(h.calls.length, 1); assert.equal(h.messages.length, 1);
    const remount = harness({ storage: h.storage });
    try { await remount.settle(); remount.send(sample()); await remount.settle(); assert.equal(remount.calls.length, 0); assert.equal(remount.messages.length, 0); } finally { remount.dispose(); }
  } finally { h.dispose(); }
});
test('mock host: missing clears references; no-reference control still uploads', async () => {
  const h = harness();
  try {
    await h.settle(); h.send(sample({ publish_images: false })); await h.settle();
    assert.equal(h.calls.length, 1); assert.equal(h.states.at(-1).imageIds.length, 0);
    h.send({ structuredContent: { run_id: 'missing-run', sample_id: 'missing', ui_version: 'v1', status: 'CONTROL_NO_IMAGE' }, _meta: {} }); await h.settle();
    assert.equal(h.states.at(-1).imageIds.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.messages.length, 1);
    assert.equal(h.report().stage, 'CONTROL_NO_IMAGE');
  } finally { h.dispose(); }
});
test('mock host: absent APIs, invalid bytes, missing file ID and follow-up rejection stop honestly', async () => {
  for (const [options, result, expected] of [
    [{ missingApi: true }, sample(), 'HOST_API_UNAVAILABLE'],
    [{}, { ...sample(), _meta: {} }, 'PRIVATE_IMAGE_PAYLOAD_MISSING'],
    [{}, sample({ sha256: '0'.repeat(64) }), 'IMAGE_HASH_MISMATCH'],
    [{ upload: async () => ({}) }, sample(), 'UPLOAD_RESULT_NO_FILE_ID'],
    [{ followupError: true }, sample(), 'host refused follow-up']
  ]) {
    const h = harness(options);
    try { await h.settle(); h.send(result); await h.settle(); assert.equal(h.report().error, expected); assert.equal(h.report().stage, 'stopped'); } finally { h.dispose(); }
  }
});
test('mock host: rejected automatic upload allows exactly one click retry on same bytes', async () => {
  let count = 0;
  const h = harness({ upload: async () => { if (++count === 1) throw new Error('gesture required'); return { fileId: 'clicked-file' }; } });
  try {
    await h.settle(); h.send(sample()); await h.settle();
    assert.equal(h.report().can_click, true);
    h.elements.retry.onclick(); await h.settle();
    assert.equal(h.calls.length, 2); assert.equal(h.messages.length, 1);
    assert.equal(h.calls[0], h.calls[1]);
    h.elements.retry.onclick(); await h.settle(); assert.equal(h.calls.length, 2);
  } finally { h.dispose(); }
});
