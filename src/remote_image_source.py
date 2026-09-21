"""Read one project-scoped SSH image using only the remote standard library.

Executed from Bridge-owned source over SSH; no remote package installation.
"""
import base64
import json
from pathlib import Path
import sys


def read_source(request):
    sys.path.insert(0, str(Path(request['project']['engine']).parent))
    from engine import Engine, fail
    engine = Engine(request)
    supplied = request['args']['path']
    path = Path(supplied)
    if '..' in path.parts or supplied.startswith('//'):
        fail('PATH_OUT_OF_SCOPE', 'Parent traversal and network paths are not supported.')
    if path.is_absolute():
        try:
            supplied = path.relative_to(Path(request['project']['root'])).as_posix()
        except ValueError:
            fail('PATH_OUT_OF_SCOPE', 'SSH images must be inside the configured project.')
    path = engine.path(supplied)
    if not path.is_file():
        fail('NOT_FOUND', 'Image not found: ' + supplied)
    if path.suffix.lower() not in {'.png', '.jpg', '.jpeg'}:
        fail('UNSUPPORTED_IMAGE', 'Only PNG and JPEG are supported: ' + supplied)
    with path.open('rb') as source:
        raw = source.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        fail('IMAGE_TOO_LARGE', 'Image exceeds 32 MiB: ' + supplied)
    return {'path': supplied, 'suffix': path.suffix, 'base64': base64.b64encode(raw).decode('ascii')}


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': read_source(json.load(sys.stdin))}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': {'code': getattr(error, 'code', 'REMOTE_IMAGE_ERROR'), 'message': str(error)}}))
