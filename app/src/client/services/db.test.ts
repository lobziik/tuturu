/**
 * Tests for IndexedDB persistence layer.
 * Uses fake-indexeddb polyfill — no browser required.
 *
 * @module client/services/db.test
 */

import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
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
  getOwnSeq,
  putOwnSeq,
  checkAndStoreMessage,
  clearAllData,
} from './db';
import type { ChatMessage } from '../../shared/types';

const TEST_ROOM = 'test-room';

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

/** Track last opened connection so we can close it before deleting the database */
let lastDB: IDBDatabase | null = null;

// Reset between tests to get a fresh database
beforeEach(() => {
  if (lastDB) lastDB.close();
  lastDB = null;
  resetDBCache();
  // Delete the database to ensure clean state
  indexedDB.deleteDatabase('tuturu');
});

afterAll(() => {
  if (lastDB) lastDB.close();
  resetDBCache();
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

  test('messages store has by_timestamp, by_deviceId, and by_roomId_timestamp indexes', async () => {
    const db = await openDB();

    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');

    expect(store.indexNames.contains('by_timestamp')).toBe(true);
    expect(store.indexNames.contains('by_deviceId')).toBe(true);
    expect(store.indexNames.contains('by_roomId_timestamp')).toBe(true);
    expect(store.keyPath).toBe('uuid');

    db.close();
  });

  test('seq store has compound keyPath [roomId, deviceId]', async () => {
    const db = await openDB();

    const tx = db.transaction('seq', 'readonly');
    const store = tx.objectStore('seq');

    expect(store.keyPath).toEqual(['roomId', 'deviceId']);

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

    await putMessage(db, TEST_ROOM, msg);
    const retrieved = await getMessage(db, 'test-uuid-1');

    expect(retrieved).toBeDefined();
    expect(retrieved!.uuid).toBe(msg.uuid);
    expect(retrieved!.text).toBe(msg.text);

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

    await putMessage(db, TEST_ROOM, msg1);
    await putMessage(db, TEST_ROOM, msg2);
    await putMessage(db, TEST_ROOM, msg3);

    const results = await getMessagesByTimestamp(db, TEST_ROOM, 4000, 10);

    expect(results.length).toBe(3);
    expect(results[0]!.uuid).toBe('u3');
    expect(results[1]!.uuid).toBe('u2');
    expect(results[2]!.uuid).toBe('u1');

    db.close();
  });

  test('getMessagesByTimestamp respects before cursor (exclusive)', async () => {
    const db = await openDB();

    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u1', timestamp: 1000 }));
    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u2', timestamp: 2000 }));
    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u3', timestamp: 3000 }));

    const results = await getMessagesByTimestamp(db, TEST_ROOM, 3000, 10);

    expect(results.length).toBe(2);
    expect(results[0]!.uuid).toBe('u2');
    expect(results[1]!.uuid).toBe('u1');

    db.close();
  });

  test('getMessagesByTimestamp respects limit', async () => {
    const db = await openDB();

    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u1', timestamp: 1000 }));
    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u2', timestamp: 2000 }));
    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u3', timestamp: 3000 }));

    const results = await getMessagesByTimestamp(db, TEST_ROOM, 4000, 2);

    expect(results.length).toBe(2);
    expect(results[0]!.uuid).toBe('u3');
    expect(results[1]!.uuid).toBe('u2');

    db.close();
  });

  test('getMessagesByTimestamp returns empty array when no matches', async () => {
    const db = await openDB();

    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u1', timestamp: 5000 }));

    const results = await getMessagesByTimestamp(db, TEST_ROOM, 1000, 10);
    expect(results.length).toBe(0);

    db.close();
  });

  test('getMessagesByTimestamp isolates messages by roomId', async () => {
    const db = await openDB();

    await putMessage(db, 'room-a', makeMessage({ uuid: 'u1', timestamp: 1000 }));
    await putMessage(db, 'room-b', makeMessage({ uuid: 'u2', timestamp: 2000 }));
    await putMessage(db, 'room-a', makeMessage({ uuid: 'u3', timestamp: 3000 }));

    const roomAMessages = await getMessagesByTimestamp(db, 'room-a', 4000, 10);
    const roomBMessages = await getMessagesByTimestamp(db, 'room-b', 4000, 10);

    expect(roomAMessages.length).toBe(2);
    expect(roomAMessages[0]!.uuid).toBe('u3');
    expect(roomAMessages[1]!.uuid).toBe('u1');

    expect(roomBMessages.length).toBe(1);
    expect(roomBMessages[0]!.uuid).toBe('u2');

    db.close();
  });

  test('clearMessages removes all messages', async () => {
    const db = await openDB();

    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u1' }));
    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'u2' }));

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

    await putMessage(db, TEST_ROOM, msg1);
    await putMessage(db, TEST_ROOM, msg2);

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
    const seq = await getLastSeenSeq(db, TEST_ROOM, 'unknown-device');

    expect(seq).toBe(0);

    db.close();
  });

  test('putLastSeenSeq + getLastSeenSeq roundtrip', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, TEST_ROOM, 'device-1', 42);
    const seq = await getLastSeenSeq(db, TEST_ROOM, 'device-1');

    expect(seq).toBe(42);

    db.close();
  });

  test('putLastSeenSeq updates existing value', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, TEST_ROOM, 'device-1', 10);
    await putLastSeenSeq(db, TEST_ROOM, 'device-1', 20);

    const seq = await getLastSeenSeq(db, TEST_ROOM, 'device-1');
    expect(seq).toBe(20);

    db.close();
  });

  test('tracks multiple devices independently', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, TEST_ROOM, 'device-a', 5);
    await putLastSeenSeq(db, TEST_ROOM, 'device-b', 10);

    expect(await getLastSeenSeq(db, TEST_ROOM, 'device-a')).toBe(5);
    expect(await getLastSeenSeq(db, TEST_ROOM, 'device-b')).toBe(10);

    db.close();
  });

  test('seq tracking is independent per room', async () => {
    const db = await openDB();

    await putLastSeenSeq(db, 'room-a', 'device-1', 5);
    await putLastSeenSeq(db, 'room-b', 'device-1', 15);

    expect(await getLastSeenSeq(db, 'room-a', 'device-1')).toBe(5);
    expect(await getLastSeenSeq(db, 'room-b', 'device-1')).toBe(15);

    db.close();
  });
});

