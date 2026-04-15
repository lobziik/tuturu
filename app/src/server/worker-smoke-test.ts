/**
 * mediasoup worker binary smoke test.
 *
 * Validates that the extracted worker binary is functional by exercising
 * the full mediasoup chain: spawn worker → create router → create
 * WebRtcTransport → close everything.
 *
 * Run once after binary extraction (or when TUTURU_SMOKE_TEST=1).
 * Throws on failure — prevents SFU initialization if the binary is broken.
 * Does NOT affect runtime worker-death handling (see worker-manager.ts).
 *
 * @module server/worker-smoke-test
 */

import { createWorker } from 'mediasoup';
import type { types as mediasoupTypes } from 'mediasoup';

/** Minimal media codecs for smoke test — opus audio only. */
const SMOKE_TEST_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
];

/**
 * Run a smoke test of the mediasoup worker binary.
 *
 * Creates worker → router → WebRtcTransport → closes everything.
 * Throws on failure — SFU should not initialize if the binary is broken.
 *
 * @param workerBin - Absolute path to the mediasoup-worker binary.
 */
export async function smokeTestWorker(workerBin: string): Promise<void> {
  console.log('[WORKER] Running smoke test...');
  const startMs = performance.now();

  const worker = await createWorker({
    logLevel: 'warn',
    workerBin,
  });

  const router = await worker.createRouter({
    mediaCodecs: SMOKE_TEST_CODECS,
  });

  const transport = await router.createWebRtcTransport({
    listenInfos: [{ protocol: 'udp' as const, ip: '127.0.0.1' }],
  });

  transport.close();
  router.close();
  worker.close();

  const elapsedMs = (performance.now() - startMs).toFixed(0);
  console.log(`[WORKER] Smoke test passed in ${elapsedMs}ms (worker pid was ${worker.pid})`);
}
