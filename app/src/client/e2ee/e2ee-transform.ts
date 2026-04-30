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
 * unencrypted header bytes per frame. Limited to what the SFU router and the
 * mesh path with E2EE actually negotiate — Opus + VP8. H264 is intentionally
 * out of scope: SFU rejects it at the router caps and mesh enforces VP8 via
 * `setCodecPreferences` whenever E2EE is on.
 *
 * The literal-string union is intentionally redeclared inside the worker
 * (workers can't import from this module), with a comment pointing back here.
 */
type E2eeCodec = 'opus' | 'vp8';

/**
 * Map a mediasoup `rtpParameters.codecs[0].mimeType` to the worker's codec
 * discriminator. Throws on anything not in {@link E2eeCodec} so an unexpected
 * codec surfaces as an `RTC_FAILED` dispatch instead of being silently
 * encrypted with the wrong header size.
 */
export function normalizeCodec(mimeType: string): E2eeCodec {
  switch (mimeType.toLowerCase()) {
    case 'audio/opus':
      return 'opus';
    case 'video/vp8':
      return 'vp8';
    default:
      throw new Error(
        `[E2EE] Unsupported codec mimeType: ${mimeType}. ` +
          `Add it to MEDIA_CODECS and to E2eeCodec / getUnencryptedByteCount.`,
      );
  }
}

/**
 * Parse the negotiated codec per media kind out of an SDP.
 *
 * For each `m=audio`/`m=video` section, takes the first payload type in the
 * m-line and resolves it through the section's `a=rtpmap:` entry to a codec
 * name. In an answer SDP this PT is the agreed codec by definition. In an
 * offer SDP it is only the offerer's first preference — but we call it from
 * the callee path with the offer SDP, and that produces the right codec
 * **only because both sides force VP8 first via `setCodecPreferences` in
 * `services/webrtc.ts` before any offer is created**. If that invariant
 * ever breaks (e.g. mesh stops enforcing VP8, or a multi-codec future
 * arrives), callers using offer SDP must switch to answer SDP and accept
 * the AAD mismatch window during rollout.
 *
 * Exists because `RTCRtpSender.getParameters().codecs` / `...Receiver...`
 * return an empty array on iOS Safari right after SDP apply — the receiver
 * side never gets an E2EE transform attached, so decryption silently drops
 * 100% of frames. SDP always carries the negotiated PT, so it's a reliable
 * source in that window. Missing m-lines (audio-only call, rejected
 * recvonly video) are represented by absent keys and left for the caller
 * to handle. Throws on malformed SDP or unsupported codecs per the
 * project's fail-fast stance.
 */
export function parseNegotiatedCodecs(sdp: string): Partial<Record<'audio' | 'video', E2eeCodec>> {
  const result: Partial<Record<'audio' | 'video', E2eeCodec>> = {};
  const lines = sdp.split(/\r?\n/);

  let currentKind: 'audio' | 'video' | null = null;
  let currentPt: string | null = null;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      // m=<media> <port> <proto> <fmt> ...
      const parts = line.slice(2).split(' ');
      const media = parts[0];
      const port = parts[1];
      const firstPt = parts[3];
      // Skip rejected m-lines (port=0) — no media flows, nothing to wire.
      if ((media === 'audio' || media === 'video') && port !== '0' && firstPt) {
        currentKind = media;
        currentPt = firstPt;
      } else {
        currentKind = null;
        currentPt = null;
      }
      continue;
    }
    if (!currentKind || !currentPt) continue;
    if (!line.startsWith('a=rtpmap:')) continue;

    // a=rtpmap:<pt> <codec>/<rate>[/<channels>]
    const rest = line.slice('a=rtpmap:'.length);
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx < 0) continue;
    const pt = rest.slice(0, spaceIdx);
    if (pt !== currentPt) continue;

    const remainder = rest.slice(spaceIdx + 1);
    const slashIdx = remainder.indexOf('/');
    const codecName = slashIdx >= 0 ? remainder.slice(0, slashIdx) : remainder;
    result[currentKind] = normalizeCodec(`${currentKind}/${codecName}`);
    // Stop matching further rtpmap lines for this m-section.
    currentPt = null;
  }

  return result;
}

/** Check if the browser supports Encoded Transforms (RTCRtpScriptTransform). */
export function isE2eeSupported(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/**
 * RTCConfiguration extension required by Chrome to actually deliver frames
 * to RTCRtpScriptTransform. Without `encodedInsertableStreams: true`, the
 * `rtctransform` event fires but the readable stream stays empty, frames
 * bypass the worker entirely, and stats show 0 packets through the
 * transform. Safari accepts and ignores the unknown field — harmless when
 * E2EE is off, required when on.
 *
 * Shared between mesh (`createPeerConnection` in `services/webrtc.ts`) and
 * SFU (`additionalSettings` on the WebRtcTransport in `sfu/transport.ts`).
 * Standard `RTCConfiguration` doesn't declare the flag, hence the cast.
 */
export const RTC_ENCODED_INSERTABLE_STREAMS: Partial<RTCConfiguration> = {
  encodedInsertableStreams: true,
} as Partial<RTCConfiguration>;

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
 * @param sender - The RTP sender (from RTCPeerConnection or mediasoup Producer)
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
 * @param receiver - The RTP receiver (from RTCPeerConnection or mediasoup Consumer)
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
