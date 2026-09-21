import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './bridge.mjs';

export const widgetUri = 'ui://x14/vision-probe-v1.html';
export function registerVisionWidgetProbe(server, suppliedConfig) {
  server.registerResource('vision-widget-probe', widgetUri, { mimeType: 'text/html;profile=mcp-app' }, async () => {
    const [html, script] = await Promise.all([
      readFile(new URL('./ui/vision-probe.html', import.meta.url), 'utf8'),
      readFile(new URL('./ui/vision-probe.js', import.meta.url), 'utf8')
    ]);
    return { contents: [{ uri: widgetUri, mimeType: 'text/html;profile=mcp-app', text: html.replace('/* INLINE_SCRIPT */', script),
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/widgetDescription': 'Local-image experiment status. The card automatically attempts ChatGPT file registration and image references. Upload success is not proof of model vision.',
        'openai/widgetPrefersBorder': true, 'openai/widgetCSP': { connect_domains: [], resource_domains: [] } } }] };
  });
  server.registerTool('vision_widget_probe', {
    title: '本地图片自动识图实验',
    description: 'Read fixed synthetic local PNG a, b, c or d into an inline widget, which attempts uploadFile, imageIds and ONE follow-up. Call once per experiment. Do not call other tools or infer visual answers from metadata. missing is a no-image control. Registration does not prove vision. The widget needs to render in ChatGPT.',
    inputSchema: { sample_id: z.enum(['a', 'b', 'c', 'd', 'missing']), mode: z.enum(['auto', 'click']).default('auto'), publish_images: z.boolean().default(true) },
    outputSchema: { run_id: z.string(), sample_id: z.enum(['a', 'b', 'c', 'd', 'missing']), mode: z.enum(['auto', 'click']), publish_images: z.boolean(), ui_version: z.literal('v1'), status: z.enum(['ready', 'CONTROL_NO_IMAGE', 'FIXTURE_UNAVAILABLE']), mime_type: z.string().optional(), bytes: z.number().optional(), sha256: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri,
      'openai/toolInvocation/invoking': '准备本地识图实验', 'openai/toolInvocation/invoked': '请查看实验卡片状态' }
  }, async ({ sample_id, mode, publish_images }) => {
    const data = { run_id: randomUUID(), sample_id, mode, publish_images, ui_version: 'v1', status: 'CONTROL_NO_IMAGE' };
    let payload;
    if (sample_id !== 'missing') {
      try {
        const c = suppliedConfig || await config();
        const bytes = await readFile(path.join(c.state, 'vision-probe', sample_id + '.png'));
        if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('INVALID_FIXTURE');
        Object.assign(data, { status: 'ready', mime_type: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        payload = { base64: bytes.toString('base64') };
      } catch { data.status = 'FIXTURE_UNAVAILABLE'; }
    }
    // The negative control is a successful experimental result so its UI can clear imageIds.
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
      _meta: payload ? { 'x14/vision': payload } : {}, isError: data.status === 'FIXTURE_UNAVAILABLE' };
  });
}
