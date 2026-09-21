"""Project operations. Standard library only; runs unchanged on Windows and SSH Linux."""
import base64
import contextlib
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

MAX_FILE = 2 * 1024 * 1024
SKIP = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.cache'}
PRIVATE = {'.ssh', '.codex', '.aws', '.azure', '.gnupg', '.x14-plus-project-bridge', '.env', '.npmrc', '.pypirc'}


class BridgeError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise BridgeError(code, message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False).encode('utf-8'))


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.bridge-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if path.exists():
            os.chmod(name, path.stat().st_mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def locked(path):
    # An OS lock is released even if the process crashes. The lock file may remain.
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a+b') as f:
        f.seek(0)
        f.write(b'0')
        f.flush()
        f.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fail('BUSY', 'Another project write is active; retry with the same operation_id.')
        try:
            yield
        finally:
            f.seek(0)
            if os.name == 'nt':
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)


def safe_id(value):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        fail('INVALID_INPUT', 'ID must contain only letters, numbers, hyphens and underscores.')
    return value


class Engine:
    def __init__(self, request):
        self.project = request['project']
        self.root = Path(self.project['root']).resolve(strict=True)
        self.state = Path(request['state']).resolve() / safe_id(self.project['id'])
        self.state.mkdir(parents=True, exist_ok=True)
        self.args = request.get('args', {})

    def path(self, rel='.', writable=False):
        if not isinstance(rel, str) or '\x00' in rel or '\\' in rel or ':' in rel:
            fail('PATH_OUT_OF_SCOPE', 'Use a project-relative path with forward slashes.')
        p = Path(rel)
        if p.is_absolute() or '..' in p.parts:
            fail('PATH_OUT_OF_SCOPE', 'Absolute paths and parent traversal are not allowed.')
        for part in p.parts:
            low = part.lower()
            if low in PRIVATE or (low.startswith('.env.') and low not in {'.env.example', '.env.sample'}):
                fail('PATH_OUT_OF_SCOPE', 'Credential/runtime directories are excluded from file tools.')
            if low.rstrip(' .') != low or re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?', low):
                fail('PATH_OUT_OF_SCOPE', 'Ambiguous or reserved path component.')
            if writable and low == '.git':
                fail('PATH_OUT_OF_SCOPE', 'Use Git commands to modify Git metadata.')
        candidate = self.root / p
        resolved = candidate.resolve()
        if not resolved.is_relative_to(self.root) or resolved == self.state or self.state in resolved.parents:
            fail('PATH_OUT_OF_SCOPE', 'Path resolves outside the allowed project or into private state.')
        # Reject links/junctions even inside the root: predictable file API semantics.
        for ancestor in [candidate, *candidate.parents]:
            if ancestor == self.root:
                break
            if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
                fail('PATH_OUT_OF_SCOPE', 'Links and junctions are not supported by file tools.')
        return candidate

    def data(self, rel):
        p = self.path(rel)
        if not p.is_file():
            fail('NOT_FOUND', f'Not a file: {rel}')
        if p.stat().st_size > MAX_FILE:
            fail('FILE_TOO_LARGE', f'File exceeds {MAX_FILE} bytes: {rel}')
        return p.read_bytes()

    def text(self, rel):
        raw = self.data(rel)
        if b'\x00' in raw:
            fail('BINARY_FILE', f'Binary file: {rel}')
        try:
            return raw, raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            fail('UNSUPPORTED_ENCODING', f'Expected UTF-8 text: {rel}')

    def listing(self):
        a = self.args
        start = self.path(a.get('path', '.'))
        offset = a.get('offset', 0)
        limit = a.get('limit', 200)
        result, seen, visited = [], 0, 0
        deadline = time.monotonic() + 8
        stack = [start]
        incomplete = False
        while stack:
            directory = stack.pop()
            if time.monotonic() > deadline or visited > 20000:
                incomplete = True
                break
            try:
                entries = sorted(os.scandir(directory), key=lambda e: e.name.lower())
            except OSError:
                incomplete = True
                continue
            dirs = []
            for entry in entries:
                visited += 1
                if entry.name in SKIP:
                    continue
                rel = Path(entry.path).relative_to(self.root).as_posix()
                try:
                    p = self.path(rel)
                except BridgeError:
                    continue
                if p.is_dir():
                    if a.get('recursive', True):
                        dirs.append(p)
                    kind = 'directory'
                elif p.is_file():
                    kind = 'file'
                else:
                    continue
                if a.get('contains', '').lower() not in rel.lower():
                    continue
                if seen >= offset:
                    if len(result) >= limit:
                        return {'items': result, 'next_offset': seen, 'truncated': True, 'visited': visited}
                    result.append({'path': rel, 'kind': kind, 'size': p.stat().st_size if kind == 'file' else None})
                seen += 1
            stack.extend(reversed(dirs))
        return {'items': result, 'next_offset': None, 'truncated': incomplete, 'visited': visited,
                'note': 'Listing is not a snapshot; narrow path if scan budget is exceeded.'}

    def read(self):
        results = []
        budget = self.args.get('max_chars', 60000)
        for item in self.args['files']:
            rel = item['path']
            try:
                raw, text = self.text(rel)
                lines = text.splitlines(keepends=True)
                start = item.get('start_line', 1)
                end = min(item.get('end_line', start + 299), len(lines))
                selected = ''.join(lines[start - 1:end])
                content = selected[:max(0, budget)]
                budget -= len(content)
                results.append({'path': rel, 'sha256': digest(raw), 'encoding': 'utf-8-sig' if raw.startswith(b'\xef\xbb\xbf') else 'utf-8',
                                'newline': 'CRLF' if '\r\n' in text else 'LF', 'total_lines': len(lines),
                                'start_line': start, 'end_line': end, 'content': content,
                                'truncated': len(content) < len(selected) or end < len(lines)})
            except (BridgeError, OSError) as e:
                results.append({'path': rel, 'error': getattr(e, 'code', 'IO_ERROR'), 'message': str(e)})
        return {'files': results}

    def search(self):
        a = self.args
        query = a['query'] if a.get('case_sensitive', False) else a['query'].casefold()
        matches, skipped, scanned = [], 0, 0
        page_args = dict(a, limit=500, recursive=True)
        offset = a.get('file_offset', 0)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.args = dict(page_args, offset=offset)
            page = self.listing()
            for i, entry in enumerate(page['items']):
                if entry['kind'] != 'file':
                    continue
                try:
                    _, text = self.text(entry['path'])
                except (BridgeError, OSError):
                    skipped += 1
                    continue
                scanned += 1
                file_matches = []
                for line_no, line in enumerate(text.splitlines(), 1):
                    haystack = line if a.get('case_sensitive', False) else line.casefold()
                    if query in haystack:
                        file_matches.append({'path': entry['path'], 'line': line_no, 'text': line[:1000]})
                        if len(file_matches) >= 100:
                            break
                matches.extend(file_matches)
                if len(matches) >= a.get('limit', 100) or time.monotonic() >= deadline:
                    return {'matches': matches, 'next_file_offset': offset + i + 1, 'truncated': True,
                            'scanned_files': scanned, 'skipped_files': skipped, 'per_file_limit': 100}
            if page['next_offset'] is None:
                return {'matches': matches, 'next_file_offset': None, 'truncated': page['truncated'], 'scanned_files': scanned, 'skipped_files': skipped}
            offset = page['next_offset']
        return {'matches': matches, 'next_file_offset': offset, 'truncated': True, 'scanned_files': scanned, 'skipped_files': skipped}

    def write_allowed(self):
        if not self.project.get('write', False):
            fail('UNAUTHORIZED', 'Project is read-only.')

    def changes(self):
        self.write_allowed()
        a = self.args
        op = safe_id(a['operation_id'])
        record = self.state / 'changes' / (op + '.json')
        request_hash = digest(json.dumps(a, sort_keys=True).encode())
        with locked(self.state / 'write.lock'):
            if record.exists():
                old = json.loads(record.read_text('utf-8'))
                if old['request_hash'] != request_hash:
                    fail('CONFLICT', 'operation_id was already used with different arguments.')
                if old['status'] != 'completed':
                    fail('RECOVERY_REQUIRED', f'Operation {op} has status {old["status"]}; inspect files before retrying.')
                return dict(old['result'], replayed=True)
            prepared, paths = [], set()
            for change in a['changes']:
                rel = change['path']
                p = self.path(rel, writable=True)
                canonical = os.path.normcase(str(p))
                if canonical in paths:
                    fail('INVALID_INPUT', 'Each file may appear only once in a batch.')
                paths.add(canonical)
                before = self.data(rel) if p.exists() else None
                if change.get('expected_sha256') != (digest(before) if before is not None else None):
                    fail('CONFLICT', f'File changed since read: {rel}')
                kind = change['kind']
                if kind == 'delete':
                    if before is None:
                        fail('NOT_FOUND', rel)
                    after = None
                elif kind == 'restore_internal':
                    after = base64.b64decode(change['bytes'])
                elif kind == 'replace':
                    if before is None:
                        fail('NOT_FOUND', rel)
                    _, current = self.text(rel)
                    for replacement in change['replacements']:
                        old, new = replacement['old'], replacement['new']
                        if not old or current.count(old) != 1:
                            fail('CONFLICT', f'Replacement must match exactly once: {rel}')
                        current = current.replace(old, new, 1)
                    after = current.encode('utf-8-sig' if before.startswith(b'\xef\xbb\xbf') else 'utf-8')
                else:
                    content = change['content']
                    if before is not None:
                        _, original = self.text(rel)
                        if '\r\n' in original:
                            content = content.replace('\r\n', '\n').replace('\n', '\r\n')
                    after = content.encode('utf-8-sig' if before and before.startswith(b'\xef\xbb\xbf') else 'utf-8')
                if after is not None and len(after) > MAX_FILE:
                    fail('FILE_TOO_LARGE', rel)
                prepared.append({'path': rel, 'before': base64.b64encode(before).decode() if before is not None else None,
                                 'after': base64.b64encode(after).decode() if after is not None else None,
                                 'before_sha256': digest(before) if before is not None else None,
                                 'after_sha256': digest(after) if after is not None else None})
            journal = {'status': 'prepared', 'request_hash': request_hash, 'files': prepared, 'created_at': time.time()}
            save_json(record, journal)
            applied = []
            try:
                for item in prepared:
                    p = self.path(item['path'], writable=True)
                    now = p.read_bytes() if p.exists() else None
                    if (digest(now) if now is not None else None) != item['before_sha256']:
                        fail('CONFLICT', f'Concurrent external edit: {item["path"]}')
                    if item['after'] is None:
                        p.unlink()
                    else:
                        atomic(p, base64.b64decode(item['after']))
                    applied.append(item)
            except Exception:
                journal['status'] = 'partial_failure'
                journal['applied_paths'] = [v['path'] for v in applied]
                save_json(record, journal)
                raise
            result_files = []
            for item in prepared:
                before = base64.b64decode(item['before'] or '').decode('utf-8-sig', errors='replace')
                after = base64.b64decode(item['after'] or '').decode('utf-8-sig', errors='replace')
                diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile=item['path'], tofile=item['path']))
                result_files.append({'path': item['path'], 'before_sha256': item['before_sha256'], 'sha256': item['after_sha256'],
                                     'diff': diff[:12000], 'diff_truncated': len(diff) > 12000})
            result = {'change_id': op, 'status': 'completed', 'files': result_files, 'replayed': False}
            journal.update(status='completed', result=result)
            save_json(record, journal)
            return result

    def restore(self):
        source = self.state / 'changes' / (safe_id(self.args['change_id']) + '.json')
        journal = json.loads(source.read_text('utf-8'))
        changes = []
        for item in journal['files']:
            if journal['status'] == 'partial_failure' and item['path'] not in journal.get('applied_paths', []):
                continue
            changes.append({'path': item['path'], 'kind': 'delete' if item['before'] is None else 'restore_internal',
                            'expected_sha256': item['after_sha256'],
                            'bytes': item['before']})
        if journal['status'] not in {'completed', 'partial_failure'}:
            fail('RECOVERY_REQUIRED', 'Interrupted journal requires manual inspection; no automatic overwrite.')
        self.args = {'operation_id': self.args['operation_id'], 'changes': changes}
        return self.changes()

    def git(self):
        action = self.args.get('action', 'status')
        commands = {'status': ['status', '--short', '--branch'],
                    'diff': ['diff', '--no-ext-diff', '--no-textconv', '--stat'],
                    'patch': ['diff', '--no-ext-diff', '--no-textconv', '--', '.'],
                    'log': ['log', '-10', '--oneline', '--no-decorate']}
        env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_PAGER='cat', GIT_OPTIONAL_LOCKS='0')
        with tempfile.TemporaryFile() as output:
            try:
                completed = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', *commands[action]],
                                           cwd=self.path(self.args.get('path', '.')), env=env, stdout=output, stderr=subprocess.STDOUT, timeout=15)
            except subprocess.TimeoutExpired:
                fail('TIMEOUT', 'Git inspection timed out.')
            output.seek(0)
            text = output.read(60001).decode('utf-8', errors='replace')
        return {'exit_code': completed.returncode, 'output': text[:60000], 'truncated': len(text) > 60000}

    def context(self):
        path = self.args.get('path', '.')
        self.args = {'path': path, 'recursive': False, 'limit': 150}
        listing = self.listing()
        names = ['AGENTS.md', 'README.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod']
        files = []
        # Root and intervening AGENTS files apply to a selected subproject.
        rel = Path(path)
        ancestors = [Path('.')]
        for part in rel.parts:
            ancestors.append(ancestors[-1] / part)
        candidates = [(p / 'AGENTS.md').as_posix() for p in ancestors]
        candidates += [(rel / n).as_posix() for n in names]
        for name in dict.fromkeys(candidates):
            if self.path(name).is_file():
                files.append({'path': name, 'end_line': 180})
        self.args = {'files': files, 'max_chars': 35000}
        contents = self.read()
        self.args = {'path': path}
        return {'root': str(self.root), 'listing': listing, **contents, 'git': self.git(),
                'coverage': 'Top-level summary only. Search and read relevant files; nested AGENTS.md may apply.'}

    def start_job(self):
        if not self.project.get('execute', False):
            fail('UNAUTHORIZED', 'Command execution is disabled for this project.')
        a = self.args
        job_id = safe_id(a['operation_id'])
        folder = self.state / 'jobs' / job_id
        spec_hash = digest(json.dumps(a, sort_keys=True).encode())
        with locked(self.state / 'jobs.lock'):
            if folder.exists():
                spec = json.loads((folder / 'spec.json').read_text('utf-8'))
                if spec['request_hash'] != spec_hash:
                    fail('CONFLICT', 'operation_id already belongs to another job.')
                return {'job_id': job_id, 'replayed': True, 'status': 'query_with_get_job'}
            cwd = self.path(a.get('cwd', '.'))
            if not cwd.is_dir():
                fail('NOT_FOUND', 'Job working directory does not exist.')
            proxy = self.project.get('proxy') if a.get('use_proxy', False) else None
            if a.get('use_proxy', False) and not proxy:
                fail('PROXY_UNAVAILABLE', 'No proxy configured for this project.')
            folder.mkdir(parents=True)
            spec = dict(a, cwd=str(cwd), request_hash=spec_hash, proxy=proxy)
            save_json(folder / 'spec.json', spec)
            save_json(folder / 'status.json', {'status': 'starting', 'started_at': time.time()})
            kwargs = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker', str(folder)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **kwargs)
        return {'job_id': job_id, 'replayed': False, 'status': 'starting', 'scope': 'Commands run with the service account permissions; cwd is not a sandbox.'}

    def get_job(self):
        folder = self.state / 'jobs' / safe_id(self.args['job_id'])
        status = json.loads((folder / 'status.json').read_text('utf-8'))
        offset = self.args.get('offset', 0)
        log = folder / 'output.log'
        data = b''
        if log.exists():
            with log.open('rb') as f:
                f.seek(offset)
                data = f.read(self.args.get('max_bytes', 32000))
        if status['status'] in {'starting', 'running'} and time.time() - status.get('heartbeat', status['started_at']) > 20:
            status = dict(status, status='unknown', note='Worker heartbeat is stale. Inspect before restarting; do not blindly repeat.')
        return dict(status, job_id=self.args['job_id'], output=data.decode('utf-8', errors='replace'),
                    next_offset=offset + len(data), has_more=log.exists() and log.stat().st_size > offset + len(data))

    def cancel_job(self):
        if not self.project.get('execute', False):
            fail('UNAUTHORIZED', 'Command execution is disabled.')
        folder = self.state / 'jobs' / safe_id(self.args['job_id'])
        if not (folder / 'status.json').exists():
            fail('NOT_FOUND', 'Unknown job.')
        (folder / 'cancel').touch()
        return {'job_id': self.args['job_id'], 'status': 'cancellation_requested', 'note': 'Query get_job for confirmed termination.'}


