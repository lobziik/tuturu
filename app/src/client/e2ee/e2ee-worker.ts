/**
 * E2EE Web Worker — per-frame AES-256-GCM encryption/decryption.
 *
 * Runs inside the WebRTC Encoded Transform pipeline. The browser hands us
 * RTCEncodedVideoFrame / RTCEncodedAudioFrame objects on the readable side;
 * we mutate `frame.data` and forward to the writable side.
 *
 * Ref: https://github.com/jitsi/lib-jitsi-meet/blob/df9bfa9d1c9d22f524750632f4522fc2935e7dfb/modules/e2ee/Context.ts#L289
 * ─────────────────────────────────────────────────────────────────────────
 *  WIRE FORMAT
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   [unencrypted header (N bytes)] [IV (12 bytes)] [ciphertext + GCM tag (≥16 bytes)]
 *
 *  The first N bytes of every frame are deliberately left in plaintext for
 *  two compounding reasons:
 *
 *    1. The SFU's depacketizer and the receiver's video decoder need to
 *       identify frame structure (codec, keyframe-vs-delta, NAL type, …)
 *       without holding the key. Encrypting these bytes triggers hard
 *       parse failures in hardware-accelerated pipelines.
 *
 *    2. AAD binding (below) authenticates these plaintext bytes anyway, so
 *       leaving them readable doesn't cost integrity, only confidentiality
 *       on a handful of header fields the SFU already inspects.
 *
 *  N depends on codec + frame type. The negotiated codec is passed in via
 *  the `RTCRtpScriptTransform` options bag (see `e2ee-transform.ts`); both
 *  ends of a producer/consumer pair always agree on the codec, so no
 *  out-of-band signaling is needed.
 *
 *    - opus (audio, Opus TOC byte) — 1 byte
 *      RFC 6716 §3.1
 *      https://datatracker.ietf.org/doc/html/rfc6716#section-3.1
 *
 *    - vp8 keyframe (VP8 uncompressed_data_chunk) — 10 bytes
 *      vp8 delta — 3 bytes (subset of the above)
 *      RFC 6386 §9.1
 *      https://datatracker.ietf.org/doc/html/rfc6386#section-9.1
 *
 *  H264 is intentionally out of scope: the SFU router rejects it at
 *  caps negotiation, and mesh forces VP8 via `setCodecPreferences`
 *  whenever E2EE is on (see `app/src/client/services/webrtc.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AAD BINDING (Authenticated Additional Data)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Both encrypt and decrypt pass the unencrypted header bytes as
 *  `additionalData` to AES-GCM. AES-GCM mixes additional data into the
 *  authentication tag without including it in the ciphertext: the
 *  receiver computes the same AAD over the (still plaintext) bytes it
 *  observes and must arrive at the same tag, otherwise decryption fails.
 *  Net effect: anyone in the pipeline — including the SFU — that flips a
 *  bit in the plaintext header is detected on the receiving end. The
 *  bytes are readable, but not silently mutable.
 *
 *  Same pattern the SFrame draft uses for its own unencrypted header
 *  bytes:
 *    https://datatracker.ietf.org/doc/html/draft-omara-sframe-00#section-4.2
 *
 *  AesGcmParams.additionalData spec:
 *    https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  IV CHOICE
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  We use a fresh 12-byte IV per frame from `crypto.getRandomValues`, sent
 *  on the wire alongside the ciphertext. 96 bits is the recommended
 *  AES-GCM IV size per NIST SP-800-38D and what the Web Crypto API
 *  expects:
 *    https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
 *
 *  Random IVs are just simpler.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  LOGGING
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - 'ok': frame ready to enqueue.
 * - 'malformed': frame too short to physically contain its
 *                      codec header / IV / GCM tag — wire-format
 *                      violation, NOT a key problem. A steady stream
 *                      of these means something is truncating frames
 *                      in transit.
 * - 'crypto-failed': AES-GCM rejected — wrong key, corrupted
 *                      ciphertext, or AAD mismatch (header tampered).
 *                      Expected briefly during connection setup
 *                      before the peer's key is imported; persistent
 *                      on decrypt = key mismatch; on encrypt = should
 *                      never happen and triggers a console.error.
 *
 * @module client/e2ee/e2ee-worker
 */

const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/**
 * Mirrors `E2eeCodec` from `e2ee-transform.ts`. Workers can't import from
 * non-worker modules, so the literal-string union is redeclared here. Keep
 * the two in sync — `normalizeCodec` is the single point that produces it.
 */
