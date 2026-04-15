/**
 * mediasoup worker binary resolution.
 *
 * In compiled mode: extracts the embedded binary to disk, returns its path.
 * In dev mode: returns the local copy directly (placed by `worker:copy`).
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

import { extractWorkerBin, type WorkerBinResult } from './worker-extract';

/**
 * Embedded worker binary.
 * - Dev mode: resolves to the local copy at `src/server/mediasoup-worker`
 * - Compiled mode: resolves to the auto-extracted temp file (`/$bunfs/...` string path)
 *
 * The file must exist at `src/server/mediasoup-worker` for the import to resolve.
 * Run `bun run worker:copy` to place it there.
 */
import workerBinFile from './mediasoup-worker' with { type: 'file' };

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
 * - **Dev mode**: returns the local copy at `src/server/mediasoup-worker`
 *   (placed by `bun run worker:copy`, required for the file import to resolve).
 * - **Compiled mode**: extracts the embedded binary to `<extractDir>/mediasoup-worker`,
 *   checks hash (overwrites if changed), sets executable permission, returns path.
 *
 * Extract directory priority: `TUTURU_WORKER_DIR` env var > `extractDir` param > `/tmp/tuturu`.
 *
 * @param extractDir - Directory to extract the worker binary into (compiled mode only).
 * @throws If extraction fails (compiled mode).
 */
export async function resolveWorkerBin(extractDir?: string): Promise<WorkerBinResult> {
  if (!isCompiled()) {
    console.log(`[WORKER] Dev mode — using local worker copy at ${workerBinFile}`);
    return { path: workerBinFile, extracted: false };
  }

  // Compiled mode: extract the embedded binary to a stable location.
  const dir = process.env.TUTURU_WORKER_DIR ?? extractDir ?? DEFAULT_EXTRACT_DIR;

  const embeddedContent = await readEmbeddedContent(workerBinFile);
  return extractWorkerBin(embeddedContent, dir);
}
