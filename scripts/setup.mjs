import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { configPath, root, execute, quotePosix } from '../src/bridge.mjs';

const dir = path.dirname(configPath);
await mkdir(dir, { recursive: true });
let c;
try { c = JSON.parse(await readFile(configPath, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  c = {
    machine_id: randomUUID(), machine_name: 'X14-Plus', port: 18741,
    http_token: randomBytes(32).toString('hex'),
    python: 'D:\\app\\miniconda3\\python.exe', ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    state: path.join(dir, 'state'), projects: [
      { id: 'bridge', name: 'X14-Plus Project Bridge', target: 'local', root: root.replace(/[\\/]$/, ''), write: true, execute: true, proxy: 'http://127.0.0.1:7897' },
      { id: 'knowin', name: 'Knowin', target: 'local', root: 'D:\\Knowin', write: true, execute: true, proxy: 'http://127.0.0.1:7897' },
      { id: 'volcengine-cszy', name: 'volcengine-cszy', target: 'ssh', host: 'volcengine-cszy_1-L20', root: '/Knowin/sim/chensuzeyu',
        engine: '/Knowin/sim/chensuzeyu/.x14-plus-project-bridge/engine.py', state: '/Knowin/sim/chensuzeyu/.x14-plus-project-bridge/state',
        python: 'python3', write: true, execute: true, proxy: 'http://127.0.0.1:19081' }
    ]
  };
  await writeFile(configPath, JSON.stringify(c, null, 2), { mode: 0o600, flag: 'wx' });
}
await access(c.python);
await mkdir(c.state, { recursive: true });
if (process.platform === 'win32') {
  const who = (await execute('whoami', [], '')).trim();
  await execute('icacls', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], '');
}
if (process.argv.includes('--remote')) {
  const bytes = await readFile(path.join(root, 'src', 'engine.py'));
  for (const p of c.projects.filter(v => v.target === 'ssh')) {
    // Send code bytes over stdin; the remote command contains only locally configured paths.
    const install = "import sys,os,tempfile; from pathlib import Path; p=Path(" + JSON.stringify(p.engine) + "); p.parent.mkdir(parents=True,exist_ok=True); os.chmod(p.parent,0o700); b=sys.stdin.buffer.read(); f=tempfile.NamedTemporaryFile(dir=p.parent,delete=False); f.write(b); f.close(); os.chmod(f.name,0o600); os.replace(f.name,p); print('Remote engine installed')";
    console.log((await execute(c.ssh, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ClearAllForwardings=yes', p.host,
      `${quotePosix(p.python)} -c ${quotePosix(install)}`], bytes)).trim());
  }
}
console.log(`Configuration ready: ${configPath}\nMachine: ${c.machine_name}\nProjects: ${c.projects.map(p => p.id).join(', ')}\nSecrets are not printed.`);
