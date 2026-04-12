/**
 * mediasoup worker binary resolution.
 *
 * In compiled mode: extracts the embedded binary to disk, returns its path.
 * In dev mode: returns the node_modules path directly (no embed/extract needed).
 *
 * The binary is embedded at compile time via `import with { type: 'file' }`.
 * At runtime in compiled mode, Bun auto-extracts it to a temp location —
 * we re-extract to a stable path with executable permissions and hash verification.
 *
 * @module server/worker-bin
 */

import { existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
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
 * Resolve the mediasoup-worker binary path.
 *
 * - **Dev mode**: returns the binary from `node_modules/mediasoup/worker/out/Release/`.
 * - **Compiled mode**: extracts the embedded binary to `<extractDir>/mediasoup-worker`,
 *   verifies hash (overwrites if changed), sets executable permission, returns path.
 *
 * @param extractDir Directory to extract the worker binary into (compiled mode only).
 *   Defaults to the current working directory (which is `/var/lib/tuturu` under systemd).
 * @throws If the worker binary is not found (dev mode) or extraction fails (compiled mode).
 */
export async function resolveWorkerBin(extractDir?: string): Promise<string> {
  // Dev mode: use the binary from node_modules directly.
  // Detection: in dev mode, the import returns a string pointing inside src/server/.
  // In compiled mode, it points to Bun's internal extraction path.
  if (typeof workerBinFile === 'string' && workerBinFile.includes('src/server/')) {
    if (!existsSync(NODE_MODULES_WORKER_PATH)) {
      throw new Error(
        `[WORKER] mediasoup-worker binary not found at ${NODE_MODULES_WORKER_PATH}. ` +
          `Run 'bun run worker:build' or 'bun install' first.`,
      );
    }

    console.log(`[WORKER] Dev mode — using worker at ${NODE_MODULES_WORKER_PATH}`);
    return NODE_MODULES_WORKER_PATH;
  }

  // Compiled mode: extract the embedded binary to a stable location.
  const dir = extractDir ?? process.cwd();
  const extractPath = join(dir, EXTRACTED_WORKER_NAME);

  const embeddedContent = await readEmbeddedContent(workerBinFile as string | BunFile | Blob);
  const embeddedHash = Bun.hash(embeddedContent).toString(16);

  // Check if already extracted and matches hash.
  if (existsSync(extractPath)) {
    const existingContent = readFileSync(extractPath);
    const existingHash = Bun.hash(existingContent).toString(16);

    if (existingHash === embeddedHash) {
      console.log(`[WORKER] Extracted worker up-to-date at ${extractPath}`);
      return extractPath;
    }

    console.log(
      `[WORKER] Embedded worker changed (${existingHash} → ${embeddedHash}), overwriting`,
    );
  }

  // Write the binary and set executable permission.
  writeFileSync(extractPath, embeddedContent);
  chmodSync(extractPath, 0o755);

  console.log(`[WORKER] Extracted worker to ${extractPath} (hash: ${embeddedHash})`);
  return extractPath;
}
