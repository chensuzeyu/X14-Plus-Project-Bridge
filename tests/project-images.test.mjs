import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { config, execute, invoke } from '../src/bridge.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProjectImages, imageViewerUri } from '../src/project-images.mjs';

test('project image pipeline: decoding, boundaries, resizing, private payload and atomic delivery claim', async () => {
  const installed = await config(), folder = await mkdtemp(path.join(os.tmpdir(), 'x14-image-tests-'));
  const project = path.join(folder, 'project'); await mkdir(project);
  const c = { ...installed, state: path.join(folder, 'state'), projects: [{ id: 'test', target: 'local', root: project }, { id: 'remote', target: 'ssh', root: '/unused' }] };
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerProjectImages(server, c);
  const [s, t] = InMemoryTransport.createLinkedPair();
  try {
    await execute(c.python, ['-c', "import sys,json;from pathlib import Path;from PIL import Image;p=Path(json.load(sys.stdin)['path']);Image.new('RGB',(120,80),'red').save(p/'中文 图.png');Image.new('RGB',(4000,1000),'blue').save(p/'large.jpg');im=Image.new('RGB',(30,70),'green');ex=Image.Exif();ex[274]=6;im.save(p/'rotate.jpg',exif=ex)"], JSON.stringify({ path: project }));
    await writeFile(path.join(project, 'bad.png'), 'not an image');
    await writeFile(path.join(project, 'bad.txt'), 'text');
    await symlink(folder, path.join(project, 'escape'), 'junction');
    await server.connect(s); await client.connect(t);
    const args = { project_id: 'test', paths: ['中文 图.png', 'large.jpg', 'rotate.jpg'], question: '比较三张图片的内容' };
    const result = await client.callTool({ name: 'view_project_images', arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.structuredContent.question, args.question);
    const images = result.structuredContent.images;
    assert.equal(images.length, 3);
    assert.equal(images[0].resized, false);
    assert.deepEqual(Buffer.from(result._meta['x14/images'].base64[0], 'base64'), await readFile(path.join(project, args.paths[0])));
    assert.equal(images[1].resized, true); assert.equal(images[1].width, 2560); assert.equal(images[1].height, 640);
    assert.equal(images[2].orientation_corrected, true); assert.equal(images[2].width, 70);
    assert.ok(!JSON.stringify(result.structuredContent).includes('base64'));
    assert.ok(!JSON.stringify(result.content).includes(result._meta['x14/images'].token));
    for (const absolute of [path.join(project, '中文 图.png'), path.join(project, '中文 图.png').replaceAll('\\', '/')]) {
      const absoluteResult = await client.callTool({ name: 'view_project_images', arguments: { ...args, paths: [absolute] } });
      assert.equal(absoluteResult.isError, false, JSON.stringify(absoluteResult.content));
      assert.equal(absoluteResult.structuredContent.images[0].path, '中文 图.png');
    }
    const uri = (await client.readResource({ uri: imageViewerUri })).contents[0];
    assert.equal(uri.mimeType, 'text/html;profile=mcp-app');
    assert.ok(uri.text.includes('claim_image_delivery'));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.find(x => x.name === 'claim_image_delivery')._meta.ui.visibility, ['app']);
    const claimArgs = { run_id: result.structuredContent.run_id, token: result._meta['x14/images'].token };
    const claims = await Promise.all(Array.from({ length: 8 }, () => client.callTool({ name: 'claim_image_delivery', arguments: claimArgs })));
    assert.equal(claims.filter(r => r.structuredContent.granted).length, 1);
    for (const [paths, expected] of [[['missing.png'], 'NOT_FOUND'], [['bad.txt'], 'UNSUPPORTED_IMAGE'], [['bad.png'], 'INVALID_IMAGE'], [['../secret.png'], 'PATH_OUT_OF_SCOPE'], [['escape/secret.png'], 'PATH_OUT_OF_SCOPE'], [['.env/a.png'], 'PATH_OUT_OF_SCOPE'], [['中文 图.png','中文 图.png'], 'INVALID_INPUT']]) {
      const error = await client.callTool({ name: 'view_project_images', arguments: { ...args, paths } });
      assert.equal(error.isError, true); assert.match(error.content[0].text, new RegExp(expected));
      assert.equal(error.structuredContent.status, 'error');
    }
    for (const absolute of [path.join(project, 'escape', 'secret.png'), project + '/sub/../中文 图.png']) {
      const error = await client.callTool({ name: 'view_project_images', arguments: { ...args, paths: [absolute] } });
      assert.equal(error.isError, true); assert.match(error.content[0].text, /LOCAL_PATH_REQUIRED/);
    }
    const outside = path.join(folder, 'outside.png');
    await writeFile(outside, await readFile(path.join(project, '中文 图.png')));
    const local = await client.callTool({ name: 'view_project_images', arguments: { paths: [outside], question: 'Continue task' } });
    assert.equal(local.isError, false, JSON.stringify(local.content));
    assert.equal(local.structuredContent.images[0].path, outside);
    const discovery = await invoke('discover_local_images', { path: folder, recursive: true, contains: 'outside', limit: 1 }, c);
    assert.equal(discovery.ok, true);
    assert.equal(discovery.result.images[0].path, outside);
    assert.ok(discovery.result.skipped_entries >= 1);
    const roots = await invoke('discover_local_images', {}, c);
    assert.ok(roots.result.roots.length > 0);
    for (const value of ['relative.png', '//server/share/a.png']) {
      const denied = await client.callTool({ name: 'view_project_images', arguments: { paths: [value], question: 'Read' } });
      assert.equal(denied.isError, true);
    }
    // Exercise the raised source-byte and pixel limits, and the upper rejection.
    const expanded = path.join(folder, 'expanded.png');
    await writeFile(expanded, Buffer.concat([await readFile(outside), Buffer.alloc(21 * 1024 * 1024)]));
    const expandedResult = await client.callTool({ name: 'view_project_images', arguments: { paths: [expanded], question: 'Read' } });
    assert.equal(expandedResult.isError, false);
    assert.ok(expandedResult.structuredContent.images[0].source_bytes > 20 * 1024 * 1024);
    assert.ok(expandedResult.structuredContent.images[0].bytes <= 768 * 1024);
    await writeFile(expanded, Buffer.alloc(32 * 1024 * 1024 + 1));
    const tooLarge = await client.callTool({ name: 'view_project_images', arguments: { paths: [expanded], question: 'Read' } });
    assert.equal(tooLarge.isError, true); assert.match(tooLarge.content[0].text, /IMAGE_TOO_LARGE/);
    await execute(c.python, ['-c', "import sys,json;from PIL import Image;Image.new('RGB',(6000,5000),'blue').save(json.load(sys.stdin)['path'])"], JSON.stringify({ path: expanded }));
    const pixels = await client.callTool({ name: 'view_project_images', arguments: { paths: [expanded], question: 'Read' } });
    assert.equal(pixels.isError, false); assert.equal(pixels.structuredContent.images[0].original_width, 6000);
    const remote = await client.callTool({ name: 'view_project_images', arguments: { ...args, project_id: 'remote' } });
    assert.equal(remote.isError, true); assert.match(remote.content[0].text, /LOCAL_ONLY/);
  } finally {
    await client.close(); await server.close();
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'x14-image-tests-'));
    await rm(folder, { recursive: true, force: true });
  }
});

