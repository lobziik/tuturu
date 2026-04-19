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
import { processFrame } from './e2ee-worker';

const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const AUDIO_HEADER = 1;
const VIDEO_KEY_HEADER = 10;
const VIDEO_DELTA_HEADER = 3;

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
    test('audio: leaves 1 header byte unencrypted, prepends IV before ciphertext', async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode('hello world');
      const frame = createAudioFrame(plaintext.buffer as ArrayBuffer);

      const result = await processFrame('encrypt', key, frame as unknown as RTCEncodedAudioFrame);

      expect(result).toBe('ok');
      // Output: [header (1B)] [IV (12B)] [ciphertext over (N-1) bytes + GCM tag (16B)]
      expect(frame.data.byteLength).toBe(
        AUDIO_HEADER + IV_LENGTH + (plaintext.byteLength - AUDIO_HEADER) + GCM_TAG_LENGTH,
      );
      // Header byte must be the first plaintext byte verbatim
      expect(new Uint8Array(frame.data)[0]).toBe(plaintext[0]);
    });

    test('video keyframe: leaves 10 header bytes unencrypted', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(64);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i;
      const frame = createVideoFrame(plaintext.buffer as ArrayBuffer, 'key');

      const result = await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('ok');
      expect(frame.data.byteLength).toBe(
        VIDEO_KEY_HEADER + IV_LENGTH + (plaintext.byteLength - VIDEO_KEY_HEADER) + GCM_TAG_LENGTH,
      );
      // First 10 bytes are preserved as plaintext for the depacketizer
      const headerOut = new Uint8Array(frame.data, 0, VIDEO_KEY_HEADER);
      expect(headerOut).toEqual(plaintext.slice(0, VIDEO_KEY_HEADER));
    });

    test('video delta frame: leaves 3 header bytes unencrypted', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(64);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i;
      const frame = createVideoFrame(plaintext.buffer as ArrayBuffer, 'delta');

      const result = await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('ok');
      expect(frame.data.byteLength).toBe(
        VIDEO_DELTA_HEADER +
          IV_LENGTH +
          (plaintext.byteLength - VIDEO_DELTA_HEADER) +
          GCM_TAG_LENGTH,
      );
      const headerOut = new Uint8Array(frame.data, 0, VIDEO_DELTA_HEADER);
      expect(headerOut).toEqual(plaintext.slice(0, VIDEO_DELTA_HEADER));
    });

    test('different encryptions produce different IVs', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4]);

      const frame1 = createAudioFrame(plaintext.buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame1 as unknown as RTCEncodedAudioFrame);
      const iv1 = new Uint8Array(frame1.data, AUDIO_HEADER, IV_LENGTH);

      const frame2 = createAudioFrame(new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame2 as unknown as RTCEncodedAudioFrame);
      const iv2 = new Uint8Array(frame2.data, AUDIO_HEADER, IV_LENGTH);

      const same = iv1.every((byte, i) => byte === iv2[i]);
      expect(same).toBe(false);
    });

    test('reports malformed for frames smaller than their codec header', async () => {
      const key = await generateKey();
      // Video keyframe needs at least 10 header bytes; provide only 5
      const tooSmall = new ArrayBuffer(5);
      const frame = createVideoFrame(tooSmall, 'key');

      const result = await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('malformed');
    });
  });

  describe('decrypt', () => {
    test('audio round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new TextEncoder().encode('round trip test');
      const frame = createAudioFrame(original.buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedAudioFrame);
      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedAudioFrame);

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('video keyframe round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new Uint8Array(64);
      for (let i = 0; i < original.length; i++) original[i] = (i * 7) & 0xff;
      const frame = createVideoFrame(original.buffer as ArrayBuffer, 'key');

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);
      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('video delta-frame round-trip recovers original data', async () => {
      const key = await generateKey();
      const original = new Uint8Array(64);
      for (let i = 0; i < original.length; i++) original[i] = (i * 11) & 0xff;
      const frame = createVideoFrame(original.buffer as ArrayBuffer, 'delta');

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);
      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('ok');
      expect(new Uint8Array(frame.data)).toEqual(original);
    });

    test('reports crypto-failed for wrong key', async () => {
      const encryptKey = await generateKey();
      const decryptKey = await generateKey();
      const frame = createAudioFrame(new TextEncoder().encode('secret').buffer as ArrayBuffer);

      await processFrame('encrypt', encryptKey, frame as unknown as RTCEncodedAudioFrame);
      const result = await processFrame(
        'decrypt',
        decryptKey,
        frame as unknown as RTCEncodedAudioFrame,
      );

      expect(result).toBe('crypto-failed');
    });

    test('reports malformed for data shorter than header + IV + GCM tag', async () => {
      const key = await generateKey();
      // Audio: needs at least 1 + 12 + 16 = 29 bytes; provide 28
      const tooShort = new ArrayBuffer(AUDIO_HEADER + IV_LENGTH + GCM_TAG_LENGTH - 1);
      const frame = createAudioFrame(tooShort);

      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedAudioFrame);

      expect(result).toBe('malformed');
    });

    test('reports crypto-failed for corrupted ciphertext', async () => {
      const key = await generateKey();
      const frame = createAudioFrame(new TextEncoder().encode('data').buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedAudioFrame);

      // Corrupt a byte in the ciphertext portion (after header + IV)
      const view = new Uint8Array(frame.data);
      view[AUDIO_HEADER + IV_LENGTH]! ^= 0xff;

      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedAudioFrame);

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

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      // Flip a bit inside the unencrypted header (first 3 bytes for delta).
      // The wire is still well-formed (length unchanged), so this isn't
      // 'malformed' — but the AAD on the receiver side no longer matches
      // what the sender used, so AES-GCM rejects.
      const view = new Uint8Array(frame.data);
      view[0]! ^= 0x01;

      const result = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(result).toBe('crypto-failed');
    });
  });
});
