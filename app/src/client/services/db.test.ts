/**
 * Tests for IndexedDB persistence layer.
 * Uses fake-indexeddb polyfill — no browser required.
 *
 * @module client/services/db.test
 */

import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  openDB,
  resetDBCache,
  putMessage,
  getMessage,
  getMessagesByTimestamp,
  clearMessages,
  putSetting,
  getSetting,
  getOrCreateDeviceId,
  getLastSeenSeq,
  putLastSeenSeq,
  clearAllData,
} from './db';
import type { ChatMessage } from '../../shared/types';

/** Build a minimal valid ChatMessage for testing */
function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    v: 1,
    deviceId: 'test-device',
    seq: 0,
    uuid: crypto.randomUUID(),
    sender: 'TestUser',
    timestamp: Date.now(),
    type: 'text',
    text: 'Hello',
    ...overrides,
  };
}

// Reset between tests to get a fresh database
beforeEach(() => {
  resetDBCache();
  // Delete the database to ensure clean state
  indexedDB.deleteDatabase('tuturu');
});

// ============================================================================
// Database initialization
// ============================================================================

describe('openDB', () => {
  test('creates database with three object stores', async () => {
    const db = await openDB();

    expect(db.objectStoreNames.contains('messages')).toBe(true);
    expect(db.objectStoreNames.contains('settings')).toBe(true);
    expect(db.objectStoreNames.contains('seq')).toBe(true);
    expect(db.objectStoreNames.length).toBe(3);

    db.close();
  });

  test('messages store has by_timestamp and by_deviceId indexes', async () => {
    const db = await openDB();

    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');

    expect(store.indexNames.contains('by_timestamp')).toBe(true);
    expect(store.indexNames.contains('by_deviceId')).toBe(true);
    expect(store.keyPath).toBe('uuid');

    db.close();
  });

  test('returns cached connection on subsequent calls', async () => {
    const db1 = await openDB();
    const db2 = await openDB();

    expect(db1).toBe(db2);

    db1.close();
  });
});

// ============================================================================
// Messages
// ============================================================================

describe('messages', () => {
  test('putMessage + getMessage roundtrip', async () => {
    const db = await openDB();
    const msg = makeMessage({ uuid: 'test-uuid-1', text: 'Hello world' });

    await putMessage(db, msg);
    const retrieved = await getMessage(db, 'test-uuid-1');

    expect(retrieved).toEqual(msg);

    db.close();
  });

  test('getMessage returns undefined for non-existent uuid', async () => {
    const db = await openDB();
    const result = await getMessage(db, 'non-existent');

    expect(result).toBeUndefined();

    db.close();
  });

  test('getMessagesByTimestamp returns messages in descending order', async () => {
    const db = await openDB();

    const msg1 = makeMessage({ uuid: 'u1', timestamp: 1000 });
    const msg2 = makeMessage({ uuid: 'u2', timestamp: 2000 });
    const msg3 = makeMessage({ uuid: 'u3', timestamp: 3000 });

    await putMessage(db, msg1);
    await putMessage(db, msg2);
    await putMessage(db, msg3);

    const results = await getMessagesByTimestamp(db, 4000, 10);

    expect(results.length).toBe(3);
    expect(results[0]!.uuid).toBe('u3');
    expect(results[1]!.uuid).toBe('u2');
    expect(results[2]!.uuid).toBe('u1');

    db.close();
  });

  test('getMessagesByTimestamp respects before cursor (exclusive)', async () => {
    const db = await openDB();

    await putMessage(db, makeMessage({ uuid: 'u1', timestamp: 1000 }));
    await putMessage(db, makeMessage({ uuid: 'u2', timestamp: 2000 }));
    await putMessage(db, makeMessage({ uuid: 'u3', timestamp: 3000 }));

    const results = await getMessagesByTimestamp(db, 3000, 10);

    expect(results.length).toBe(2);
    expect(results[0]!.uuid).toBe('u2');
    expect(results[1]!.uuid).toBe('u1');

    db.close();
  });

  test('getMessagesByTimestamp respects limit', async () => {
    const db = await openDB();

    await putMessage(db, makeMessage({ uuid: 'u1', timestamp: 1000 }));
    await putMessage(db, makeMessage({ uuid: 'u2', timestamp: 2000 }));
    await putMessage(db, makeMessage({ uuid: 'u3', timestamp: 3000 }));

    const results = await getMessagesByTimestamp(db, 4000, 2);

    expect(results.length).toBe(2);
    expect(results[0]!.uuid).toBe('u3');
    expect(results[1]!.uuid).toBe('u2');

    db.close();
  });

  test('getMessagesByTimestamp returns empty array when no matches', async () => {
    const db = await openDB();

    await putMessage(db, makeMessage({ uuid: 'u1', timestamp: 5000 }));

    const results = await getMessagesByTimestamp(db, 1000, 10);
    expect(results.length).toBe(0);

    db.close();
  });

  test('clearMessages removes all messages', async () => {
    const db = await openDB();

    await putMessage(db, makeMessage({ uuid: 'u1' }));
    await putMessage(db, makeMessage({ uuid: 'u2' }));

    await clearMessages(db);

    const result1 = await getMessage(db, 'u1');
    const result2 = await getMessage(db, 'u2');

    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();

    db.close();
  });

  test('putMessage overwrites existing message with same uuid', async () => {
    const db = await openDB();

    const msg1 = makeMessage({ uuid: 'same-uuid', text: 'original' });
    const msg2 = makeMessage({ uuid: 'same-uuid', text: 'updated' });

    await putMessage(db, msg1);
    await putMessage(db, msg2);

    const result = await getMessage(db, 'same-uuid');
    expect(result?.text).toBe('updated');

    db.close();
  });
});

