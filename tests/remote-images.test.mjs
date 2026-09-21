import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, execute, root } from '../src/bridge.mjs';

test('SSH source reader: exact bytes, absolute/relative paths and project boundaries without Pillow', async () => {
  const c = await config(), folder = await mkdtemp(path.join(os.tmpdir(), 'x14-remote-images-'));
  const project = path.join(folder, 'project'); await mkdir(project);
  const bytes = Buffer.from('source bytes; decoding happens locally');
  await writeFile(path.join(project, 'sample.png'), bytes);
  await writeFile(path.join(project, 'bad.txt'), bytes);
  await writeFile(path.join(project, 'huge.png'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await symlink(folder, path.join(project, 'escape'), 'junction');
  const p = { id: 'test', target: 'ssh', root: project, engine: path.join(root, 'src', 'engine.py') };
  const read = async file => JSON.parse(await execute(c.python, ['-S', path.join(root, 'src', 'remote_image_source.py')], JSON.stringify({ project: p, state: path.join(folder, 'state'), args: { path: file } }), 45000, 46_000_000));
  try {
    for (const name of ['sample.png', path.join(project, 'sample.png')]) {
      const result = await read(name);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.result.path, 'sample.png');
      assert.deepEqual(Buffer.from(result.result.base64, 'base64'), bytes);
    }
    for (const [name, code] of [['../sample.png', 'PATH_OUT_OF_SCOPE'], [path.join(folder, 'outside.png'), 'PATH_OUT_OF_SCOPE'], ['escape/sample.png', 'PATH_OUT_OF_SCOPE'], ['.ssh/key.png', 'PATH_OUT_OF_SCOPE'], ['missing.png', 'NOT_FOUND'], ['bad.txt', 'UNSUPPORTED_IMAGE'], ['huge.png', 'IMAGE_TOO_LARGE']]) {
      const result = await read(name);
      assert.equal(result.ok, false); assert.equal(result.error.code, code);
    }
  } finally {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'x14-remote-images-'));
    await rm(folder, { recursive: true, force: true });
  }
});
