/**
 * Unit tests for the E2EE Web Worker frame encryption/decryption.
 *
 * Uses real Web Crypto API (Bun supports it) with mock frame objects.
 * The processFrame function only accesses frame.data, so a plain object suffices.
 *
 * @module client/e2ee/e2ee-worker.test
 */

import { describe, test, expect } from 'bun:test';
import { processFrame } from './e2ee-worker';

const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/** Generate an AES-256-GCM key for testing. */
async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Create a mock frame with the given data. */
function createMockFrame(data: ArrayBuffer): { data: ArrayBuffer } {
  return { data };
}

describe('processFrame', () => {
  describe('encrypt', () => {
    test('produces output with IV prefix', async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode('hello world');
      const frame = createMockFrame(plaintext.buffer as ArrayBuffer);

      const ok = await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(ok).toBe(true);
      // Output: [IV (12 bytes)] [ciphertext + GCM tag (16 bytes)]
      expect(frame.data.byteLength).toBeGreaterThanOrEqual(IV_LENGTH + GCM_TAG_LENGTH);
      // Output should be larger than input due to IV + tag overhead
      expect(frame.data.byteLength).toBe(IV_LENGTH + plaintext.byteLength + GCM_TAG_LENGTH);
    });

    test('different encryptions produce different IVs', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4]);

      const frame1 = createMockFrame(plaintext.buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame1 as unknown as RTCEncodedVideoFrame);
      const iv1 = new Uint8Array(frame1.data, 0, IV_LENGTH);

      const frame2 = createMockFrame(new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer);
      await processFrame('encrypt', key, frame2 as unknown as RTCEncodedVideoFrame);
      const iv2 = new Uint8Array(frame2.data, 0, IV_LENGTH);

      // IVs should differ (random) — extremely unlikely to be equal
      const same = iv1.every((byte, i) => byte === iv2[i]);
      expect(same).toBe(false);
    });
  });

  describe('decrypt', () => {
    test('round-trip encrypt → decrypt recovers original data', async () => {
      const key = await generateKey();
      const original = new TextEncoder().encode('round trip test');
      const frame = createMockFrame(original.buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);
      const ok = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(ok).toBe(true);
      const decrypted = new Uint8Array(frame.data);
      expect(decrypted).toEqual(original);
    });

    test('returns false for wrong key', async () => {
      const encryptKey = await generateKey();
      const decryptKey = await generateKey();
      const frame = createMockFrame(new TextEncoder().encode('secret').buffer as ArrayBuffer);

      await processFrame('encrypt', encryptKey, frame as unknown as RTCEncodedVideoFrame);
      const ok = await processFrame(
        'decrypt',
        decryptKey,
        frame as unknown as RTCEncodedVideoFrame,
      );

      expect(ok).toBe(false);
    });

    test('returns false for data shorter than IV + GCM tag', async () => {
      const key = await generateKey();
      // 27 bytes = IV_LENGTH (12) + GCM_TAG_LENGTH (16) - 1 = too short
      const tooShort = new ArrayBuffer(IV_LENGTH + GCM_TAG_LENGTH - 1);
      const frame = createMockFrame(tooShort);

      const ok = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(ok).toBe(false);
    });

    test('returns false for corrupted ciphertext', async () => {
      const key = await generateKey();
      const frame = createMockFrame(new TextEncoder().encode('data').buffer as ArrayBuffer);

      await processFrame('encrypt', key, frame as unknown as RTCEncodedVideoFrame);

      // Corrupt a byte in the ciphertext portion (after IV)
      const view = new Uint8Array(frame.data);
      view[IV_LENGTH]! ^= 0xff;

      const ok = await processFrame('decrypt', key, frame as unknown as RTCEncodedVideoFrame);

      expect(ok).toBe(false);
    });
  });
});
