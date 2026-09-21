import { z } from 'zod';
import { invoke } from './bridge.mjs';
import { registerVisionProbe } from './vision-probe.mjs';
import { registerVisionWidgetProbe } from './vision-widget-probe.mjs';
import { registerProjectImages } from './project-images.mjs';

const project = { project_id: z.string().max(100) };
const relative = z.string().max(1000).default('.');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const replacement = z.object({ old: z.string().min(1).max(200000), new: z.string().max(200000) });
const changes = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('write'), path: z.string(), expected_sha256: hash, content: z.string().max(1000000) }),
  z.object({ kind: z.literal('replace'), path: z.string(), expected_sha256: hash, replacements: z.array(replacement).min(1).max(50) }),
  z.object({ kind: z.literal('delete'), path: z.string(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
]);
const tools = [
  ['discover_local_images', 'Find local PNG/JPEG files anywhere on this computer. Omit path to list local drives and home. Supply absolute directory path to list subdirectories and images; optionally search recursively by filename. Results are bounded: when scan_truncated, narrow the directory. This does not inspect image content; pass returned absolute paths to view_project_images. No project_id required. Read-only; no network drives.', { path: z.string().max(1000).optional(), recursive: z.boolean().default(false), contains: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }, true],
  ['bridge_status', 'Identify this computer and bridge capabilities. Does not prove SSH or cloud connectivity.', {}, true],
  ['list_projects', 'List configured local and SSH projects and their capabilities. Use returned project_id for all subsequent operations.', {}, true],
  ['project_context', 'Start a project task here: bounded directory overview, README, applicable ancestor AGENTS.md, manifests and Git status. Not the whole project.', { ...project, path: relative }, true],
  ['list_files', 'List project-relative paths, excluding credentials, dependencies and links. Narrow path for large trees. Pagination is not a snapshot.', { ...project, path: relative, recursive: z.boolean().default(true), contains: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(200) }, true],
  ['search_project', 'Search literal text in UTF-8 project files. Returns matching lines. Batch matches by file; at most 100 matches per file. Use file_offset to continue.', { ...project, query: z.string().min(1).max(1000), path: relative, contains: z.string().max(200).default(''), case_sensitive: z.boolean().default(false), file_offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }, true],
  ['read_files', 'Batch read relevant UTF-8 file line ranges, returning hashes for conflict-safe editing. Lines are 1-based. Preserve exact newline sequences for replacements.', { ...project, files: z.array(z.object({ path: z.string().max(1000), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional() })).min(1).max(30), max_chars: z.number().int().min(1).max(120000).default(60000) }, true],
  ['apply_changes', 'Create, replace text, write or delete files. Read first and supply exact sha256 (null only for new files). Reuse operation_id after a network failure; never reuse for different changes. Each replacement must match once. Backups and diffs are recorded; batches are not filesystem transactions.', { ...project, operation_id: id, changes: z.array(changes).min(1).max(30) }, false],
  ['restore_change', 'Restore a recorded change only if files still match the post-change hashes. Creates a new change record. Later edits cause a conflict.', { ...project, change_id: id, operation_id: id }, false],
  ['git_inspect', 'Read Git status, diff stat, patch or recent log. No commit/push. Credential files can appear in tracked Git diffs; request only relevant project paths.', { ...project, path: relative, action: z.enum(['status', 'diff', 'patch', 'log']).default('status') }, true],
  ['start_job', 'Run a PowerShell (Windows) or bash (Linux) command in a configured project; returns job_id quickly. This grants service-account command capability, NOT a project sandbox. Use for tests/builds or explicitly requested host tasks. Environment does not inherit API keys. Set use_proxy for configured network route. Reuse operation_id for retries.', { ...project, operation_id: id, command: z.string().min(1).max(20000), cwd: relative, timeout_seconds: z.number().int().min(1).max(86400).default(600), use_proxy: z.boolean().default(false) }, false],
  ['get_job', 'Read persisted job state and incremental output. Continue with next_offset. A stale worker is reported unknown, never assumed successful.', { ...project, job_id: id, offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(100000).default(32000) }, true],
  ['cancel_job', 'Request cancellation of a Bridge-owned job. Confirm final state with get_job. Does not kill unrelated processes.', { ...project, job_id: id }, false]
];

export function registerTools(server, suppliedConfig) {
  if (suppliedConfig?.enable_vision_experiments === true) {
    registerVisionProbe(server, suppliedConfig);
    registerVisionWidgetProbe(server, suppliedConfig);
  }
  registerProjectImages(server, suppliedConfig);
  for (const [name, description, inputSchema, readOnly] of tools) {
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly || ['apply_changes', 'start_job', 'restore_change', 'cancel_job'].includes(name), openWorldHint: name === 'start_job' }
    }, async args => {
      try {
        const result = await invoke(name, args, suppliedConfig);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(error.message) }) }], isError: true };
      }
    });
  }
}
