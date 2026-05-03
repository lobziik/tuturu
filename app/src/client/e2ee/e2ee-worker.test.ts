/**
 * Unit tests for the E2EE Web Worker frame encryption/decryption.
 *
 * Uses real Web Crypto API (Bun supports it) with mock frame objects.
 * processFrame accesses frame.data and (for video) frame.type, so the
 * mocks include `type` for video and omit it for audio to mirror the
 * shape of RTCEncoded{Audio,Video}Frame.
 *
 * @module client/e2ee/e2ee-worker.test
 */

import { describe, test, expect } from 'bun:test';
import { processFrame, setupTransform, handleRtcTransformEvent } from './e2ee-worker';
import { normalizeCodec } from './e2ee-transform';

const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const AUDIO_HEADER = 1;
const VP8_KEY_HEADER = 10;
const VP8_DELTA_HEADER = 3;

/** Generate an AES-256-GCM key for testing. */
async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Mock audio frame: no `.type` field, mirrors RTCEncodedAudioFrame. */
function createAudioFrame(data: ArrayBuffer): { data: ArrayBuffer } {
  return { data };
}

/** Mock video frame: carries `.type` like RTCEncodedVideoFrame. */
function createVideoFrame(
  data: ArrayBuffer,
  type: 'key' | 'delta',
): { data: ArrayBuffer; type: 'key' | 'delta' } {
  return { data, type };
}

