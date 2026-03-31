/**
 * Key derivation and AES-256-GCM encrypt/decrypt for tuturu E2E chat.
 *
 * Key derivation pipeline:
 *   Argon2id (hash-wasm WASM) → HKDF-SHA256 (Web Crypto) → roomId + aesKey
 *
 * Encryption:
 *   AES-256-GCM with 12-byte random IV. Wire format: iv || ciphertext || authTag
 *
 * @module client/services/crypto
 */

import { argon2id } from 'hash-wasm';

// ============================================================================
// Constants
// ============================================================================

/** AES-GCM initialization vector length in bytes */
const IV_LENGTH = 12;

/** Minimum wire format length: IV (12) + auth tag (16) = 28 bytes */
const MIN_WIRE_LENGTH = IV_LENGTH + 16;

/** Argon2id memory cost in KiB (64 MB) */
const ARGON2_MEMORY_KB = 65536;

/** Argon2id iteration count (RFC 9106 recommendation for Argon2id) */
const ARGON2_ITERATIONS = 3;

/** Argon2id parallelism lanes */
const ARGON2_PARALLELISM = 1;

/** Argon2id output length in bytes (256-bit master key) */
const ARGON2_HASH_LENGTH = 32;

// ============================================================================
// Types
// ============================================================================

/** Result of key derivation from passphrase + PIN + hostname */
export interface DerivedKeys {
  /** Hex-encoded room identifier (32 hex chars = 16 bytes) */
  roomId: string;
  /** AES-256-GCM key (non-extractable CryptoKey) */
  aesKey: CryptoKey;
}

// ============================================================================
// Hex helpers
// ============================================================================

/**
 * Convert a hex string to Uint8Array.
 *
 * @throws {Error} If hex string has odd length or contains non-hex characters
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Hex string must have even length, got ${hex.length}`);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex characters at position ${i}: "${hex.substring(i, i + 2)}"`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

/** Convert Uint8Array to lowercase hex string */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// ============================================================================
// Base64 helpers
// ============================================================================

/** Encode Uint8Array to base64 string (standard alphabet, with padding) */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array.
 *
 * @throws {DOMException} If input is not valid base64
 */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive room ID and AES encryption key from user credentials.
 *
 * Pipeline:
 *   input = passphrase + ":" + pin
 *   salt  = "tuturu:" + hostname
 *   master = Argon2id(input, salt, 64MB, 3iter, 1lane) → 32 bytes
 *   roomId = HKDF-Expand-SHA256(master, info="room-id") → 16 bytes → hex
 *   aesKey = HKDF-Expand-SHA256(master, info="encryption-key") → 32 bytes → CryptoKey
 *
 * @param passphrase - User passphrase (arbitrary string, ≥3 words recommended)
 * @param pin - 6-digit PIN string
 * @param hostname - window.location.hostname (salt component)
 * @returns Room ID (hex) and non-extractable AES-256-GCM CryptoKey
 *
 * @throws {Error} If passphrase or pin is empty
 * @throws {DOMException} If Web Crypto operations fail
 */
export async function deriveKeys(
  passphrase: string,
  pin: string,
  hostname: string,
): Promise<DerivedKeys> {
  if (passphrase.length === 0) {
    throw new Error('passphrase must not be empty');
  }
  if (pin.length === 0) {
    throw new Error('pin must not be empty');
  }

  const encoder = new TextEncoder();
  const input = `${passphrase}:${pin}`;
  const salt = `tuturu:${hostname}`;

  // Step 1: Argon2id → 32-byte master key (memory-hard, slow)
  const masterHex = await argon2id({
    password: input,
    salt: encoder.encode(salt),
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KB,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'hex',
  });
  const masterBytes = hexToBytes(masterHex);

  // Step 2: Import master as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    masterBytes.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits'],
  );

  // Step 3: HKDF → room ID (16 bytes = 128 bits)
  const roomIdBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      info: encoder.encode('room-id'),
      salt: new Uint8Array(0),
    },
    hkdfKey,
    128,
  );
  const roomId = bytesToHex(new Uint8Array(roomIdBits));

  // Step 4: HKDF → AES-256 key (32 bytes = 256 bits)
  const aesKeyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      info: encoder.encode('encryption-key'),
      salt: new Uint8Array(0),
    },
    hkdfKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);

  return { roomId, aesKey };
}

// ============================================================================
// Encrypt / Decrypt
// ============================================================================

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * @param aesKey - AES-256-GCM CryptoKey from deriveKeys()
 * @param plaintext - Data to encrypt
 * @returns Wire format: iv (12 bytes) || ciphertext || authTag (16 bytes)
 */
export async function encryptMessage(
  aesKey: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext.buffer as ArrayBuffer,
  );

  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

/**
 * Decrypt wire format blob with AES-256-GCM.
 *
 * @param aesKey - AES-256-GCM CryptoKey from deriveKeys()
 * @param wire - iv (12 bytes) || ciphertext || authTag (16 bytes)
 * @returns Decrypted plaintext
 *
 * @throws {Error} If wire is too short (< 28 bytes)
 * @throws {DOMException} If decryption fails (wrong key, tampered data)
 */
export async function decryptMessage(aesKey: CryptoKey, wire: Uint8Array): Promise<Uint8Array> {
  if (wire.length < MIN_WIRE_LENGTH) {
    throw new Error(
      `Wire format too short: expected at least ${MIN_WIRE_LENGTH} bytes, got ${wire.length}`,
    );
  }

  const iv = wire.slice(0, IV_LENGTH);
  const ciphertext = wire.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext.buffer as ArrayBuffer,
  );
  return new Uint8Array(plaintext);
}
