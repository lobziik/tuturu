/**
 * E2EE transform setup — applies RTCRtpScriptTransform to senders/receivers.
 *
 * Uses the RTCRtpScriptTransform API (Encoded Transform) to set up per-frame
 * encryption on outgoing tracks and decryption on incoming tracks.
 * CryptoKey is structured-cloneable and passed via constructor options.
 *
 * @module client/e2ee/e2ee-transform
 */

/** Check if the browser supports Encoded Transforms (RTCRtpScriptTransform). */
export function isE2eeSupported(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/**
 * Create an E2EE Web Worker for frame-level encryption/decryption.
 * Returns null if E2EE is not supported.
 */
export function createE2eeWorker(): Worker | null {
  if (!isE2eeSupported()) {
    console.warn('[E2EE] RTCRtpScriptTransform not supported — E2EE disabled');
    return null;
  }

  const hash: string | undefined = (window as { __E2EE_WORKER_HASH__?: string })
    .__E2EE_WORKER_HASH__;
  const url = hash ? `/e2ee-worker.js?v=${hash}` : '/e2ee-worker.js';
  return new Worker(url, { type: 'module' });
}

/**
 * Apply encrypt transform to an RTCRtpSender.
 *
 * @param sender - The RTP sender (from a mediasoup Producer's rtpSender)
 * @param key - AES-GCM CryptoKey for encryption
 * @param worker - E2EE Web Worker instance
 */
export function setupSenderTransform(sender: RTCRtpSender, key: CryptoKey, worker: Worker): void {
  (sender as unknown as Record<string, unknown>).transform = new RTCRtpScriptTransform(worker, {
    operation: 'encrypt',
    key,
  });
  console.log('[E2EE] Encrypt transform applied to sender');
}

/**
 * Apply decrypt transform to an RTCRtpReceiver.
 *
 * @param receiver - The RTP receiver (from a mediasoup Consumer's rtpReceiver)
 * @param key - AES-GCM CryptoKey for decryption
 * @param worker - E2EE Web Worker instance
 */
export function setupReceiverTransform(
  receiver: RTCRtpReceiver,
  key: CryptoKey,
  worker: Worker,
): void {
  (receiver as unknown as Record<string, unknown>).transform = new RTCRtpScriptTransform(worker, {
    operation: 'decrypt',
    key,
  });
  console.log('[E2EE] Decrypt transform applied to receiver');
}