describe('processFrame', () => {
  describe('encrypt', () => {
    test('audio (opus): leaves 1 header byte unencrypted, prepends IV before ciphertext', async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode('hello world');
      const frame = createAudioFrame(plaintext.buffer as ArrayBuffer);

      const result = await processFrame(
        'encrypt',
        key,
        frame as unknown as RTCEncodedAudioFrame,
        'opus',
      );

      expect(result).toBe('ok');
      // Output: [header (1B)] [IV (12B)] [ciphertext over (N-1) bytes + GCM tag (16B)]
      expect(frame.data.byteLength).toBe(
        AUDIO_HEADER + IV_LENGTH + (plaintext.byteLength - AUDIO_HEADER) + GCM_TAG_LENGTH,
      );
      // Header byte must be the first plaintext byte verbatim
      expect(new Uint8Array(frame.data)[0]).toBe(plaintext[0]);
    });

    test('vp8 keyframe: leaves 10 header bytes unencrypted', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(64);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i;
      const frame = createVideoFrame(plaintext.buffer as ArrayBuffer, 'key');

      const result = await processFrame(
        'encrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('ok');
      expect(frame.data.byteLength).toBe(
        VP8_KEY_HEADER + IV_LENGTH + (plaintext.byteLength - VP8_KEY_HEADER) + GCM_TAG_LENGTH,
      );
      // First 10 bytes are preserved as plaintext for the depacketizer
      const headerOut = new Uint8Array(frame.data, 0, VP8_KEY_HEADER);
      expect(headerOut).toEqual(plaintext.slice(0, VP8_KEY_HEADER));
    });

    test('vp8 delta frame: leaves 3 header bytes unencrypted', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(64);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i;
      const frame = createVideoFrame(plaintext.buffer as ArrayBuffer, 'delta');

      const result = await processFrame(
        'encrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('ok');
      expect(frame.data.byteLength).toBe(
        VP8_DELTA_HEADER + IV_LENGTH + (plaintext.byteLength - VP8_DELTA_HEADER) + GCM_TAG_LENGTH,
      );
      const headerOut = new Uint8Array(frame.data, 0, VP8_DELTA_HEADER);
      expect(headerOut).toEqual(plaintext.slice(0, VP8_DELTA_HEADER));
    });

    test('different encryptions produce different IVs', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4]);

      const frame1 = createAudioFrame(plaintext.buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame1 as unknown as RTCEncodedAudioFrame, 'opus');
      const iv1 = new Uint8Array(frame1.data, AUDIO_HEADER, IV_LENGTH);

      const frame2 = createAudioFrame(new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame2 as unknown as RTCEncodedAudioFrame, 'opus');
      const iv2 = new Uint8Array(frame2.data, AUDIO_HEADER, IV_LENGTH);

      const same = iv1.every((byte, i) => byte === iv2[i]);
      expect(same).toBe(false);
    });

    test('reports malformed for frames smaller than their codec header', async () => {
      const key = await generateKey();
      // VP8 keyframe needs at least 10 header bytes; provide only 5
      const tooSmall = new ArrayBuffer(5);
      const frame = createVideoFrame(tooSmall, 'key');

      const result = await processFrame(
        'encrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('malformed');
    });
  });

  describe('decrypt', () => {
    test('audio (opus) round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new TextEncoder().encode('round trip test');
      const frame = createAudioFrame(original.buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedAudioFrame, 'opus');
      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedAudioFrame,
        'opus',
      );

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('vp8 keyframe round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new Uint8Array(64);
      for (let i = 0; i < original.length; i++) original[i] = (i * 7) & 0xff;
      const frame = createVideoFrame(original.buffer as ArrayBuffer, 'key');

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame, 'vp8');
      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('vp8 delta-frame round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new Uint8Array(64);
      for (let i = 0; i < original.length; i++) original[i] = (i * 11) & 0xff;
      const frame = createVideoFrame(original.buffer as ArrayBuffer, 'delta');

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame, 'vp8');
      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('reports crypto-failed for wrong key', async () => {
      const encryptKey = await generateKey();
      const decryptKey = await generateKey();
      const frame = createAudioFrame(new TextEncoder().encode('secret').buffer as ArrayBuffer);

      await processFrame('encrypt', encryptKey, frame as unknown as RTCEncodedAudioFrame, 'opus');
      const result = await processFrame(
        'decrypt',
        decryptKey,
        frame as unknown as RTCEncodedAudioFrame,
        'opus',
      );

      expect(result).toBe('crypto-failed');
    });

    test('reports malformed for data shorter than header + IV + GCM tag', async () => {
      const key = await generateKey();
      // Audio: needs at least 1 + 12 + 16 = 29 bytes; provide 28
      const tooShort = new ArrayBuffer(AUDIO_HEADER + IV_LENGTH + GCM_TAG_LENGTH - 1);
      const frame = createAudioFrame(tooShort);

      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedAudioFrame,
        'opus',
      );

      expect(result).toBe('malformed');
    });

    test('reports crypto-failed for corrupted ciphertext', async () => {
      const key = await generateKey();
      const frame = createAudioFrame(new TextEncoder().encode('data').buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedAudioFrame, 'opus');

      // Corrupt a byte in the ciphertext portion (after header + IV)
      const view = new Uint8Array(frame.data);
      view[AUDIO_HEADER + IV_LENGTH]! ^= 0xff;

      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedAudioFrame,
        'opus',
      );

      expect(result).toBe('crypto-failed');
    });

    // AAD binding: the unencrypted header is passed as additionalData to
    // AES-GCM. Tampering with those plaintext bytes must invalidate the
    // GCM tag — same property the SFrame draft relies on
    // (draft-omara-sframe-00 §4.2).
    test('reports crypto-failed when the unencrypted header is tampered with (AAD binding)', async () => {
      const key = await generateKey();
      const original = new Uint8Array(64);
      for (let i = 0; i < original.length; i++) original[i] = (i * 13) & 0xff;
      const frame = createVideoFrame(original.buffer as ArrayBuffer, 'delta');

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame, 'vp8');

      // Flip a bit inside the unencrypted header (first 3 bytes for delta).
      // The wire is still well-formed (length unchanged), so this isn't
      // 'malformed' — but the AAD on the receiver side no longer matches
      // what the sender used, so AES-GCM rejects.
      const view = new Uint8Array(frame.data);
      view[0]! ^= 0x01;

      const result = await processFrame(
        'decrypt',
        key,
        frame as unknown as RTCEncodedVideoFrame,
        'vp8',
      );

      expect(result).toBe('crypto-failed');
    });
  });
});

