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

/** State threaded through the SDP scan: the current m-section and its first PT. */
interface MSectionState {
  kind: 'audio' | 'video' | null;
  pt: string | null;
}

/** Parsed m-line: section state for the scan + an optional rejected-kind flag. */
interface ParsedMLine {
  state: MSectionState;
  /** Set when the m-line was port=0 — caller records the kind as rejected. */
  rejectedKind: 'audio' | 'video' | null;
}

/**
 * Parse a single `m=<media> <port> <proto> <fmt>...` line. Tracks both the
 * scan state for the rtpmap loop AND whether this line was a port=0
 * rejection — callers need the latter to distinguish "remote opted out of
 * this kind" (silent skip OK) from "SDP genuinely lacks this kind" (fail
 * loud on the sender side).
 */
function parseMLine(line: string): ParsedMLine {
  const parts = line.slice(2).split(' ');
  const [media, port, , firstPt] = parts;
  if (media !== 'audio' && media !== 'video') {
    return { state: { kind: null, pt: null }, rejectedKind: null };
  }
  if (port === '0') {
    return { state: { kind: null, pt: null }, rejectedKind: media };
  }
  if (!firstPt) {
    return { state: { kind: null, pt: null }, rejectedKind: null };
  }
  return { state: { kind: media, pt: firstPt }, rejectedKind: null };
}

/**
 * Extract the codec name from an `a=rtpmap:<pt> <codec>/<rate>[/<channels>]`
 * line if its PT matches `expectedPt`. Returns null when the line doesn't
 * apply (different PT, malformed, etc.) — the caller continues scanning.
 */
function parseRtpmapCodec(line: string, expectedPt: string): string | null {
  const rest = line.slice('a=rtpmap:'.length);
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx < 0) return null;
  const pt = rest.slice(0, spaceIdx);
  if (pt !== expectedPt) return null;
  const remainder = rest.slice(spaceIdx + 1);
  const slashIdx = remainder.indexOf('/');
  return slashIdx >= 0 ? remainder.slice(0, slashIdx) : remainder;
}

/** Result of {@link parseNegotiatedCodecs} — codecs by kind plus rejected-kind set. */
export interface NegotiatedCodecs {
  /** Resolved codec per media kind; absent key means no m-line at all. */
  codecs: Partial<Record<'audio' | 'video', E2eeCodec>>;
  /**
   * Kinds whose m-line was explicitly rejected (port=0). Distinct from
   * absent in `codecs`: rejected means the remote opted out and no media
   * will flow on that kind, so a sender with a track for that kind can be
   * silently skipped instead of failing loud. Used by `wireSenderTransform`
   * in `services/webrtc.ts` and works on both caller and callee paths
   * (caller reads answer SDP, callee reads offer SDP — both carry port=0
   * authoritatively, unlike `transceiver.currentDirection` which is `null`
   * before the first `setRemoteDescription`).
   *
   * **Only port=0 is captured here.** A non-zero port + `a=inactive`
   * combination is also "no media will flow", but the codec parses
   * normally and the kind ends up in `codecs`, not `rejected`. We don't
   * model that today because no caller distinguishes it; if a future
   * diagnostic needs to ("why are pipe counters at zero?"), parse the
   * direction attribute alongside the m-line port.
   */
  rejected: Set<'audio' | 'video'>;
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
 * source in that window.
 *
 * Returns both the codec map AND the set of explicitly-rejected kinds
 * (port=0 m-lines). Callers need the rejection set to distinguish "no
 * m-line at all" (audio-only call, SDP defect) from "remote opted out"
 * — the sender side throws on the former, silent-skips on the latter.
 *
 * Throws on malformed SDP or unsupported codecs per the project's
 * fail-fast stance.
 */
export function parseNegotiatedCodecs(sdp: string): NegotiatedCodecs {
  const codecs: Partial<Record<'audio' | 'video', E2eeCodec>> = {};
  const rejected = new Set<'audio' | 'video'>();
  let section: MSectionState = { kind: null, pt: null };

  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const parsed = parseMLine(line);
      section = parsed.state;
      if (parsed.rejectedKind) rejected.add(parsed.rejectedKind);
      continue;
    }
    if (!section.kind || !section.pt) continue;
    if (!line.startsWith('a=rtpmap:')) continue;

    const codecName = parseRtpmapCodec(line, section.pt);
    if (codecName === null) continue;

    codecs[section.kind] = normalizeCodec(`${section.kind}/${codecName}`);
    // Stop matching further rtpmap lines for this m-section. section.kind
    // is intentionally NOT cleared — the next `m=` line resets it; until
    // then the `!section.pt` guard above skips any rtpmap entries from
    // the same section.
    section = { kind: section.kind, pt: null };
  }

  return { codecs, rejected };
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
 *
 * `Object.freeze`'d because both call sites spread it into a fresh
 * configuration object, but a stray mutation in either consumer would
 * silently affect every future PC/transport.
 */
export const RTC_ENCODED_INSERTABLE_STREAMS: Readonly<Partial<RTCConfiguration>> = Object.freeze({
  encodedInsertableStreams: true,
} as Partial<RTCConfiguration>);

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
