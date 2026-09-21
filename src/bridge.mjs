import { spawn } from 'node:child_process';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const configPath = process.env.X14_BRIDGE_CONFIG || path.join(process.env.LOCALAPPDATA || homedir(), 'X14-Plus-Project-Bridge', 'config.json');
export async function config() {
  const c = JSON.parse(await readFile(configPath, 'utf8'));
  if (!c.machine_id || !Array.isArray(c.projects) || !c.python) throw new Error('Invalid bridge configuration. Run npm run setup.');
  return c;
}

export function execute(command, args, input, timeout = 45000, maxOutput = 5_000_000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    delete env.CONTROL_PLANE_API_KEY;
    delete env.OPENAI_API_KEY;
    const child = spawn(command, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '', error = '', settled = false;
    const finish = (err, data) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(data); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('TARGET_TIMEOUT: operation state may be unknown; reuse operation_id and inspect before retrying.')); }, timeout);
    child.on('error', e => finish(e));
    child.stdout.on('data', b => {
      output += b.toString('utf8');
      if (output.length > maxOutput) { child.kill(); finish(new Error('RESULT_TOO_LARGE')); }
    });
    child.stderr.on('data', b => { error = (error + b.toString('utf8')).slice(-6000); });
    child.on('close', code => finish(code === 0 ? null : new Error(`TARGET_UNREACHABLE (${code}): ${error}`), output));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const quotePosix = s => "'" + s.replaceAll("'", "'\\''") + "'";

export async function invoke(action, args, suppliedConfig) {
  const c = suppliedConfig || await config();
  if (action === 'bridge_status') return {
    machine_id: c.machine_id, machine_name: c.machine_name, version: '0.1.0',
    projects: c.projects.length, codex_required: false,
    transport: 'stdio or authenticated loopback HTTP',
    connectivity: 'Local service responding. SSH and ChatGPT tunnel availability require separate probes.',
    command_boundary: 'Commands execute as the service account. Project cwd is not a security sandbox.'
  };
  if (action === 'list_projects') return { machine_id: c.machine_id, projects: c.projects.map(p => ({
    project_id: p.id, name: p.name, target: p.target, root: p.root,
    write: p.write, execute: p.execute, proxy_available: Boolean(p.proxy)
  })) };
  const localImageAction = action === 'discover_local_images' || (action === 'prepare_images' && !args.project_id);
  const p = localImageAction ? { id: 'local-images', target: 'local', root: root, write: false, execute: false } : c.projects.find(v => v.id === args.project_id);
  if (!p) throw new Error('UNAUTHORIZED: unknown project_id. Call list_projects first.');
  const payload = JSON.stringify({ action, args, project: p, state: p.target === 'ssh' ? p.state : c.state });
  const started = Date.now();
  let response;
  try {
    if (p.target === 'ssh' && action === 'prepare_images') {
      const { prepareRemoteImages } = await import('./remote-images.mjs');
      response = { ok: true, result: await prepareRemoteImages(p, args, c) };
      return { machine_id: c.machine_id, project_id: p.id, target: p.host, ...response };
    }
    const text = p.target === 'ssh'
      ? await execute(c.ssh || 'ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ClearAllForwardings=yes', p.host,
          `${quotePosix(p.python || 'python3')} ${quotePosix(p.engine)}`], payload)
      : await execute(c.python, [path.join(root, 'src', 'engine.py')], payload);
    response = JSON.parse(text);
    return { machine_id: c.machine_id, project_id: p.id, target: p.target === 'ssh' ? p.host : c.machine_name, ...response };
  } finally {
    await mkdir(c.state, { recursive: true });
    await appendFile(path.join(c.state, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), action,
      project_id: p.id, operation_id: args.operation_id, ok: response?.ok ?? false, duration_ms: Date.now() - started }) + '\n');
  }
}
