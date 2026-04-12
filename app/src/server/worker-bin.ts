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

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { BunFile } from 'bun';

/**
 * Embedded worker binary.
 * - Dev mode: resolves to the string path of `src/server/mediasoup-worker`
 * - Compiled mode: resolves to the auto-extracted temp file (string path or BunFile)
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

/** Target filename for the extracted worker binary. */
const EXTRACTED_WORKER_NAME = 'mediasoup-worker';

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
 * Handles both dev mode (string path) and compiled mode (BunFile or string).
 */
async function readEmbeddedContent(file: string | BunFile | Blob): Promise<Buffer> {
  if (typeof file === 'string') {
    return Buffer.from(await Bun.file(file).arrayBuffer());
  }
  return Buffer.from(await file.arrayBuffer());
}

/**
 * Result of worker binary resolution.
 * `extracted` is true when the binary was written to disk (first run or hash change).
 */
interface WorkerBinResult {
  /** Absolute path to the worker binary. */
  path: string;
  /** Whether the binary was freshly extracted (new or hash changed). */
  extracted: boolean;
}

/**
 * Extract a worker binary to a specified directory with hash-based change detection.
 *
 * Uses a sidecar `.hash` file to avoid re-reading the full binary on every restart.
 * Non-cryptographic hash (xxHash via Bun.hash) — sufficient for detecting binary changes
 * between deploys, NOT for supply-chain integrity verification.
 *
 * Exported for testability — `resolveWorkerBin` delegates to this in compiled mode.
 *
 * @param embeddedContent Raw binary content to extract.
 * @param extractDir Directory to write the worker binary into.
 * @returns Resolution result with path and extraction status.
 */
export async function extractWorkerBin(
  embeddedContent: Uint8Array,
  extractDir: string,
): Promise<WorkerBinResult> {
  if (!existsSync(extractDir)) {
    mkdirSync(extractDir, { recursive: true });
  }

  const extractPath = join(extractDir, EXTRACTED_WORKER_NAME);
  const hashPath = extractPath + '.hash';

  const embeddedHash = Bun.hash(embeddedContent).toString(16);

  // Check sidecar hash file — avoids re-reading the full ~5MB binary on every restart.
  if (existsSync(extractPath) && existsSync(hashPath)) {
    const savedHash = readFileSync(hashPath, 'utf8').trim();

    if (savedHash === embeddedHash) {
      console.log(`[WORKER] Extracted worker up-to-date at ${extractPath}`);
      return { path: extractPath, extracted: false };
    }

    console.log(`[WORKER] Embedded worker changed (${savedHash} → ${embeddedHash}), overwriting`);
  }

  // Write the binary, sidecar hash, and set executable permission.
  writeFileSync(extractPath, embeddedContent);
  writeFileSync(hashPath, embeddedHash);
  chmodSync(extractPath, 0o755);

  console.log(`[WORKER] Extracted worker to ${extractPath} (hash: ${embeddedHash})`);
  return { path: extractPath, extracted: true };
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

  const embeddedContent = await readEmbeddedContent(workerBinFile as string | BunFile | Blob);
  return extractWorkerBin(embeddedContent, dir);
}
