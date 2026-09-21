import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config, invoke } from '../src/bridge.mjs';

const installed = await config();
const folder = await mkdtemp(path.join(os.tmpdir(), 'x14-tests-'));
const projectRoot = path.join(folder, 'project');
await mkdir(projectRoot);
const c = { ...installed, state: path.join(folder, 'state'), projects: [{ id: 'test', target: 'local', root: projectRoot, write: true, execute: true }] };
const hash = b => createHash('sha256').update(b).digest('hex');
const call = (action, args = {}) => invoke(action, { project_id: 'test', ...args }, c);
const check = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };

test('UTF-8 Chinese/spaced paths; hash conflict; idempotence; exact rollback', async () => {
  const file = '中文 空格.txt';
  const original = Buffer.from('\ufeffone\r\ntwo\r\n');
  await writeFile(path.join(projectRoot, file), original);
  const read = check(await call('read_files', { files: [{ path: file }] })).files[0];
  assert.equal(read.sha256, hash(original));
  const args = { operation_id: 'change-1', changes: [{ kind: 'write', path: file, content: 'new\ntext\n', expected_sha256: read.sha256 }] };
  check(await call('apply_changes', args));
  assert.equal((await readFile(path.join(projectRoot, file))).toString(), '\ufeffnew\r\ntext\r\n');
  assert.equal(check(await call('apply_changes', args)).replayed, true);
  const conflict = await call('apply_changes', { ...args, operation_id: 'change-2' });
  assert.equal(conflict.error.code, 'CONFLICT');
  check(await call('restore_change', { change_id: 'change-1', operation_id: 'restore-1' }));
  assert.deepEqual(await readFile(path.join(projectRoot, file)), original);
  check(await call('apply_changes', { operation_id: 'delete-1', changes: [{ kind: 'delete', path: file, expected_sha256: hash(original) }] }));
  check(await call('restore_change', { change_id: 'delete-1', operation_id: 'restore-deleted' }));
  assert.deepEqual(await readFile(path.join(projectRoot, file)), original);
});

test('reject traversal, credentials, junction escape and duplicate alias writes', async () => {
  for (const p of ['../secret', 'C:/secret', '.ssh/id_rsa', '.env', 'file:stream', 'NUL', 'name.']) {
    const result = check(await call('read_files', { files: [{ path: p }] }));
    assert.equal(result.files[0].error, 'PATH_OUT_OF_SCOPE', p);
  }
  const outside = path.join(folder, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(projectRoot, 'escape'), 'junction');
  assert.equal(check(await call('read_files', { files: [{ path: 'escape/secret.txt' }] })).files[0].error, 'PATH_OUT_OF_SCOPE');
  const denied = await invoke('apply_changes', { project_id: 'test', operation_id: 'denied', changes: [] }, { ...c, projects: [{ ...c.projects[0], write: false }] });
  assert.equal(denied.error.code, 'UNAUTHORIZED');
  const duplicate = await call('apply_changes', { operation_id: 'duplicate', changes: [
    { kind: 'write', path: 'duplicate.txt', expected_sha256: null, content: 'a' },
    { kind: 'write', path: './duplicate.txt', expected_sha256: null, content: 'b' }
  ] });
  assert.equal(duplicate.error.code, 'INVALID_INPUT');
});

test('unique replacement, ambiguous replacement and rollback after external edit', async () => {
  await writeFile(path.join(projectRoot, 'replace.txt'), 'alpha\nbeta\n');
  const original = hash('alpha\nbeta\n');
  check(await call('apply_changes', { operation_id: 'replace-one', changes: [{ kind: 'replace', path: 'replace.txt', expected_sha256: original, replacements: [{ old: 'alpha', new: 'gamma' }] }] }));
  assert.equal(await readFile(path.join(projectRoot, 'replace.txt'), 'utf8'), 'gamma\nbeta\n');
  await writeFile(path.join(projectRoot, 'replace.txt'), 'external edit');
  assert.equal((await call('restore_change', { change_id: 'replace-one', operation_id: 'conflicted-restore' })).error.code, 'CONFLICT');
  assert.equal(await readFile(path.join(projectRoot, 'replace.txt'), 'utf8'), 'external edit');
  await writeFile(path.join(projectRoot, 'ambiguous.txt'), 'same same');
  assert.equal((await call('apply_changes', { operation_id: 'ambiguous', changes: [{ kind: 'replace', path: 'ambiguous.txt', expected_sha256: hash('same same'), replacements: [{ old: 'same', new: 'new' }] }] })).error.code, 'CONFLICT');
});

test('batch validates all preconditions before writing', async () => {
  const result = await call('apply_changes', { operation_id: 'invalid-batch', changes: [
    { kind: 'write', path: 'should-not-exist.txt', expected_sha256: null, content: 'new' },
    { kind: 'write', path: 'missing.txt', expected_sha256: 'a'.repeat(64), content: 'wrong' }
  ] });
  assert.equal(result.error.code, 'CONFLICT');
  assert.equal(check(await call('read_files', { files: [{ path: 'should-not-exist.txt' }] })).files[0].error, 'NOT_FOUND');
});

test('search, listing pagination and bounded context', async () => {
  await writeFile(path.join(projectRoot, 'README.md'), '# Test project\nuniqueNeedle\n');
  const context = check(await call('project_context'));
  assert.ok(context.files.some(f => f.path === 'README.md'));
  const results = check(await call('search_project', { query: 'uniqueneedle', limit: 100 }));
  assert.equal(results.matches[0].line, 2);
  const page = check(await call('list_files', { limit: 1 }));
  assert.equal(page.items.length, 1);
  assert.ok(page.next_offset);
});

async function waitJob(id) {
  for (let i = 0; i < 60; i++) {
    const status = check(await call('get_job', { job_id: id }));
    if (!['starting', 'running'].includes(status.status)) return status;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('job did not finish');
}

test('persistent jobs, retry de-duplication, cancellation and timeout', async () => {
  const id = randomUUID();
  const args = { operation_id: id, command: 'Write-Output "job-output"', timeout_seconds: 10 };
  check(await call('start_job', args));
  assert.equal(check(await call('start_job', args)).replayed, true);
  const result = await waitJob(id);
  assert.equal(result.exit_code, 0);
  assert.match(result.output, /job-output/);
  if (process.env.ProgramData || process.env.PROGRAMDATA) {
    const envId = randomUUID();
    check(await call('start_job', { operation_id: envId, command: 'Write-Output $env:ProgramData', timeout_seconds: 10 }));
    const inherited = await waitJob(envId);
    assert.equal(inherited.exit_code, 0);
    assert.equal(inherited.output.trim(), process.env.ProgramData || process.env.PROGRAMDATA);
  }
  const slow = randomUUID();
  check(await call('start_job', { operation_id: slow, command: 'Start-Sleep -Seconds 30', timeout_seconds: 1 }));
  assert.equal((await waitJob(slow)).status, 'timed_out');
  const cancel = randomUUID();
  check(await call('start_job', { operation_id: cancel, command: 'Start-Sleep -Seconds 30', timeout_seconds: 60 }));
  check(await call('cancel_job', { job_id: cancel }));
  assert.equal((await waitJob(cancel)).status, 'cancelled');
});

test.after(async () => {
  // Only remove the exact temporary tree created above; never a configured project.
  assert.ok(folder.startsWith(path.join(os.tmpdir(), 'x14-tests-')));
  await rm(folder, { recursive: true, force: true });
});
