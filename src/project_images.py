"""Bounded local image preparation. Pillow is loaded only for image operations."""
import base64
import io
import warnings
from pathlib import Path
from engine import fail, digest


def prepare_images(engine):
    if engine.project.get('target') != 'local':
        fail('LOCAL_ONLY', 'This version supports local projects only.')
    paths = engine.args.get('paths', [])
    if not isinstance(paths, list) or not 1 <= len(paths) <= 4 or len(set(paths)) != len(paths):
        fail('INVALID_INPUT', 'Supply 1 to 4 distinct image paths.')
    result = []
    for index, rel in enumerate(paths):
        supplied = Path(rel)
        if supplied.is_absolute():
            from local_images import local_path
            p = local_path(rel)
            # Keep historical relative labels for images within the selected project.
            for root in (Path(engine.project['root']), engine.root):
                try:
                    rel = supplied.relative_to(root).as_posix()
                    break
                except ValueError:
                    continue
        else:
            if not engine.args.get('project_id'):
                fail('LOCAL_PATH_REQUIRED', 'Without project_id, supply absolute local image paths.')
            p = engine.path(rel)
        if not p.is_file():
            fail('NOT_FOUND', 'Image not found: ' + rel)
        if p.suffix.lower() not in {'.png', '.jpg', '.jpeg'}:
            fail('UNSUPPORTED_IMAGE', 'Only PNG and JPEG are supported: ' + rel)
        with p.open('rb') as source:
            raw = source.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            fail('IMAGE_TOO_LARGE', 'Image exceeds 32 MiB: ' + rel)
        result.append(prepare_image(raw, p.suffix, rel, index + 1))
    return {'images': result}


def prepare_image(raw, suffix, rel, index):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        fail('IMAGE_DEPENDENCY_MISSING', 'Install Pillow in the configured Bridge Python environment.')
    if len(raw) > 32 * 1024 * 1024:
        fail('IMAGE_TOO_LARGE', 'Image exceeds 32 MiB: ' + rel)
    if suffix.lower() not in {'.png', '.jpg', '.jpeg'}:
        fail('UNSUPPORTED_IMAGE', 'Only PNG and JPEG are supported: ' + rel)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                expected = 'PNG' if suffix.lower() == '.png' else 'JPEG'
                if source.format != expected or getattr(source, 'n_frames', 1) != 1:
                    fail('UNSUPPORTED_IMAGE', 'File must be a single PNG or JPEG matching its extension: ' + rel)
                original_size = source.size
                if source.width * source.height > 40_000_000:
                    fail('IMAGE_TOO_LARGE', 'Image exceeds 40 million pixels: ' + rel)
                source.load()
                rotated = source.getexif().get(274, 1) != 1
                image = ImageOps.exif_transpose(source)
                image.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
                resized = image.size != original_size and not (rotated and image.size == original_size[::-1])
                output = raw
                recompressed = False
                if resized or rotated or len(raw) > 768 * 1024:
                    for attempt in range(10):
                        stream = io.BytesIO()
                        if expected == 'JPEG':
                            image.convert('RGB').save(stream, format='JPEG', quality=85, optimize=True)
                        else:
                            image.save(stream, format='PNG', optimize=True)
                        output = stream.getvalue()
                        if len(output) <= 768 * 1024:
                            break
                        image = image.resize((max(1, int(image.width * .75)), max(1, int(image.height * .75))), Image.Resampling.LANCZOS)
                        resized = True
                    recompressed = True
                if len(output) > 768 * 1024:
                    fail('IMAGE_TOO_LARGE', 'Prepared image exceeds transport limit: ' + rel)
                return {'index': index, 'path': rel, 'mime_type': 'image/png' if expected == 'PNG' else 'image/jpeg',
                    'source_bytes': len(raw), 'bytes': len(output), 'source_sha256': digest(raw), 'sha256': digest(output),
                    'original_width': original_size[0], 'original_height': original_size[1], 'width': image.width, 'height': image.height,
                    'resized': resized, 'orientation_corrected': rotated, 'recompressed': recompressed,
                    'base64': base64.b64encode(output).decode('ascii')}
    except Exception as error:
        if hasattr(error, 'code'):
            raise
        fail('INVALID_IMAGE', 'Cannot decode image safely: ' + rel)
