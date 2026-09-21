"""Create synthetic blind-test fixtures. Answers stay in local state, never tool text."""
import hashlib
import json
import os
import secrets
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument('--additional', choices=['c', 'd'], help='Add one fresh blind control without replacing a/b.')
args = parser.parse_args()
cfg_path = Path(os.environ.get('X14_BRIDGE_CONFIG') or Path(os.environ['LOCALAPPDATA']) / 'X14-Plus-Project-Bridge' / 'config.json')
cfg = json.loads(cfg_path.read_text(encoding='utf-8-sig'))
folder = Path(cfg['state']) / 'vision-probe'
folder.mkdir(parents=True, exist_ok=True)
samples = [args.additional] if args.additional else ['a', 'b']
answers = json.loads((folder / 'answers.json').read_text(encoding='utf-8')) if args.additional else {}
if any((folder / (sample + '.png')).exists() or sample in answers for sample in samples) or (not args.additional and (folder / 'answers.json').exists()):
    raise SystemExit('Fixtures already exist. Keep them stable during the experiment; do not overwrite.')
rng = secrets.SystemRandom()
font = ImageFont.truetype(str(Path(os.environ['WINDIR']) / 'Fonts' / 'consolab.ttf'), 46)
small = ImageFont.truetype(str(Path(os.environ['WINDIR']) / 'Fonts' / 'consola.ttf'), 24)
palette = [('red', '#df3030'), ('blue', '#2166d1'), ('green', '#209447'), ('orange', '#f28a16'), ('purple', '#9236c6'), ('cyan', '#00aabb')]
for sample in samples:
    im = Image.new('RGB', (960, 640), 'white')
    draw = ImageDraw.Draw(im)
    code = ''.join(rng.choice('23456789ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(6))
    draw.text((35, 20), code, font=font, fill='black')
    colors = rng.sample(palette, 4)
    shapes = rng.sample(['circle', 'square', 'triangle', 'diamond'], 4)
    objects = []
    for i, ((color, rgb), shape) in enumerate(zip(colors, shapes)):
        row, col = divmod(i, 2)
        x, y = 260 + col * 440, 220 + row * 265
        draw.text((x - 150, y - 98), str(i + 1), font=small, fill='black')
        if shape == 'circle': draw.ellipse((x-65,y-65,x+65,y+65), fill=rgb)
        elif shape == 'square': draw.rectangle((x-65,y-65,x+65,y+65), fill=rgb)
        elif shape == 'triangle': draw.polygon([(x,y-70),(x-75,y+65),(x+75,y+65)], fill=rgb)
        else: draw.polygon([(x,y-75),(x+75,y),(x,y+75),(x-75,y)], fill=rgb)
        objects.append({'position': ['top-left', 'top-right', 'bottom-left', 'bottom-right'][i], 'color': color, 'shape': shape})
    image_path = folder / (sample + '.png')
    im.save(image_path)
    answers[sample] = {'code': code, 'objects': objects, 'sha256': hashlib.sha256(image_path.read_bytes()).hexdigest()}
(folder / 'answers.json').write_text(json.dumps(answers, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'prepared': samples, 'folder': str(folder), 'answers': 'Stored locally; not printed or exposed by vision tools.'}))