// ============================================================================
// Settings
// ============================================================================

describe('settings', () => {
  test('putSetting + getSetting roundtrip', async () => {
    const db = await openDB();

    await putSetting(db, 'nickname', 'Alice');
    const result = await getSetting(db, 'nickname');

    expect(result).toBe('Alice');

    db.close();
  });

  test('getSetting returns undefined for non-existent key', async () => {
    const db = await openDB();
    const result = await getSetting(db, 'nonexistent');

    expect(result).toBeUndefined();

    db.close();
  });

  test('putSetting overwrites existing value', async () => {
    const db = await openDB();

    await putSetting(db, 'nickname', 'Alice');
    await putSetting(db, 'nickname', 'Bob');

    const result = await getSetting(db, 'nickname');
    expect(result).toBe('Bob');

    db.close();
  });
});

// ============================================================================
// Device ID
// ============================================================================

describe('getOrCreateDeviceId', () => {
  test('generates UUID on first call', async () => {
    const db = await openDB();
    const deviceId = await getOrCreateDeviceId(db);

    expect(deviceId).toBeTruthy();
    expect(typeof deviceId).toBe('string');
    // Should look like a UUID
    expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    db.close();
  });

  test('returns same value on subsequent calls', async () => {
    const db = await openDB();

    const first = await getOrCreateDeviceId(db);
    const second = await getOrCreateDeviceId(db);

    expect(first).toBe(second);

    db.close();
  });

  test('persists across database reconnections', async () => {
    const db1 = await openDB();
    const first = await getOrCreateDeviceId(db1);
    db1.close();
    resetDBCache();

    const db2 = await openDB();
    const second = await getOrCreateDeviceId(db2);

    expect(first).toBe(second);

    db2.close();
  });
});

// ============================================================================
// Sequence tracking
// ============================================================================

describe('seq tracking', () => {
  test('getLastSeenSeq returns 0 for unknown deviceId', async () => {
    const db = await openDB();
    const seq = await getLastSeenSeq(db, 'unknown-device');

    expect(seq).toBe(0);

    db.close();
  });

  test('putLastSeenSeq + getLastSeenSeq roundtrip', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, 'device-1', 42);
    const seq = await getLastSeenSeq(db, 'device-1');

    expect(seq).toBe(42);

    db.close();
  });

  test('putLastSeenSeq updates existing value', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, 'device-1', 10);
    await putLastSeenSeq(db, 'device-1', 20);

    const seq = await getLastSeenSeq(db, 'device-1');
    expect(seq).toBe(20);

    db.close();
  });

  test('tracks multiple devices independently', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, 'device-a', 5);
    await putLastSeenSeq(db, 'device-b', 10);

    expect(await getLastSeenSeq(db, 'device-a')).toBe(5);
    expect(await getLastSeenSeq(db, 'device-b')).toBe(10);

    db.close();
  });
});

// ============================================================================
// Bulk operations
// ============================================================================

describe('clearAllData', () => {
  test('clears all stores', async () => {
    const db = await openDB();

    await putMessage(db, makeMessage({ uuid: 'msg-1' }));
    await putSetting(db, 'nickname', 'Alice');
    await putLastSeenSeq(db, 'device-1', 5);

    await clearAllData(db);

    expect(await getMessage(db, 'msg-1')).toBeUndefined();
    expect(await getSetting(db, 'nickname')).toBeUndefined();
    expect(await getLastSeenSeq(db, 'device-1')).toBe(0);

    db.close();
  });
});
