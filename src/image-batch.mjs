import { invoke } from './bridge.mjs';

// Prepare all sources before creating a delivery; never publish a partial batch.
export async function prepareImageBatch(args, config, prepare = invoke) {
  const mixed = args.sources !== undefined;
  if (mixed && (args.paths !== undefined || args.project_id !== undefined)) throw new Error('INVALID_INPUT: Use sources OR project_id/paths, not both.');
  const sources = mixed ? args.sources : args.paths?.map(path => ({ project_id: args.project_id, path }));
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4) throw new Error('INVALID_INPUT: Supply 1 to 4 images total.');
  const seen = new Set();
  for (const source of sources) {
    if (!source || typeof source.path !== 'string' || !source.path.trim()) throw new Error('INVALID_INPUT: Missing image path.');
    if (source.project_id !== undefined && !config.projects.some(p => p.id === source.project_id)) throw new Error('UNAUTHORIZED: unknown project_id');
    const key = JSON.stringify([source.project_id ?? null, source.path]);
    if (seen.has(key)) throw new Error('INVALID_INPUT: Duplicate image source.');
    seen.add(key);
  }
  const images = [];
  for (const source of sources) {
    const result = await prepare('prepare_images', { project_id: source.project_id, paths: [source.path] }, config);
    if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
    if (result.result.images.length !== 1) throw new Error('IMAGE_COUNT_MISMATCH');
    images.push({ ...result.result.images[0], index: images.length + 1, project_id: source.project_id, source_target: result.target });
  }
  return images;
}