const script = await readFile(new URL('../src/ui/project-images.js', import.meta.url), 'utf8');
const bytes = Buffer.from('test bytes'), sha256 = createHash('sha256').update(bytes).digest('hex');
const payload = { structuredContent: { run_id: 'test', status: 'waiting_for_widget', project_id: 'test', question: '对比图片', images: [1,2].map(index => ({ index, path: `img${index}.png`, bytes: bytes.length, sha256, mime_type: 'image/png', width: 10, height: 10 })) }, _meta: { 'x14/images': { token: 'token', base64: [bytes.toString('base64'), bytes.toString('base64')] } } };
function host({ granted = true, uploadError = false } = {}) {
  const elements = {}, listeners = {}, states = [], uploads = [], requests = [], timers = new Set(), storage = new Map();
  const window = { addEventListener: (key, fn) => { (listeners[key] ||= []).push(fn); }, openai: {
    uploadFile: async file => { uploads.push(file); if (uploadError) throw new Error('upload rejected'); return { fileId: 'host-file-' + uploads.length }; },
    setWidgetState: value => { states.push(value); window.openai.widgetState = value; }
  } };
  const emit = data => { for (const fn of listeners.message || []) fn({ source: window.parent, data }); };
  window.parent = { postMessage: message => {
    if (message.id === undefined) return;
    requests.push(message);
    queueMicrotask(() => emit({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/call' ? { structuredContent: { granted, reason: 'already_claimed' } } : {} }));
  } };
  vm.runInNewContext(script, { window, document: { getElementById: id => elements[id] ||= { appendChild() {} }, createElement: () => ({}) }, File, Uint8Array, crypto: webcrypto, atob,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, val) => storage.set(key, val) },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; }, clearTimeout: id => { clearTimeout(id); timers.delete(id); } });
  return { uploads, states, requests, send: (result = payload) => emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    globals: result => { window.openai.toolOutput = result; for (const fn of listeners['openai:set_globals'] || []) fn({}); },
    settle: async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 2)); },
    report: () => JSON.parse(elements.diagnostics.textContent), dispose: () => { for (const id of timers) clearTimeout(id); } };
}
test('project widget sends ordered images and original question once; duplicate delivery is ignored', async () => {
  const h = host();
  try {
    await h.settle(); h.send(); await h.settle();
    assert.equal(h.uploads.length, 2);
    assert.deepEqual(Array.from(h.states.at(-1).imageIds), ['host-file-1', 'host-file-2']);
    const messages = h.requests.filter(r => r.method === 'ui/message'); assert.equal(messages.length, 1);
    assert.match(messages[0].params.content[0].text, /对比图片/);
    assert.match(messages[0].params.content[0].text, /img1.png/);
    h.send(); await h.settle(); assert.equal(h.uploads.length, 2); assert.equal(h.report().followup_attempts, 1);
  } finally { h.dispose(); }
});

test('project widget displays tool errors through notification and globals without uploading', async () => {
  for (const route of ['send', 'globals']) {
    const h = host();
    try {
      await h.settle();
      h[route]({ isError: true, content: [{ type: 'text', text: 'PATH_OUT_OF_SCOPE: rejected' }], structuredContent: { status: 'error', error: 'PATH_OUT_OF_SCOPE: rejected' } });
      await h.settle();
      assert.equal(h.report().stage, 'stopped');
      assert.match(h.report().error, /PATH_OUT_OF_SCOPE/);
      assert.equal(h.uploads.length, 0);
      assert.equal(h.requests.filter(r => r.method === 'ui/message').length, 0);
    } finally { h.dispose(); }
  }
});
test('project widget refuses duplicate server claim and does not retry failed upload', async () => {
  for (const settings of [{ granted: false }, { uploadError: true }]) {
    const h = host(settings);
    try {
      await h.settle(); h.send(); await h.settle(); h.send(); await h.settle();
      assert.equal(h.uploads.length, settings.uploadError ? 1 : 0);
      assert.equal(h.requests.filter(r => r.method === 'ui/message').length, 0);
    } finally { h.dispose(); }
  }
});