def worker(folder):
    folder = Path(folder)
    spec = json.loads((folder / 'spec.json').read_text('utf-8'))
    started = time.time()
    status = {'status': 'running', 'started_at': started, 'heartbeat': started, 'worker_pid': os.getpid()}
    # Do not inherit the tunnel API key or unrelated parent-process tokens.
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'LANG', 'LC_ALL', 'USER', 'USERNAME'}
    env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    env.update(PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')
    if spec.get('proxy'):
        env.update({k: spec['proxy'] for k in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']})
        env.update(NO_PROXY='localhost,127.0.0.1,::1', no_proxy='localhost,127.0.0.1,::1')
    command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', spec['command']] if os.name == 'nt' else ['/bin/bash', '--noprofile', '--norc', '-c', spec['command']]
    try:
        kwargs = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
        process = subprocess.Popen(command, cwd=spec['cwd'], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        status['pid'] = process.pid
        save_json(folder / 'status.json', status)
        def drain():
            count = 0
            with (folder / 'output.log').open('wb') as log:
                while True:
                    chunk = process.stdout.read(4096)
                    if not chunk:
                        break
                    if count < 8 * 1024 * 1024:
                        log.write(chunk[:8 * 1024 * 1024 - count])
                        log.flush()
                    count += len(chunk)
                status['output_truncated'] = count > 8 * 1024 * 1024
        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        reason = None
        while process.poll() is None:
            if (folder / 'cancel').exists():
                reason = 'cancelled'
            elif time.time() - started > spec.get('timeout_seconds', 600):
                reason = 'timed_out'
            if reason:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                    time.sleep(0.5)
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=10)
                break
            status['heartbeat'] = time.time()
            save_json(folder / 'status.json', status)
            time.sleep(0.5)
        thread.join(timeout=3)
        status.update(status=reason or 'completed', exit_code=process.returncode, ended_at=time.time(), heartbeat=time.time())
    except Exception as e:
        status.update(status='failed', message=str(e), ended_at=time.time())
    save_json(folder / 'status.json', status)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        worker(sys.argv[2])
        return
    try:
        request = json.load(sys.stdin)
        engine = Engine(request)
        actions = {'list_files': engine.listing, 'read_files': engine.read, 'search_project': engine.search,
                   'apply_changes': engine.changes, 'restore_change': engine.restore, 'git_inspect': engine.git,
                   'project_context': engine.context, 'start_job': engine.start_job, 'get_job': engine.get_job,
                   'cancel_job': engine.cancel_job}
        if request['action'] == 'discover_local_images':
            from local_images import discover_images
            result = discover_images(engine)
        elif request['action'] == 'prepare_images':
            from project_images import prepare_images
            result = prepare_images(engine)
        else:
            result = actions[request['action']]()
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': {'code': getattr(e, 'code', 'IO_ERROR'), 'message': str(e)}}, ensure_ascii=False))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stdin.reconfigure(encoding='utf-8')
    main()
