"""Read-only discovery for local image files, independent of project roots."""
import os
import re
import time
from pathlib import Path
from engine import fail

EXTENSIONS = {'.png', '.jpg', '.jpeg'}


def local_path(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        fail('INVALID_INPUT', 'Supply an absolute local path.')
    p = Path(value)
    if not p.is_absolute() or value.startswith(('\\\\', '//')) or '..' in p.parts:
        fail('LOCAL_PATH_REQUIRED', 'Use an absolute local disk path, without parent traversal or network/device prefixes.')
    for part in p.parts[1:]:
        if ':' in part or part.rstrip(' .') != part or re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?', part, re.I):
            fail('LOCAL_PATH_REQUIRED', 'Ambiguous or device path is not supported.')
    if os.name == 'nt':
        import ctypes
        if ctypes.windll.kernel32.GetDriveTypeW(str(p.anchor)) not in (2, 3, 6):
            fail('LOCAL_PATH_REQUIRED', 'Only local disks are supported, not mapped network drives.')
    for ancestor in [p, *p.parents]:
        if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
            fail('LOCAL_PATH_REQUIRED', 'Use the actual local target path instead of a link or junction.')
    return p


def discover_images(engine):
    args = engine.args
    if not args.get('path'):
        if os.name == 'nt':
            import ctypes
            roots = [f'{letter}:/' for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                     if ctypes.windll.kernel32.GetDriveTypeW(f'{letter}:\\') in (2, 3, 6)]
        else:
            roots = ['/']
        return {'roots': roots, 'home': str(Path.home()), 'hint': 'Choose a directory, inspect subdirectories, then narrow the image search.'}
    root = local_path(args['path'])
    if not root.is_dir():
        fail('NOT_FOUND', 'Directory not found.')
    entries, directories = [], []
    scanned = skipped = 0
    truncated = False
    started = time.monotonic()
    pending = [root]
    while pending:
        folder = pending.pop()
        try:
            with os.scandir(folder) as items:
                for item in items:
                    scanned += 1
                    if scanned > 20000 or time.monotonic() - started > 8:
                        truncated = True
                        break
                    p = Path(item.path)
                    try:
                        if item.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()):
                            skipped += 1
                            continue
                        if item.is_dir(follow_symlinks=False):
                            if folder == root and len(directories) < 200:
                                directories.append(str(p))
                            if args.get('recursive', False):
                                pending.append(p)
                        elif item.is_file(follow_symlinks=False) and p.suffix.lower() in EXTENSIONS and args.get('contains', '').casefold() in p.name.casefold():
                            stat = item.stat(follow_symlinks=False)
                            entries.append({'path': str(p), 'bytes': stat.st_size, 'modified_at': stat.st_mtime})
                    except OSError:
                        skipped += 1
        except OSError:
            skipped += 1
        if truncated:
            break
    entries.sort(key=lambda entry: entry['path'].casefold())
    offset, limit = args.get('offset', 0), args.get('limit', 100)
    page = entries[offset:offset + limit]
    return {'path': str(root), 'directories': sorted(directories), 'images': page,
            'next_offset': offset + len(page), 'has_more': offset + len(page) < len(entries),
            'scan_truncated': truncated, 'scanned_entries': scanned, 'skipped_entries': skipped,
            'hint': 'If scan_truncated, narrow the directory. Pages are not a filesystem snapshot. Only filenames were searched; use view_project_images for visual content.'}
