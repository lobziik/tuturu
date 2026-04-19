/**
 * E2EE transform setup — applies RTCRtpScriptTransform to senders/receivers.
 *
 * Uses the RTCRtpScriptTransform API (Encoded Transform) to set up per-frame
 * encryption on outgoing tracks and decryption on incoming tracks.
 * CryptoKey is structured-cloneable and passed via constructor options.
 *
 * @module client/e2ee/e2ee-transform
 */

/**
 * Codec discriminator passed to the worker so it can pick the right number of
 * unencrypted header bytes per frame. Limited to what the SFU router actually
 * negotiates — see `app/src/server/sfu/codecs.ts`. Anything else throws at
 * the call site (`normalizeCodec`) per the project's "fail fast" stance.
 *
 * The literal-string union is intentionally redeclared inside the worker
 * (workers can't import from this module), with a comment pointing back here.
 */
type E2eeCodec = 'opus' | 'vp8' | 'h264';

/**
 * Map a mediasoup `rtpParameters.codecs[0].mimeType` to the worker's codec
 * discriminator. Throws on anything not in {@link E2eeCodec} so an unexpected
 * codec surfaces as an `RTC_FAILED` dispatch instead of being silently
 * encrypted with the wrong header size (which iOS Safari's H264 decoder
 * would reject 100% of frames for).
 */
export function normalizeCodec(mimeType: string): E2eeCodec {
  switch (mimeType.toLowerCase()) {
    case 'audio/opus':
      return 'opus';
    case 'video/vp8':
      return 'vp8';
    case 'video/h264':
      return 'h264';
    default:
      throw new Error(
        `[E2EE] Unsupported codec mimeType: ${mimeType}. ` +
          `Add it to MEDIA_CODECS and to E2eeCodec / getUnencryptedByteCount.`,
      );
  }
}

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
 * @param codec - Negotiated codec; determines unencrypted header size in worker
 */
export function setupSenderTransform(
  sender: RTCRtpSender,
  key: CryptoKey,
  worker: Worker,
  codec: E2eeCodec,
): void {
  (sender as unknown as Record<string, unknown>).transform = new RTCRtpScriptTransform(worker, {
    operation: 'encrypt',
    key,
    codec,
  });
  console.log(`[E2EE] Encrypt transform applied to sender (codec=${codec})`);
}

/**
 * Apply decrypt transform to an RTCRtpReceiver.
 *
 * @param receiver - The RTP receiver (from a mediasoup Consumer's rtpReceiver)
 * @param key - AES-GCM CryptoKey for decryption
 * @param worker - E2EE Web Worker instance
 * @param codec - Negotiated codec; determines unencrypted header size in worker
 */
export function setupReceiverTransform(
  receiver: RTCRtpReceiver,
  key: CryptoKey,
  worker: Worker,
  codec: E2eeCodec,
): void {
  (receiver as unknown as Record<string, unknown>).transform = new RTCRtpScriptTransform(worker, {
    operation: 'decrypt',
    key,
    codec,
  });
  console.log(`[E2EE] Decrypt transform applied to receiver (codec=${codec})`);
}