describe('normalizeCodec', () => {
  test('maps known mimeTypes to discriminator (case-insensitive)', () => {
    expect(normalizeCodec('audio/opus')).toBe('opus');
    expect(normalizeCodec('video/VP8')).toBe('vp8');
    expect(normalizeCodec('video/vp8')).toBe('vp8');
  });

  test('throws on unsupported mimeType, naming the offending value', () => {
    expect(() => normalizeCodec('video/H264')).toThrow(/video\/H264/);
    expect(() => normalizeCodec('video/VP9')).toThrow(/video\/VP9/);
    expect(() => normalizeCodec('audio/PCMU')).toThrow(/audio\/PCMU/);
    expect(() => normalizeCodec('')).toThrow();
  });
});

// ============================================================================
// setupTransform
// ============================================================================

/**
 * Build a ReadableStream we can push frames into externally and a
 * WritableStream that records every chunk it receives. Together they let us
 * drive setupTransform end-to-end without involving real
 * RTCRtpScriptTransform — the readable simulates the browser handing us
 * encoded frames, and the writable captures the post-encrypt output.
 */
function buildPipe(): {
  readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  push: (frame: { data: ArrayBuffer; type?: 'key' | 'delta' }) => void;
  close: () => void;
  written: Array<{ data: ArrayBuffer; type?: 'key' | 'delta' }>;
} {
  let readableController:
    | ReadableStreamDefaultController<RTCEncodedVideoFrame | RTCEncodedAudioFrame>
    | undefined;
  const readable = new ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>({
    start(controller) {
      readableController = controller;
    },
  });

  const written: Array<{ data: ArrayBuffer; type?: 'key' | 'delta' }> = [];
  const writable = new WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>({
    write(chunk) {
      written.push(chunk as unknown as { data: ArrayBuffer; type?: 'key' | 'delta' });
    },
  });

  return {
    readable,
    writable,
    push: (frame) => {
      if (!readableController) throw new Error('readable controller not yet initialised');
      readableController.enqueue(frame as unknown as RTCEncodedVideoFrame | RTCEncodedAudioFrame);
    },
    close: () => readableController?.close(),
    written,
  };
}

