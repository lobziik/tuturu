/**
 * Tests for crypto service: key derivation, encrypt/decrypt, hex/base64 helpers.
 *
 * @remarks
 * Argon2id is supposed to be slow, so key derivation runs once
 * in beforeAll. Encrypt/decrypt operations are fast.
 *
 * @module client/services/crypto.test
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  deriveKeys,
  encryptMessage,
  decryptMessage,
  hexToBytes,
  bytesToHex,
  toBase64,
  fromBase64,
} from './crypto';
import type { DerivedKeys } from './crypto';

// ============================================================================
// Hex helpers
// ============================================================================

describe('hexToBytes', () => {
  test('decodes known vector', () => {
    const result = hexToBytes('deadbeef');
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('handles empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  test('is case insensitive', () => {
    expect(hexToBytes('DEADBEEF')).toEqual(hexToBytes('deadbeef'));
  });

  test('decodes 00ff boundary values', () => {
    expect(hexToBytes('00ff')).toEqual(new Uint8Array([0x00, 0xff]));
  });

  test('throws on odd-length string', () => {
    expect(() => hexToBytes('abc')).toThrow('even length');
  });

  test('throws on non-hex characters', () => {
    expect(() => hexToBytes('zzzz')).toThrow('Invalid hex');
  });
});

describe('bytesToHex', () => {
  test('encodes known vector', () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  test('handles empty array', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });

  test('pads single-digit bytes with zero', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f]))).toBe('000f');
  });

  test('roundtrips with hexToBytes', () => {
    const original = 'cafebabe12345678';
    expect(bytesToHex(hexToBytes(original))).toBe(original);
  });
});

// ============================================================================
// Base64 helpers
// ============================================================================

describe('toBase64 / fromBase64', () => {
  test('encodes known vector', () => {
    // "Hello" in ASCII
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(toBase64(bytes)).toBe('SGVsbG8=');
  });

  test('roundtrips empty array', () => {
    const empty = new Uint8Array(0);
    expect(fromBase64(toBase64(empty))).toEqual(empty);
  });

  test('roundtrips random bytes', () => {
    const original = crypto.getRandomValues(new Uint8Array(256));
    const decoded = fromBase64(toBase64(original));
    expect(decoded).toEqual(original);
  });

  test('fromBase64 throws on invalid base64', () => {
    expect(() => fromBase64('not!valid!base64!!!')).toThrow();
  });
});

// ============================================================================
// Key Derivation
// ============================================================================

describe('deriveKeys', () => {
  // Derive keys once for all tests in this block (Argon2id is slow)
  let keys: DerivedKeys;

  beforeAll(async () => {
    keys = await deriveKeys('correct horse battery staple', '123456', 'call.example.com');
  });

  test('throws on empty passphrase', async () => {
    await expect(deriveKeys('', '123456', 'localhost')).rejects.toThrow(
      'passphrase must not be empty',
    );
  });

  test('throws on empty pin', async () => {
    await expect(deriveKeys('test phrase', '', 'localhost')).rejects.toThrow(
      'pin must not be empty',
    );
  });

  test('produces 32-char hex roomId', () => {
    expect(keys.roomId).toHaveLength(32);
    expect(keys.roomId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('produces correct test vector roomId', () => {
    // Canonical test vector: passphrase="correct horse battery staple", pin="123456", hostname="call.example.com"
    expect(keys.roomId).toBe('36f910fbcaaa990d79d003c356ff611d');
  });

  test('is deterministic — same inputs produce same roomId', async () => {
    const keys2 = await deriveKeys('correct horse battery staple', '123456', 'call.example.com');
    expect(keys2.roomId).toBe(keys.roomId);
  });

  test('is deterministic — cross-decrypt works with same inputs', async () => {
    const keys2 = await deriveKeys('correct horse battery staple', '123456', 'call.example.com');
    const plaintext = new TextEncoder().encode('cross-decrypt test');
    const wire = await encryptMessage(keys.aesKey, plaintext);
    const decrypted = await decryptMessage(keys2.aesKey, wire);
    expect(new TextDecoder().decode(decrypted)).toBe('cross-decrypt test');
  });

  test('different passphrase produces different roomId', async () => {
    const other = await deriveKeys('different phrase', '123456', 'call.example.com');
    expect(other.roomId).not.toBe(keys.roomId);
  });

  test('different pin produces different roomId', async () => {
    const other = await deriveKeys('correct horse battery staple', '654321', 'call.example.com');
    expect(other.roomId).not.toBe(keys.roomId);
  });

  test('different hostname produces different roomId', async () => {
    const other = await deriveKeys('correct horse battery staple', '123456', 'other.example.com');
    expect(other.roomId).not.toBe(keys.roomId);
  });

  test('aesKey is a CryptoKey with AES-GCM algorithm', () => {
    expect(keys.aesKey).toBeInstanceOf(CryptoKey);
    expect((keys.aesKey.algorithm as AesKeyAlgorithm).name).toBe('AES-GCM');
    expect((keys.aesKey.algorithm as AesKeyAlgorithm).length).toBe(256);
  });

  test('aesKey is not extractable', () => {
    expect(keys.aesKey.extractable).toBe(false);
  });
});

// ============================================================================
// Encrypt / Decrypt
// ============================================================================

describe('encryptMessage / decryptMessage', () => {
  let aesKey: CryptoKey;

  beforeAll(async () => {
    const keys = await deriveKeys('test', '000000', 'localhost');
    aesKey = keys.aesKey;
  });

  test('roundtrips plaintext', async () => {
    const plaintext = new TextEncoder().encode('Hello, world!');
    const wire = await encryptMessage(aesKey, plaintext);
    const decrypted = await decryptMessage(aesKey, wire);
    expect(decrypted).toEqual(plaintext);
  });

  test('roundtrips empty plaintext', async () => {
    const plaintext = new Uint8Array(0);
    const wire = await encryptMessage(aesKey, plaintext);
    const decrypted = await decryptMessage(aesKey, wire);
    expect(decrypted).toEqual(plaintext);
  });

  test('roundtrips UTF-8 JSON', async () => {
    const json = JSON.stringify({ v: 1, text: 'Привет мир 🌍', seq: 42 });
    const plaintext = new TextEncoder().encode(json);
    const wire = await encryptMessage(aesKey, plaintext);
    const decrypted = await decryptMessage(aesKey, wire);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual(JSON.parse(json));
  });

  test('wire format has correct length', async () => {
    const plaintext = new TextEncoder().encode('test');
    const wire = await encryptMessage(aesKey, plaintext);
    // iv(12) + plaintext(4) + authTag(16) = 32
    expect(wire.length).toBe(12 + 4 + 16);
  });

  test('IVs are unique across 1000 encryptions', async () => {
    const plaintext = new TextEncoder().encode('same plaintext');
    const ivs = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      const wire = await encryptMessage(aesKey, plaintext);
      const iv = bytesToHex(wire.slice(0, 12));
      ivs.add(iv);
    }

    expect(ivs.size).toBe(1000);
  });

  test('wrong key fails to decrypt', async () => {
    const otherKeys = await deriveKeys('other', '999999', 'localhost');
    const plaintext = new TextEncoder().encode('secret');
    const wire = await encryptMessage(aesKey, plaintext);

    await expect(decryptMessage(otherKeys.aesKey, wire)).rejects.toThrow();
  });

  test('tampered ciphertext fails to decrypt', async () => {
    const plaintext = new TextEncoder().encode('secret');
    const wire = await encryptMessage(aesKey, plaintext);

    // Flip a byte in the ciphertext portion (after IV)
    const tampered = new Uint8Array(wire);
    tampered[15] = (tampered[15] ?? 0) ^ 0xff;

    await expect(decryptMessage(aesKey, tampered)).rejects.toThrow();
  });

  test('wire too short throws with descriptive message', async () => {
    await expect(decryptMessage(aesKey, new Uint8Array(27))).rejects.toThrow(
      'Wire format too short: expected at least 28 bytes, got 27',
    );
  });

  test('empty wire throws', async () => {
    await expect(decryptMessage(aesKey, new Uint8Array(0))).rejects.toThrow(
      'Wire format too short',
    );
  });
});
