/**
 * mediasoup Worker pool manager.
 *
 * Spawns N Workers (one per CPU core by default) and assigns routers
 * to them via round-robin. Workers run as separate C++ processes
 * managed by mediasoup.
 *
 * On worker death:
 * - Clean exit (code:0, signal:null) — IPC lost, respawn the worker.
 * - Crash (code≠0 or signal≠null) — log and shrink the pool, no respawn.
 * - Rate limit: max {@link RESPAWN_RATE_LIMIT} respawns per slot within
 *   {@link RESPAWN_WINDOW_MS}. If exceeded, give up on that slot.
 *
 * @module server/sfu/worker-manager
 */

import { cpus } from 'node:os';
import { createWorker } from 'mediasoup';
import type { types as mediasoupTypes } from 'mediasoup';
import type { WorkerManager } from './types';

/** Maximum number of respawns allowed per slot within the rate window. */
const RESPAWN_RATE_LIMIT = 3;

/** Time window (ms) for counting respawn attempts per slot. */
const RESPAWN_WINDOW_MS = 60_000;

/** Tracks one worker position in the pool. */
interface WorkerSlot {
  /** The live worker, or `null` if dead/respawning. */
  worker: mediasoupTypes.Worker | null;
  /** Timestamps of recent respawn attempts (pruned to {@link RESPAWN_WINDOW_MS}). */
  respawnTimestamps: number[];
}

/**
 * Parsed exit information from a mediasoup worker `died` event error.
 *
 * mediasoup formats it as `[pid:NUM, code:NUM|null, signal:STRING|null]`
 * (see mediasoup `Worker.js` line 146).
 */
interface DiedInfo {
  code: number | null;
  signal: string | null;
}

/**
 * Parse code and signal from the mediasoup `died` event error message.
 *
 * @param message - Error message in the format `[pid:NUM, code:NUM, signal:STRING]`.
 * @returns Parsed code and signal. Returns `{ code: null, signal: null }` for
 *          malformed messages — treated as a crash (no respawn).
 */
export function parseDiedError(message: string): DiedInfo {
  const codeMatch = /code:(\d+|null)/.exec(message);
  const signalMatch = /signal:(\w+|null)/.exec(message);

  const code = !codeMatch || codeMatch[1] === 'null' ? null : Number(codeMatch[1]);
  const signal = !signalMatch || signalMatch[1] === 'null' ? null : signalMatch[1]!;

  return { code, signal };
}

/**
 * Create and initialize a Worker pool.
 *
 * @param workerBinPath - Absolute path to the mediasoup-worker binary.
 * @param numWorkers - Number of workers to spawn. Defaults to CPU core count (capped at 8).
 * @param respawnWindowMs - Time window for rate-limiting respawns per slot. Defaults to {@link RESPAWN_WINDOW_MS}.
 * @throws If any worker fails to spawn during initial creation.
 */
