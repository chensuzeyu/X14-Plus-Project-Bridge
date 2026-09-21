import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImageBatch } from '../src/image-batch.mjs';

const config = { projects: [{ id: 'local', target: 'local' }, { id: 'remote', target: 'ssh' }] };
test('mixed batch preserves host identity and order for same-named images', async () => {
  const calls = [];
  const prepare = async (action, args) => {
    calls.push(args);
    return { ok: true, target: args.project_id + '-host', result: { images: [{ index: 1, path: args.paths[0], base64: args.project_id }] } };
  };
  const images = await prepareImageBatch({ sources: [{ project_id: 'local', path: 'RIT1.png' }, { project_id: 'remote', path: 'RIT1.png' }] }, config, prepare);
  assert.deepEqual(images.map(i => [i.index, i.project_id, i.source_target, i.base64]), [[1, 'local', 'local-host', 'local'], [2, 'remote', 'remote-host', 'remote']]);
  assert.equal(calls.length, 2);
});
test('invalid or failed mixed batches never return partial evidence', async () => {
  let calls = 0;
  const prepare = async () => { calls++; return { ok: true, target: 'host', result: { images: [{ path: 'one.png' }] } }; };
  for (const args of [{}, { sources: [] }, { sources: [{ path: 'x' }], paths: ['x'] }, { sources: [{ project_id: 'unknown', path: 'x' }] }, { sources: [{ path: 'x' }, { path: 'x' }] }, { sources: Array.from({ length: 5 }, (_, i) => ({ path: String(i) })) }]) {
    await assert.rejects(prepareImageBatch(args, config, prepare));
  }
  assert.equal(calls, 0);
  await assert.rejects(prepareImageBatch({ sources: [{ project_id: 'local', path: 'one.png' }, { project_id: 'remote', path: 'two.png' }] }, config, async (...args) => {
    if (args[1].project_id === 'remote') return { ok: false, error: { code: 'NOT_FOUND', message: 'two.png' } };
    return prepare(...args);
  }), /NOT_FOUND/);
});
