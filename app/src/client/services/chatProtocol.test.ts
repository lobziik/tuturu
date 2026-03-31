/**
 * Tests for chat protocol handler: decrypt → validate → dedup → store pipeline.
 *
 * @remarks
 * Uses fake-indexeddb polyfill for IndexedDB. Key derivation runs once in
 * beforeAll (Argon2id is slow). Each test gets a fresh database via beforeEach.
 *
 * @module client/services/chatProtocol.test
 */

import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import type { ChatMessage } from '../../shared/types';
import { handleIncomingMessage } from './chatProtocol';
import { encryptMessage, toBase64, deriveKeys } from './crypto';
import { openDB, resetDBCache, putLastSeenSeq, getMessage, getLastSeenSeq } from './db';

// ============================================================================
// Test helpers
// ============================================================================

let testKey: CryptoKey;
let wrongKey: CryptoKey;

beforeAll(async () => {
  const keys = await deriveKeys('test phrase', '000000', 'localhost');
  testKey = keys.aesKey;

  const otherKeys = await deriveKeys('other phrase', '999999', 'localhost');
  wrongKey = otherKeys.aesKey;
});

/** Encrypt a message object into a base64 blob string */
async function makeBlob(msg: Record<string, unknown>, key: CryptoKey = testKey): Promise<string> {
  const json = JSON.stringify(msg);
  const plaintext = new TextEncoder().encode(json);
  const wire = await encryptMessage(key, plaintext);
  return toBase64(wire);
}

/** Build a minimal valid ChatMessage for testing */
function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    v: 1,
    deviceId: 'device-aaa',
    seq: 1,
    uuid: crypto.randomUUID(),
    sender: 'Alice',
    timestamp: Date.now(),
    type: 'text',
    text: 'Hello',
    ...overrides,
  };
}

let db: IDBDatabase;

beforeEach(async () => {
  // Close previous connection before deleting — deleteDatabase blocks on open connections
  if (db) db.close();
  resetDBCache();
  indexedDB.deleteDatabase('tuturu');
  db = await openDB();
});

afterAll(() => {
  if (db) db.close();
  resetDBCache();
});

// ============================================================================
// Happy path
// ============================================================================

describe('handleIncomingMessage — happy path', () => {
  test('returns ok for valid message', async () => {
    const msg = makeMessage();
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);

    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.message.uuid).toBe(msg.uuid);
      expect(result.message.text).toBe('Hello');
      expect(result.message.sender).toBe('Alice');
    }
  });

  test('stores message in IndexedDB on success', async () => {
    const msg = makeMessage();
    const blob = await makeBlob(msg);
    await handleIncomingMessage(blob, testKey, db);

    const stored = await getMessage(db, msg.uuid);
    expect(stored).toBeDefined();
    expect(stored!.text).toBe('Hello');
  });

  test('updates lastSeenSeq on success', async () => {
    const msg = makeMessage({ seq: 5 });
    const blob = await makeBlob(msg);
    await handleIncomingMessage(blob, testKey, db);

    const seq = await getLastSeenSeq(db, msg.deviceId);
    expect(seq).toBe(5);
  });

  test('accepts photo message type', async () => {
    const msg = makeMessage({
      type: 'photo',
      text: undefined,
      blobId: crypto.randomUUID(),
      size: 1024,
    });
    // Remove text field entirely for photo messages
    const raw = { ...msg } as Record<string, unknown>;
    delete raw['text'];
    const blob = await makeBlob(raw);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('ok');
  });

  test('accepts seq gap (e.g., 1 → 5)', async () => {
    const msg1 = makeMessage({ seq: 1 });
    await handleIncomingMessage(await makeBlob(msg1), testKey, db);

    // seq jumps to 5 — server may have dropped messages, but that's OK
    const msg5 = makeMessage({ seq: 5 });
    const result = await handleIncomingMessage(await makeBlob(msg5), testKey, db);
    expect(result.type).toBe('ok');
  });
});

// ============================================================================
// Decrypt errors
// ============================================================================

describe('handleIncomingMessage — decrypt errors', () => {
  test('returns decrypt-error for wrong key', async () => {
    const msg = makeMessage();
    const blob = await makeBlob(msg, wrongKey);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('decrypt-error');
  });

  test('returns decrypt-error for invalid base64', async () => {
    const result = await handleIncomingMessage('not!valid!base64!!!', testKey, db);
    expect(result.type).toBe('decrypt-error');
  });

  test('returns decrypt-error for truncated ciphertext', async () => {
    const msg = makeMessage();
    const blob = await makeBlob(msg);
    const truncated = blob.substring(0, 10);
    const result = await handleIncomingMessage(truncated, testKey, db);
    expect(result.type).toBe('decrypt-error');
  });

  test('returns decrypt-error for empty string', async () => {
    const result = await handleIncomingMessage('', testKey, db);
    expect(result.type).toBe('decrypt-error');
  });
});

// ============================================================================
// Parse errors
// ============================================================================