// ============================================================================
// Own seq counter
// ============================================================================

describe('own seq counter', () => {
  test('getOwnSeq returns 0 for unknown room+device', async () => {
    const db = await openDB();
    const seq = await getOwnSeq(db, TEST_ROOM, 'device-1');

    expect(seq).toBe(0);

    db.close();
  });

  test('putOwnSeq + getOwnSeq roundtrip', async () => {
    const db = await openDB();

    await putOwnSeq(db, TEST_ROOM, 'device-1', 7);
    const seq = await getOwnSeq(db, TEST_ROOM, 'device-1');

    expect(seq).toBe(7);

    db.close();
  });

  test('own seq is independent per room', async () => {
    const db = await openDB();

    await putOwnSeq(db, 'room-a', 'device-1', 3);
    await putOwnSeq(db, 'room-b', 'device-1', 9);

    expect(await getOwnSeq(db, 'room-a', 'device-1')).toBe(3);
    expect(await getOwnSeq(db, 'room-b', 'device-1')).toBe(9);

    db.close();
  });
});

// ============================================================================
// Atomic check-and-store
// ============================================================================

describe('checkAndStoreMessage', () => {
  test('stores message and updates seq on success', async () => {
    const db = await openDB();
    const msg = makeMessage({ seq: 1, deviceId: 'dev-1' });

    const result = await checkAndStoreMessage(db, TEST_ROOM, msg);

    expect(result).toEqual({ stored: true });
    expect(await getMessage(db, msg.uuid)).toBeDefined();
    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(1);

    db.close();
  });

  test('rejects replay (seq <= lastSeenSeq)', async () => {
    const db = await openDB();
    await putLastSeenSeq(db, TEST_ROOM, 'dev-1', 5);

    const msg = makeMessage({ seq: 5, deviceId: 'dev-1' });
    const result = await checkAndStoreMessage(db, TEST_ROOM, msg);

    expect(result).toEqual({ stored: false, reason: 'replay' });
    expect(await getMessage(db, msg.uuid)).toBeUndefined();

    db.close();
  });

  test('rejects duplicate UUID', async () => {
    const db = await openDB();
    const msg1 = makeMessage({ seq: 1, uuid: 'same-uuid', deviceId: 'dev-1' });
    await checkAndStoreMessage(db, TEST_ROOM, msg1);

    const msg2 = makeMessage({ seq: 2, uuid: 'same-uuid', deviceId: 'dev-1' });
    const result = await checkAndStoreMessage(db, TEST_ROOM, msg2);

    expect(result).toEqual({ stored: false, reason: 'duplicate' });
    // seq should NOT have been updated to 2
    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(1);

    db.close();
  });

  test('replay check runs before dedup check', async () => {
    const db = await openDB();
    // Store message at seq=5
    const msg = makeMessage({ seq: 5, uuid: 'msg-uuid', deviceId: 'dev-1' });
    await checkAndStoreMessage(db, TEST_ROOM, msg);

    // Try seq=3 with same UUID — should be 'replay', not 'duplicate'
    const replay = makeMessage({ seq: 3, uuid: 'msg-uuid', deviceId: 'dev-1' });
    const result = await checkAndStoreMessage(db, TEST_ROOM, replay);

    expect(result).toEqual({ stored: false, reason: 'replay' });

    db.close();
  });

  test('tracks seq per deviceId independently', async () => {
    const db = await openDB();
    await putLastSeenSeq(db, TEST_ROOM, 'dev-1', 10);

    const msg = makeMessage({ seq: 1, deviceId: 'dev-2' });
    const result = await checkAndStoreMessage(db, TEST_ROOM, msg);

    expect(result).toEqual({ stored: true });

    db.close();
  });

  test('seq tracking is scoped to roomId', async () => {
    const db = await openDB();

    // Store message in room-a at seq=5
    const msgA = makeMessage({ seq: 5, deviceId: 'dev-1', uuid: 'uuid-a' });
    await checkAndStoreMessage(db, 'room-a', msgA);

    // Same device, seq=1 in room-b should succeed (independent seq tracking)
    const msgB = makeMessage({ seq: 1, deviceId: 'dev-1', uuid: 'uuid-b' });
    const result = await checkAndStoreMessage(db, 'room-b', msgB);

    expect(result).toEqual({ stored: true });
    expect(await getLastSeenSeq(db, 'room-a', 'dev-1')).toBe(5);
    expect(await getLastSeenSeq(db, 'room-b', 'dev-1')).toBe(1);

    db.close();
  });
});

// ============================================================================
// Bulk operations
// ============================================================================

describe('clearAllData', () => {
  test('clears all stores', async () => {
    const db = await openDB();

    await putMessage(db, TEST_ROOM, makeMessage({ uuid: 'msg-1' }));
    await putSetting(db, 'nickname', 'Alice');
    await putLastSeenSeq(db, TEST_ROOM, 'device-1', 5);

    await clearAllData(db);

    expect(await getMessage(db, 'msg-1')).toBeUndefined();
    expect(await getSetting(db, 'nickname')).toBeUndefined();
    expect(await getLastSeenSeq(db, TEST_ROOM, 'device-1')).toBe(0);

    db.close();
  });
});
