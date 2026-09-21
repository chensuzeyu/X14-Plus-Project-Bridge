import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './bridge.mjs';

export function registerVisionProbe(server, suppliedConfig) {
  server.registerTool('vision_probe', {
    description: 'Read-only visual capability experiment. Returns an actual PNG image content block for fixed synthetic sample a or b; missing is an intentional no-image control. Describe only pixels you actually receive. No project lookup, file reading, command execution, OCR or external URL is needed.',
    inputSchema: { sample_id: z.enum(['a', 'b', 'missing']) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ sample_id }) => {
    if (sample_id === 'missing') return { isError: true, content: [{ type: 'text', text: 'CONTROL_NO_IMAGE: no image was supplied for this sample.' }] };
    try {
      const c = suppliedConfig || await config();
      const bytes = await readFile(path.join(c.state, 'vision-probe', sample_id + '.png'));
      if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('INVALID_FIXTURE');
      return { isError: false, content: [
        { type: 'text', text: JSON.stringify({ sample_id, mime_type: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) },
        { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
      ] };
    } catch { return { isError: true, content: [{ type: 'text', text: 'FIXTURE_UNAVAILABLE: local test fixture has not been prepared or is invalid.' }] }; }
  });
}