type E2eeCodec = 'opus' | 'vp8';

const KNOWN_CODECS: ReadonlySet<E2eeCodec> = new Set(['opus', 'vp8']);

/**
 * Number of leading bytes left unencrypted so the SFU/depacketizer/decoder
 * can parse codec metadata without the key. See the module header for per-
 * codec rationale and RFC references.
 *
 * Audio frames lack a `.type` field; video frames carry `'key' | 'delta'`.
 */
function getUnencryptedByteCount(
  codec: E2eeCodec,
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
): number {
  if (codec === 'opus') return 1; // RFC 6716 §3.1 — Opus TOC byte
  // VP8 — `'type' in frame` narrows to RTCEncodedVideoFrame (audio frames
  // lack the property), so no cast is needed to read .type. mediasoup
  // never produces audio on a video codec, so the narrow is safe.
  const isKey = 'type' in frame && frame.type === 'key';
  // VP8 sizes from RFC 6386 §9.1.
  return isKey ? 10 : 3;
}

/**
 * Outcome of processing a single frame. Anything other than `'ok'` means
 * the frame is dropped without being enqueued — see the module-level
 * "Failure modes" section for what each value diagnostically means.
 *
 * @internal Exported for testing.
 */
export type FrameResult = 'ok' | 'malformed' | 'crypto-failed';

/**
 * Encrypt or decrypt a single encoded frame in place.
 *
 * @returns A discriminator describing the outcome — see {@link FrameResult}.
 *          `'ok'` means `frame.data` has been replaced and the caller
 *          should enqueue it; anything else means drop the frame.
 *
 * @internal Exported for testing.
 */
export async function processFrame(
  operation: 'encrypt' | 'decrypt',
  key: CryptoKey,
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  codec: E2eeCodec,
): Promise<FrameResult> {
  const data = frame.data;
  const headerBytes = getUnencryptedByteCount(codec, frame);

  if (operation === 'encrypt') {
    if (data.byteLength < headerBytes) {
      // Frame doesn't even contain its codec header — refuse to emit garbage
      // onto the wire. The receiver's depacketizer would reject it anyway.
      return 'malformed';
    }
    const header = new Uint8Array(data, 0, headerBytes);
    const payload = new Uint8Array(data, headerBytes);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    let ciphertext: ArrayBuffer;
    try {
      // additionalData binds the unencrypted header into the GCM tag, so
      // any tamper with those plaintext bytes by the SFU or anyone else
      // in the pipeline causes decryption to fail loud rather than
      // silently corrupting playback. Same pattern as
      // draft-omara-sframe-00 §4.2.
      ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: header },
        key,
        payload,
      );
    } catch (err) {
      // AES-GCM encrypt with a valid CryptoKey + valid input shouldn't
      // ever fail. Log loud so we see it; drop the frame so the
      // transform stream doesn't tear down on an unhandled rejection
      // (which would kill all subsequent media).
      console.error('[E2EE:Worker] encrypt failed:', err);
      return 'crypto-failed';
    }

    const result = new ArrayBuffer(headerBytes + IV_LENGTH + ciphertext.byteLength);
    const view = new Uint8Array(result);
    view.set(header, 0);
    view.set(iv, headerBytes);
    view.set(new Uint8Array(ciphertext), headerBytes + IV_LENGTH);
    frame.data = result;
    return 'ok';
  }

  // decrypt
  if (data.byteLength < headerBytes + IV_LENGTH + GCM_TAG_LENGTH) {
    // Frame too short to physically contain header + IV + GCM tag — wire
    // format violation, not a key problem. Distinguishing it from
    // 'crypto-failed' in the counter helps tell "peer joined and we
    // don't have their key yet" (steady 'crypto-failed') from "frames
    // are arriving truncated" (steady 'malformed').
    return 'malformed';
  }
  const header = new Uint8Array(data, 0, headerBytes);
  const iv = new Uint8Array(data, headerBytes, IV_LENGTH);
  const ciphertext = new Uint8Array(data, headerBytes + IV_LENGTH);
  try {
    // Same additionalData on decrypt as on encrypt — see encrypt branch.
    // Header bytes are echoed verbatim through the wire format, so the
    // receiver's AAD = sender's AAD whenever the wire bytes are intact.
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      key,
      ciphertext,
    );
    const result = new ArrayBuffer(headerBytes + plaintext.byteLength);
    const view = new Uint8Array(result);
    view.set(header, 0);
    view.set(new Uint8Array(plaintext), headerBytes);
    frame.data = result;
    return 'ok';
  } catch {
    // Decryption rejected: wrong key, corrupted ciphertext, or AAD
    // mismatch (header tampered). Drop the frame — the decoder handles
    // missing frames gracefully (brief artifact, then resync on the
    // next keyframe). See module header for why we don't throw.
    return 'crypto-failed';
  }
}