export async function createWorkerManager(
  workerBinPath: string,
  numWorkers?: number,
  respawnWindowMs?: number,
): Promise<WorkerManager> {
  const count = numWorkers ?? Math.min(cpus().length, 8);
  const windowMs = respawnWindowMs ?? RESPAWN_WINDOW_MS;
  if (count < 1) {
    throw new Error(`[SFU:WorkerManager] numWorkers must be >= 1, got ${count}`);
  }

  console.log(`[SFU:WorkerManager] Spawning ${count} mediasoup worker(s)...`);

  const slots: WorkerSlot[] = [];
  let closed = false;
  let nextIndex = 0;

  /**
   * Wire a `died` handler on a worker that routes to respawn or pool-shrink
   * depending on exit code/signal.
   */
  function attachDiedHandler(worker: mediasoupTypes.Worker, slotIndex: number): void {
    worker.on('died', (error: Error) => {
      const { code, signal } = parseDiedError(error.message);
      const slot = slots[slotIndex]!;
      slot.worker = null;

      if (code === 0 && signal === null) {
        console.warn(
          `[SFU:WorkerManager] Worker ${worker.pid} (slot ${slotIndex}) exited cleanly ` +
            `(code:0, signal:null) — IPC lost, attempting respawn...`,
        );
        void respawnWorker(slotIndex);
      } else {
        console.error(
          `[SFU:WorkerManager] Worker ${worker.pid} (slot ${slotIndex}) crashed ` +
            `(code:${code}, signal:${signal}) — removing from pool`,
        );
      }
    });
  }

  /**
   * Attempt to respawn a worker in the given slot.
   *
   * Applies rate limiting: if the slot has had {@link RESPAWN_RATE_LIMIT}
   * respawns within the last {@link RESPAWN_WINDOW_MS}, the attempt is
   * abandoned and the slot stays empty.
   */
  async function respawnWorker(slotIndex: number): Promise<void> {
    const slot = slots[slotIndex]!;

    if (closed) {
      console.log(
        `[SFU:WorkerManager] Respawn cancelled for slot ${slotIndex} — manager is closed`,
      );
      return;
    }

    // Rate limit check — prune old timestamps, then check count
    const now = Date.now();
    slot.respawnTimestamps = slot.respawnTimestamps.filter((t) => now - t < windowMs);
    if (slot.respawnTimestamps.length >= RESPAWN_RATE_LIMIT) {
      console.error(
        `[SFU:WorkerManager] Respawn rate limit exceeded for slot ${slotIndex} ` +
          `(${RESPAWN_RATE_LIMIT} in ${windowMs / 1000}s) — giving up`,
      );
      return;
    }

    slot.respawnTimestamps.push(now);

    try {
      const newWorker = await createWorker({
        logLevel: 'warn',
        workerBin: workerBinPath,
      });

      // Manager may have been closed while we were awaiting createWorker
      if (closed) {
        newWorker.close();
        console.log(
          `[SFU:WorkerManager] Respawn completed for slot ${slotIndex} but manager closed — closing new worker`,
        );
        return;
      }

      attachDiedHandler(newWorker, slotIndex);
      slot.worker = newWorker;
      console.log(
        `[SFU:WorkerManager] Worker respawned in slot ${slotIndex} (pid ${newWorker.pid})`,
      );
    } catch (err) {
      console.error(
        `[SFU:WorkerManager] Failed to respawn worker for slot ${slotIndex}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Spawn initial workers
  for (let i = 0; i < count; i++) {
    const worker = await createWorker({
      logLevel: 'warn',
      workerBin: workerBinPath,
    });

    attachDiedHandler(worker, i);

    slots.push({ worker, respawnTimestamps: [] });
    console.log(`[SFU:WorkerManager] Worker ${i + 1}/${count} ready (pid ${worker.pid})`);
  }

  /**
   * Get the next healthy worker via round-robin, skipping dead/respawning slots.
   *
   * @throws If no healthy workers are available (all dead or pool was closed).
   */
  function getNextWorker(): mediasoupTypes.Worker {
    if (closed) {
      throw new Error('[SFU:WorkerManager] No workers available — pool was closed');
    }

    const slotCount = slots.length;
    for (let attempt = 0; attempt < slotCount; attempt++) {
      const index = nextIndex % slotCount;
      nextIndex = (nextIndex + 1) % slotCount;
      const worker = slots[index]!.worker;
      if (worker !== null) {
        return worker;
      }
    }

    throw new Error(
      '[SFU:WorkerManager] No workers available — all workers are dead or respawning',
    );
  }

  /** Shut down all workers and prevent further respawns. */
  function close(): void {
    if (closed) return;
    closed = true;
    const aliveCount = slots.filter((s) => s.worker !== null).length;
    console.log(`[SFU:WorkerManager] Closing ${aliveCount} worker(s)...`);
    for (const slot of slots) {
      if (slot.worker) {
        slot.worker.close();
        slot.worker = null;
      }
    }
  }

  return {
    getNextWorker,
    get workerCount() {
      return slots.filter((s) => s.worker !== null).length;
    },
    close,
  };
}
