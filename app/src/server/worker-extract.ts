/**
 * Worker binary extraction with hash-based change detection.
 *
 * Separated from `worker-bin.ts` so this logic can be tested without
 * triggering the `import ... with { type: 'file' }` side effect
 * (which requires the embedded binary to exist on disk).
 *
 * @module server/worker-extract
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Target filename for the extracted worker binary. */
const EXTRACTED_WORKER_NAME = 'mediasoup-worker';

/**
 * Result of worker binary resolution.
 * `extracted` is true when the binary was written to disk (first run or hash change).
 */
export interface WorkerBinResult {
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
