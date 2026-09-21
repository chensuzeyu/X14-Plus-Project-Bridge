import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configPath, root } from '../src/bridge.mjs';

const client = new Client({ name: 'remote-acceptance', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs'), '--stdio'], env: { ...process.env, X14_BRIDGE_CONFIG: configPath } }));

const prefix = 'bridge-acceptance-' + randomUUID();
const rel = `tmp/${prefix}/中文 sample.txt`;
const call = async (action, args) => {
  const response = await client.callTool({ name: action, arguments: { project_id: 'volcengine-cszy', ...args } });
  assert.equal(response.isError, false, JSON.stringify(response));
  const r = response.structuredContent;
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
};
try {
const created = await call('apply_changes', { operation_id: prefix, changes: [{ kind: 'write', path: rel, content: 'remote-bridge-test\n第二行\n', expected_sha256: null }] });
const read = await call('read_files', { files: [{ path: rel }] });
assert.equal(read.files[0].sha256, created.files[0].sha256);
assert.match(read.files[0].content, /第二行/);
const search = await call('search_project', { path: `tmp/${prefix}`, query: 'remote-bridge-test' });
assert.equal(search.matches.length, 1);
const job = await call('start_job', { operation_id: prefix + '-job', command: "python3 -c 'print(6 * 7)'", timeout_seconds: 20 });
let final;
for (let i = 0; i < 20; i++) {
  final = await call('get_job', { job_id: job.job_id });
  if (!['starting', 'running'].includes(final.status)) break;
  await new Promise(r => setTimeout(r, 300));
}
assert.equal(final.exit_code, 0);
assert.match(final.output, /42/);
await call('restore_change', { change_id: prefix, operation_id: prefix + '-restore' });
assert.equal((await call('read_files', { files: [{ path: rel }] })).files[0].error, 'NOT_FOUND');
console.log(JSON.stringify({ ssh_read_write_search_rollback: 'PASS', persistent_job: 'PASS', test_directory: `tmp/${prefix}`, note: 'Test file removed via recorded restore; empty directory retained.' }, null, 2));
const network = await call('start_job', { operation_id: prefix + '-proxy', command: `python3 -c 'import urllib.request; print(urllib.request.urlopen("https://www.python.org", timeout=15).status)'`, timeout_seconds: 25, use_proxy: true });
for (let i = 0; i < 40; i++) {
  final = await call('get_job', { job_id: network.job_id });
  if (!['starting', 'running'].includes(final.status)) break;
  await new Promise(r => setTimeout(r, 500));
}
console.log(JSON.stringify({ proxy_job_status: final.status, exit_code: final.exit_code, output: final.output, note: 'Uses the existing 19081 forward; independent forwarding lifecycle has not been proven.' }, null, 2));
assert.equal(final.exit_code, 0);
assert.match(final.output, /200/);
} finally { await client.close(); }
