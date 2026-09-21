import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execute, quotePosix, root } from './bridge.mjs';

// Raw sources travel one at a time. Only optimized image bytes reach the widget.
export async function prepareRemoteImages(project, args, c) {
  if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 4 || new Set(args.paths).size !== args.paths.length) {
    throw new Error('INVALID_INPUT: Supply 1 to 4 distinct image paths.');
  }
  const reader = await readFile(new URL('./remote_image_source.py', import.meta.url), 'utf8');
  const images = [];
  for (const supplied of args.paths) {
    const request = { project, state: project.state, args: { path: supplied } };
    const output = await execute(c.ssh || 'ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ClearAllForwardings=yes', project.host,
      `${quotePosix(project.python || 'python3')} -c ${quotePosix(reader)}`], JSON.stringify(request), 90000, 46_000_000);
    const source = JSON.parse(output);
    if (!source.ok) throw new Error(source.error.code + ': ' + source.error.message);
    const script = "import sys,json,base64\nsys.path.insert(0,sys.argv[1])\nfrom project_images import prepare_image\ntry:\n v=json.load(sys.stdin)\n print(json.dumps({'ok':True,'result':prepare_image(base64.b64decode(v['base64'],validate=True),v['suffix'],v['path'],v['index'])}))\nexcept Exception as e:\n print(json.dumps({'ok':False,'error':{'code':getattr(e,'code','INVALID_IMAGE'),'message':str(e)}}))";
    const prepared = await execute(c.python, ['-c', script, path.join(root, 'src')], JSON.stringify({ ...source.result, index: images.length + 1 }));
    const image = JSON.parse(prepared);
    if (!image.ok) throw new Error(image.error.code + ': ' + image.error.message);
    images.push(image.result);
  }
  return { images };
}