describe('handleIncomingMessage — parse errors', () => {
  test('returns parse-error for non-JSON plaintext', async () => {
    const wire = await encryptMessage(testKey, new TextEncoder().encode('not json'));
    const blob = toBase64(wire);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('parse-error');
  });

  test('returns parse-error for JSON that fails schema validation', async () => {
    const blob = await makeBlob({ v: 1, garbage: true });
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('parse-error');
  });

  test('returns parse-error for missing required fields', async () => {
    const blob = await makeBlob({ v: 1, deviceId: 'x', seq: 1 });
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('parse-error');
  });
});

// ============================================================================
// Unknown version
// ============================================================================

describe('handleIncomingMessage — unknown version', () => {
  test('returns unknown-version for v: 2', async () => {
    const msg = { ...makeMessage(), v: 2 };
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('unknown-version');
    if (result.type === 'unknown-version') {
      expect(result.v).toBe(2);
    }
  });

  test('returns unknown-version for v: 99', async () => {
    const msg = { ...makeMessage(), v: 99 };
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('unknown-version');
    if (result.type === 'unknown-version') {
      expect(result.v).toBe(99);
    }
  });

  test('does not return unknown-version for v: 1 (current version)', async () => {
    const msg = makeMessage();
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).not.toBe('unknown-version');
  });
});

// ============================================================================
// Replay detection
// ============================================================================

describe('handleIncomingMessage — replay detection', () => {
  test('returns replay when seq equals lastSeenSeq', async () => {
    await putLastSeenSeq(db, 'device-aaa', 5);
    const msg = makeMessage({ seq: 5, deviceId: 'device-aaa' });
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('replay');
  });

  test('returns replay when seq < lastSeenSeq', async () => {
    await putLastSeenSeq(db, 'device-aaa', 10);
    const msg = makeMessage({ seq: 3, deviceId: 'device-aaa' });
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('replay');
  });

  test('accepts message with seq > lastSeenSeq', async () => {
    await putLastSeenSeq(db, 'device-aaa', 5);
    const msg = makeMessage({ seq: 6, deviceId: 'device-aaa' });
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('ok');
  });

  test('tracks seq per deviceId independently', async () => {
    await putLastSeenSeq(db, 'device-aaa', 10);

    // Different device with seq=1 should be accepted
    const msg = makeMessage({ seq: 1, deviceId: 'device-bbb' });
    const blob = await makeBlob(msg);
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('ok');
  });

  test('does not store message on replay', async () => {
    await putLastSeenSeq(db, 'device-aaa', 5);
    const msg = makeMessage({ seq: 3, deviceId: 'device-aaa' });
    const blob = await makeBlob(msg);
    await handleIncomingMessage(blob, testKey, db);

    const stored = await getMessage(db, msg.uuid);
    expect(stored).toBeUndefined();
  });
});

// ============================================================================
// Deduplication
// ============================================================================

describe('handleIncomingMessage — deduplication', () => {
  test('returns duplicate for already-stored UUID', async () => {
    const msg = makeMessage({ seq: 1 });
    const blob = await makeBlob(msg);

    // First: ok
    const first = await handleIncomingMessage(blob, testKey, db);
    expect(first.type).toBe('ok');

    // Second: same UUID but higher seq — duplicate
    const msg2 = { ...msg, seq: 2 };
    const blob2 = await makeBlob(msg2);
    const second = await handleIncomingMessage(blob2, testKey, db);
    expect(second.type).toBe('duplicate');
  });

  test('accepts different UUID with same content', async () => {
    const msg1 = makeMessage({ seq: 1, text: 'same text' });
    await handleIncomingMessage(await makeBlob(msg1), testKey, db);

    const msg2 = makeMessage({ seq: 2, text: 'same text' }); // different uuid (randomUUID)
    const result = await handleIncomingMessage(await makeBlob(msg2), testKey, db);
    expect(result.type).toBe('ok');
  });
});

// ============================================================================
// Pipeline ordering
// ============================================================================

describe('handleIncomingMessage — pipeline ordering', () => {
  test('decrypt error takes priority over everything', async () => {
    // Even if the "message" would have other issues, decrypt error comes first
    const result = await handleIncomingMessage('garbage', testKey, db);
    expect(result.type).toBe('decrypt-error');
  });

  test('version check happens before schema validation', async () => {
    // v=2 with invalid schema fields — should get unknown-version, not parse-error
    const blob = await makeBlob({ v: 2, garbage: true });
    const result = await handleIncomingMessage(blob, testKey, db);
    expect(result.type).toBe('unknown-version');
  });

  test('replay check happens before dedup check', async () => {
    // Store a message at seq=5
    const msg = makeMessage({ seq: 5, deviceId: 'device-aaa' });
    await handleIncomingMessage(await makeBlob(msg), testKey, db);

    // Now set lastSeenSeq to 10 (simulating more messages received)
    await putLastSeenSeq(db, 'device-aaa', 10);

    // Send same UUID with seq=3 — should be replay (not duplicate)
    // because replay check runs before dedup check
    const msg2 = { ...msg, seq: 3 };
    const blob2 = await makeBlob(msg2);
    const result = await handleIncomingMessage(blob2, testKey, db);
    expect(result.type).toBe('replay');
  });
});