/**
 * Monotonic id assigned to each setupTransform invocation. With six mesh
 * peers and audio+video each direction, we'd otherwise get 24 indistinguishable
 * counter logs per cadence — useless for figuring out which pipeline is the
 * one with crypto-failed spikes. Prefix every log line in a pipeline with
 * `pipe#N` to disambiguate.
 */
let nextPipeId = 0;

/**
 * Wire the readable→transform→writable pipeline that the browser hands us
 * via the `rtctransform` event. Tracks per-bucket counters and logs every
 * 100 frames so we can see — separately for each producer/consumer
 * pipeline — how many frames went through cleanly vs. were dropped, and
 * why.
 *
 * @internal Exported for testing.
 */
export function setupTransform(
  readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  operation: 'encrypt' | 'decrypt',
  key: CryptoKey,
  codec: E2eeCodec,
): void {
  const pipeId = ++nextPipeId;
  const tag = `[E2EE:Worker pipe#${pipeId}]`;
  console.log(`${tag} options received: ${typeof key} ${operation} codec=${codec}`);
  let ok = 0;
  let malformed = 0;
  let cryptoFailed = 0;
  const transform = new TransformStream<
    RTCEncodedVideoFrame | RTCEncodedAudioFrame,
    RTCEncodedVideoFrame | RTCEncodedAudioFrame
  >({
    async transform(frame, controller) {
      const result = await processFrame(operation, key, frame, codec);
      if (result === 'ok') {
        controller.enqueue(frame);
        ok++;
      } else if (result === 'malformed') {
        malformed++;
      } else {
        cryptoFailed++;
      }
      // Periodic per-bucket breakdown — see "Failure modes" in the
      // module header for what each bucket diagnostically means.
      if (ok + malformed + cryptoFailed === 1 || (ok + malformed + cryptoFailed) % 100 === 0) {
        console.log(
          `${tag} ${operation} codec=${codec}: ${ok} ok, ${malformed} malformed, ${cryptoFailed} crypto-failed`,
        );
      }
    },
  });

  // Diagnostic: confirm the readable side actually delivers frames. If
  // `read()` never resolves, the browser is handing us a stream that
  // nothing's writing to (i.e. SFU/transport dropped the media before it
  // reached the encoded-transform layer).
  console.log(`${tag} readable type: ${typeof readable}, locked: ${readable.locked}`);

  readable
    .pipeThrough(transform)
    .pipeTo(writable)
    .catch((err: unknown) => {
      console.error(`${tag} pipe failed (${operation} codec=${codec}):`, err);
    });
}

/**
 * Handle a single `rtctransform` event from RTCRtpScriptTransform. Validates
 * the codec arriving in `transformer.options` against {@link KNOWN_CODECS}
 * and, when accepted, hands the readable/writable pair to {@link setupTransform}.
 *
 * Extracted from the addEventListener wiring below so it can be unit-tested
 * with a fabricated event without dispatching on globalThis.
 *
 * @internal Exported for testing.
 */
export function handleRtcTransformEvent(event: Event): void {
  const rtcEvent = event as unknown as {
    transformer: { readable: ReadableStream; writable: WritableStream; options: unknown };
  };
  const transformer = rtcEvent.transformer;
  const options = transformer.options as {
    operation: 'encrypt' | 'decrypt';
    key: CryptoKey;
    codec: E2eeCodec;
  };

  // Defense in depth — call site (`normalizeCodec`) is the primary gate, but
  // an unknown codec arriving here means a wire-format mismatch is about to
  // happen. Bail before piping; the per-pipeline counter sitting at 0
  // forever becomes the diagnostic.
  if (!KNOWN_CODECS.has(options.codec)) {
    console.error(`[E2EE:Worker] unknown codec '${options.codec}' — refusing to set up transform`);
    return;
  }

  setupTransform(
    transformer.readable as unknown as ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
    transformer.writable as unknown as WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
    options.operation,
    options.key,
    options.codec,
  );
}

// Wire up: the actual browser registration. Side-effecting on import; safe
// because the worker file is loaded inside a dedicated worker context where
// `addEventListener` is exactly the worker's event target.
addEventListener('rtctransform', handleRtcTransformEvent);