/** Wait for the next microtask tick — lets piped TransformStream drain. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('setupTransform', () => {
  test('opus encrypt: pipes plaintext frames through processFrame and enqueues ok results', async () => {
    const key = await generateKey();
    const pipe = buildPipe();
    setupTransform(pipe.readable, pipe.writable, 'encrypt', key, 'opus');

    const plaintext = new TextEncoder().encode('hello world');
    pipe.push(createAudioFrame(plaintext.buffer as ArrayBuffer));
    pipe.close();

    // Pump microtasks until the writable has the frame.
    for (let i = 0; i < 10 && pipe.written.length === 0; i++) await tick();

    expect(pipe.written).toHaveLength(1);
    expect(pipe.written[0]!.data.byteLength).toBe(
      AUDIO_HEADER + IV_LENGTH + (plaintext.byteLength - AUDIO_HEADER) + GCM_TAG_LENGTH,
    );
  });

  test('vp8 encrypt: pumps multiple frames in sequence', async () => {
    // Multiple frames exercise the per-bucket counter and the
    // periodic logging branch (counter==1 is the first-frame log).
    const key = await generateKey();
    const pipe = buildPipe();
    setupTransform(pipe.readable, pipe.writable, 'encrypt', key, 'vp8');

    const FRAMES = 3;
    for (let i = 0; i < FRAMES; i++) {
      const buf = new Uint8Array(64);
      for (let j = 0; j < buf.length; j++) buf[j] = (i * 13 + j) & 0xff;
      pipe.push(createVideoFrame(buf.buffer as ArrayBuffer, i === 0 ? 'key' : 'delta'));
    }
    pipe.close();

    for (let i = 0; i < 20 && pipe.written.length < FRAMES; i++) await tick();

    expect(pipe.written).toHaveLength(FRAMES);
    // First frame was a keyframe → 10-byte header.
    expect(pipe.written[0]!.data.byteLength).toBe(
      VP8_KEY_HEADER + IV_LENGTH + (64 - VP8_KEY_HEADER) + GCM_TAG_LENGTH,
    );
    // Subsequent frames were deltas → 3-byte header.
    expect(pipe.written[1]!.data.byteLength).toBe(
      VP8_DELTA_HEADER + IV_LENGTH + (64 - VP8_DELTA_HEADER) + GCM_TAG_LENGTH,
    );
  });

  test('decrypt with wrong key: drops frames (crypto-failed bucket), nothing reaches writable', async () => {
    // Encrypt with one key, decrypt the result with another. The wrong-key
    // path inside processFrame returns 'crypto-failed', so the transform
    // stream should NOT enqueue anything — the writable stays empty.
    const encryptKey = await generateKey();
    const decryptKey = await generateKey();

    // Encrypt a frame first via processFrame so we have a valid wire-format
    // payload to feed in.
    const plaintext = new TextEncoder().encode('round trip');
    const encrypted = createAudioFrame(plaintext.buffer as ArrayBuffer);
    await processFrame('encrypt', encryptKey, encrypted as unknown as RTCEncodedAudioFrame, 'opus');

    const pipe = buildPipe();
    setupTransform(pipe.readable, pipe.writable, 'decrypt', decryptKey, 'opus');
    pipe.push(encrypted);
    pipe.close();

    for (let i = 0; i < 10; i++) await tick();
    expect(pipe.written).toHaveLength(0);
  });

  test('decrypt malformed frame: drops frame (malformed bucket)', async () => {
    // Frame too short to contain header + IV + GCM tag. processFrame
    // returns 'malformed'; transform stream skips enqueue.
    const key = await generateKey();
    const pipe = buildPipe();
    setupTransform(pipe.readable, pipe.writable, 'decrypt', key, 'opus');

    pipe.push(createAudioFrame(new ArrayBuffer(5)));
    pipe.close();

    for (let i = 0; i < 10; i++) await tick();
    expect(pipe.written).toHaveLength(0);
  });
});

// ============================================================================
// handleRtcTransformEvent
// ============================================================================

describe('handleRtcTransformEvent', () => {
  test('known codec: forwards readable/writable/options into setupTransform', async () => {
    const key = await generateKey();
    const pipe = buildPipe();

    const event = {
      transformer: {
        readable: pipe.readable,
        writable: pipe.writable,
        options: { operation: 'encrypt', key, codec: 'opus' },
      },
    } as unknown as Event;

    handleRtcTransformEvent(event);

    const plaintext = new TextEncoder().encode('via event');
    pipe.push(createAudioFrame(plaintext.buffer as ArrayBuffer));
    pipe.close();

    for (let i = 0; i < 10 && pipe.written.length === 0; i++) await tick();
    expect(pipe.written).toHaveLength(1);
  });

  test('unknown codec: refuses to wire the pipeline (no frames flow)', async () => {
    const key = await generateKey();
    const pipe = buildPipe();

    // 'h264' is not in KNOWN_CODECS — the defense-in-depth branch must
    // fire, log an error, and return without piping anything.
    const event = {
      transformer: {
        readable: pipe.readable,
        writable: pipe.writable,
        options: { operation: 'encrypt', key, codec: 'h264' },
      },
    } as unknown as Event;

    handleRtcTransformEvent(event);

    // Even if we push a frame, the readable was never piped through to the
    // writable, so nothing arrives.
    pipe.push(createAudioFrame(new ArrayBuffer(8)));
    for (let i = 0; i < 5; i++) await tick();
    expect(pipe.written).toHaveLength(0);
  });
});
