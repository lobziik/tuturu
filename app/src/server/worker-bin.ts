/**
 * mediasoup worker binary resolution.
 *
 * In compiled mode: extracts the embedded binary to disk, returns its path.
 * In dev mode: returns the node_modules path directly (no embed/extract needed).
 *
 * The binary is embedded at compile time via `import with { type: 'file' }`.
 * At runtime in compiled mode, Bun auto-extracts it to a temp location —
 * we re-extract to a stable path with executable permissions and change detection.
 *
 * ## Build note (worker:build script)
 *
 * The `worker:build` script in package.json sets PYTHONPATH as a shell env var:
 *
 *     PYTHONPATH="$PWD/worker/pip_invoke..." bun npm-scripts.mjs worker:build
 *
 * This is a workaround for Bun's `execSync` not inheriting `process.env` mutations
 * (unlike Node.js). mediasoup's npm-scripts.mjs sets PYTHONPATH via `process.env`
 * before calling `execSync('python3 -m invoke ...')`, but the child process never
 * sees it under Bun. Setting it as a shell env var ensures it propagates.
 * If mediasoup changes its build internals, this workaround may need updating.
 *
 * @module server/worker-bin
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractWorkerBin, type WorkerBinResult } from './worker-extract';

/**
 * Embedded worker binary.
 * - Dev mode: resolves to the string path of `src/server/mediasoup-worker`
 * - Compiled mode: resolves to the auto-extracted temp file (`/$bunfs/...` string path)
 *
 * The file must exist at `src/server/mediasoup-worker` before `bun build --compile`.
 * Run `bun run worker:copy` to place it there.
 */
import workerBinFile from './mediasoup-worker' with { type: 'file' };

/** Path to the worker binary inside node_modules (for dev mode). */
const NODE_MODULES_WORKER_PATH = resolve(
  import.meta.dir,
  '../../node_modules/mediasoup/worker/out/Release/mediasoup-worker',
);

/**
 * Default directory for extracted worker in production.
 * Separate from app data (/var/lib/tuturu) to avoid mixing with runtime state.
 */
const DEFAULT_EXTRACT_DIR = '/tmp/tuturu';

/**
 * Check if running as a compiled Bun executable.
 * In compiled mode, Bun resolves embedded file imports to paths starting with `/$bunfs/`.
 */
function isCompiled(): boolean {
  return typeof workerBinFile === 'string' && workerBinFile.startsWith('/$bunfs/');
}

/**
 * Read the content of the embedded worker binary.
 * `import with { type: 'file' }` always returns a string path — both in dev and compiled mode.
 */
async function readEmbeddedContent(filePath: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(filePath).arrayBuffer());
}

/**
 * Resolve the mediasoup-worker binary path.
 *
 * - **Dev mode**: returns the binary from `node_modules/mediasoup/worker/out/Release/`.
 * - **Compiled mode**: extracts the embedded binary to `<extractDir>/mediasoup-worker`,
 *   checks hash (overwrites if changed), sets executable permission, returns path.
 *
 * Extract directory priority: `TUTURU_WORKER_DIR` env var > `extractDir` param > `/tmp/tuturu`.
 *
 * @param extractDir Directory to extract the worker binary into (compiled mode only).
 * @throws If the worker binary is not found (dev mode) or extraction fails (compiled mode).
 */
export async function resolveWorkerBin(extractDir?: string): Promise<WorkerBinResult> {
  if (!isCompiled()) {
    if (!existsSync(NODE_MODULES_WORKER_PATH)) {
      throw new Error(
        `[WORKER] mediasoup-worker binary not found at ${NODE_MODULES_WORKER_PATH}. ` +
          `Run 'bun run worker:build' or 'bun install' first.`,
      );
    }

    console.log(`[WORKER] Dev mode — using worker at ${NODE_MODULES_WORKER_PATH}`);
    return { path: NODE_MODULES_WORKER_PATH, extracted: false };
  }

  // Compiled mode: extract the embedded binary to a stable location.
  const dir = process.env.TUTURU_WORKER_DIR ?? extractDir ?? DEFAULT_EXTRACT_DIR;

  const embeddedContent = await readEmbeddedContent(workerBinFile);
  return extractWorkerBin(embeddedContent, dir);
}
