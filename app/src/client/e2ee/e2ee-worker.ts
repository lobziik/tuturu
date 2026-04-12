/**
 * E2EE Web Worker — per-frame AES-256-GCM encryption/decryption.
 *
 * Used with RTCRtpScriptTransform to encrypt outgoing and decrypt incoming
 * RTP frames in the WebRTC pipeline. Each frame gets a random 12-byte IV
 * prepended to the ciphertext.
 *
 * Wire format: [IV (12 bytes)][ciphertext][GCM tag (16 bytes)]
 *
 * @module client/e2ee/e2ee-worker
 */

const IV_LENGTH = 12;

/**
 * Process a single encoded frame: encrypt or decrypt.
 *
 * @returns `true` if the frame was processed successfully and should be enqueued,
 *          `false` if the frame should be dropped (decrypt failure).
 */
async function processFrame(
  operation: 'encrypt' | 'decrypt',
  key: CryptoKey,
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
): Promise<boolean> {
  const data = frame.data;

  if (operation === 'encrypt') {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    const result = new ArrayBuffer(IV_LENGTH + ciphertext.byteLength);
    const resultView = new Uint8Array(result);
    resultView.set(iv, 0);
    resultView.set(new Uint8Array(ciphertext), IV_LENGTH);
    frame.data = result;
    return true;
  }

  if (data.byteLength < IV_LENGTH + 16) {
    // Too short to contain IV + GCM tag — drop frame
    return false;
  }
  const iv = new Uint8Array(data, 0, IV_LENGTH);
  const ciphertext = new Uint8Array(data, IV_LENGTH);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    frame.data = plaintext;
    return true;
  } catch {
    // Decryption failed (wrong key, corrupted frame) — drop the frame.
    // The decoder handles missing frames gracefully (brief artifact, then recovers).
    return false;
  }
}

/**
 * Set up the transform pipeline: readable → transform → writable.
 */
function setupTransform(
  readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  operation: 'encrypt' | 'decrypt',
  key: CryptoKey,
): void {
  const transform = new TransformStream<
    RTCEncodedVideoFrame | RTCEncodedAudioFrame,
    RTCEncodedVideoFrame | RTCEncodedAudioFrame
  >({
    async transform(frame, controller) {
      const ok = await processFrame(operation, key, frame);
      if (ok) {
        controller.enqueue(frame);
      }
      // else: frame dropped — decoder handles missing frames gracefully
    },
  });

  void readable.pipeThrough(transform).pipeTo(writable);
}

// Handle rtctransform events dispatched by RTCRtpScriptTransform
addEventListener('rtctransform', (event: Event) => {
  const rtcEvent = event as unknown as {
    transformer: { readable: ReadableStream; writable: WritableStream; options: unknown };
  };
  const transformer = rtcEvent.transformer;
  const options = transformer.options as { operation: 'encrypt' | 'decrypt'; key: CryptoKey };

  setupTransform(
    transformer.readable as unknown as ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
    transformer.writable as unknown as WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
    options.operation,
    options.key,
  );
});
