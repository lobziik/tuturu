/**
 * mediasoup Worker pool manager.
 *
 * Spawns N Workers (one per CPU core by default) and assigns routers
 * to them via round-robin. Workers run as separate C++ processes
 * managed by mediasoup.
 *
 * @module server/sfu/worker-manager
 */

import { cpus } from 'node:os';
import { createWorker } from 'mediasoup';
import type { types as mediasoupTypes } from 'mediasoup';
import type { WorkerManager } from './types';

/**
 * Create and initialize a Worker pool.
 *
 * @param workerBinPath - Absolute path to the mediasoup-worker binary.
 * @param numWorkers - Number of workers to spawn. Defaults to CPU core count (capped at 8).
 * @throws If any worker fails to spawn.
 */
export async function createWorkerManager(
  workerBinPath: string,
  numWorkers?: number,
): Promise<WorkerManager> {
  const count = numWorkers ?? Math.min(cpus().length, 8);
  if (count < 1) {
    throw new Error(`[SFU:WorkerManager] numWorkers must be >= 1, got ${count}`);
  }

  console.log(`[SFU:WorkerManager] Spawning ${count} mediasoup worker(s)...`);

  const workers: mediasoupTypes.Worker[] = [];

  for (let i = 0; i < count; i++) {
    const worker = await createWorker({
      logLevel: 'warn',
      workerBin: workerBinPath,
    });

    worker.on('died', (error) => {
      console.error(`[SFU:WorkerManager] Worker ${worker.pid} died unexpectedly: ${error.message}`);
      throw new Error(
        `[SFU:WorkerManager] mediasoup Worker died (pid ${worker.pid}): ${error.message}`,
      );
    });

    workers.push(worker);
    console.log(`[SFU:WorkerManager] Worker ${i + 1}/${count} ready (pid ${worker.pid})`);
  }

  let nextIndex = 0;

  function getNextWorker(): mediasoupTypes.Worker {
    if (workers.length === 0) {
      throw new Error('[SFU:WorkerManager] No workers available — pool was closed');
    }
    const worker = workers[nextIndex % workers.length]!;
    nextIndex = (nextIndex + 1) % workers.length;
    return worker;
  }

  function close(): void {
    console.log(`[SFU:WorkerManager] Closing ${workers.length} worker(s)...`);
    for (const worker of workers) {
      worker.close();
    }
    workers.length = 0;
  }

  return {
    getNextWorker,
    get workerCount() {
      return workers.length;
    },
    close,
  };
}
