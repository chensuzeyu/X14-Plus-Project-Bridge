import { readFile, writeFile, mkdir, open, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { config } from './bridge.mjs';
import { prepareImageBatch } from './image-batch.mjs';

export const imageViewerUri = 'ui://x14/project-images-v7.html';
const identity = z.string().uuid();
export function registerProjectImages(server, suppliedConfig) {
  const getConfig = async () => suppliedConfig || await config();
  server.registerResource('project-images', imageViewerUri, { mimeType: 'text/html;profile=mcp-app' }, async () => {
    const [html, js] = await Promise.all([readFile(new URL('./ui/project-images.html', import.meta.url), 'utf8'), readFile(new URL('./ui/project-images.js', import.meta.url), 'utf8')]);
    return { contents: [{ uri: imageViewerUri, mimeType: 'text/html;profile=mcp-app', text: html.replace('/* INLINE_SCRIPT */', js), _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
      'openai/widgetDescription': 'Automatically prepares local or SSH project images for the next model turn. Initially say only that images are being prepared; inspect images and continue the original authorized task after the automatic follow-up. Do not report a vision failure while preparation is pending.'
    } }] };
  });
  server.registerTool('view_project_images', {
    title: '查看图片',
    description: 'View 1–4 PNG/JPEG images using ChatGPT vision. Local absolute paths need no project_id; local relative paths require project_id. SSH images require an SSH project_id and a relative or absolute path inside that project. Find local images with discover_local_images; find SSH images with list_files. Source limits: 32 MiB and 40 million pixels per image; delivery optimized to 2560px / 768 KiB. Resolve document-relative references against the source document directory and retain its host/project. Never substitute a same-named file on another host. For multiple required images, prefer ONE sources batch (1–4 total), including mixed local and SSH projects, so all images reach the same follow-up. Each sources entry has path and optional project_id. Never combine sources with legacy paths/project_id. Legacy paths/project_id remains supported. Resolve all required sources before requesting a batch; wait for the automatic follow-up before writing conclusions. Pass original goal, established findings, remaining evidence, authorized output paths and verification requirements. Initially say preparing; after automatic follow-up inspect images and resume the task. Do not repeat pending requests. Network drives are not supported. SSH files are read over the configured connection and prepared locally.',
    inputSchema: { project_id: z.string().max(100).optional(), paths: z.array(z.string().min(1).max(1000)).min(1).max(4).optional(), sources: z.array(z.object({ project_id: z.string().min(1).max(100).optional(), path: z.string().min(1).max(1000) })).min(1).max(4).optional(), question: z.string().min(1).max(6000) },
    outputSchema: { run_id: identity.optional(), status: z.enum(['waiting_for_widget', 'error']), error: z.string().optional(), project_id: z.string().optional(), source_target: z.string().optional(), question: z.string().optional(), images: z.array(z.object({ index: z.number(), project_id: z.string().optional(), source_target: z.string().optional(), path: z.string(), mime_type: z.string(), source_bytes: z.number(), bytes: z.number(), source_sha256: z.string(), sha256: z.string(), original_width: z.number(), original_height: z.number(), width: z.number(), height: z.number(), resized: z.boolean(), orientation_corrected: z.boolean(), recompressed: z.boolean() })).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: imageViewerUri }, 'openai/outputTemplate': imageViewerUri, 'openai/toolInvocation/invoking': '正在读取项目图片', 'openai/toolInvocation/invoked': '正在准备图片，稍后自动分析' }
  }, async args => {
    try {
      const c = await getConfig();
      const prepared = await prepareImageBatch(args, c);
      const run_id = randomUUID(), token = randomUUID();
      const images = prepared.map(({ base64, ...info }) => info);
      const folder = path.join(c.state, 'image-deliveries');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, run_id + '.json'), JSON.stringify({ token, created_at: Date.now(), images }), { flag: 'wx' });
      await appendFile(path.join(folder, run_id + '.events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'prepared', expected_images: images.length }) + '\n');
      const data = { run_id, status: 'waiting_for_widget', project_id: args.project_id, source_target: args.sources ? 'mixed' : images[0].source_target, question: args.question, images };
      return { content: [{ type: 'text', text: '正在准备图片，稍后自动分析。请等待卡片自动发起后续回答，不要重复调用。' }], structuredContent: data,
        _meta: { 'x14/images': { token, base64: prepared.map(i => i.base64) } }, isError: false };
    } catch (error) { return { content: [{ type: 'text', text: String(error.message) }], structuredContent: { status: 'error', error: String(error.message) }, isError: true }; }
  });
  // Only the UI receives the per-run token. Exclusive creation also works across processes.
  server.registerTool('claim_image_delivery', {
    title: '图片提交去重（内部）', description: 'Widget-only one-time claim before uploading a prepared image batch, or authenticated delivery-stage telemetry. Telemetry never grants an upload claim and does not prove model vision. Not a user-facing image reader.',
    inputSchema: { run_id: identity, token: identity, event: z.enum(['upload_started', 'upload_complete', 'references_set', 'followup_requested', 'followup_accepted', 'stopped']).optional(), uploaded_count: z.number().int().min(0).max(4).optional() }, outputSchema: { granted: z.boolean(), reason: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true }
  }, async ({ run_id, token, event, uploaded_count }) => {
    const c = await getConfig(), folder = path.join(c.state, 'image-deliveries');
    let data;
    try {
      const record = JSON.parse(await readFile(path.join(folder, run_id + '.json'), 'utf8'));
      if (record.token !== token || Date.now() - record.created_at > 86400000) throw new Error('invalid');
      if (event) {
        await readFile(path.join(folder, run_id + '.claimed'));
        await appendFile(path.join(folder, run_id + '.events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, uploaded_count: uploaded_count ?? 0, expected_images: record.images?.length }) + '\n');
        return { content: [{ type: 'text', text: 'recorded' }], structuredContent: { granted: false, reason: 'event_recorded' } };
      }
      try { const handle = await open(path.join(folder, run_id + '.claimed'), 'wx'); await handle.close(); data = { granted: true, reason: 'claimed' }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; data = { granted: false, reason: 'already_claimed; do not upload or send another follow-up' }; }
    } catch { data = { granted: false, reason: 'invalid_or_expired_delivery' }; }
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  });
}
