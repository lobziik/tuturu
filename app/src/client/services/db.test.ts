/**
 * Tests for IndexedDB persistence layer.
 * Uses fake-indexeddb polyfill — no browser required.
 *
 * @module client/services/db.test
 */

import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import {
  openDB,
  resetDBCache,
  putSetting,
  getSetting,
  getOrCreateDeviceId,
  getLastSeenSeq,
  putLastSeenSeq,
  getOwnSeq,
  putOwnSeq,
  clearAllData,
  putBlobRecord,
  getBlobRecord,
  getAllBlobs,
  getBlobsByTimestamp,
  clearBlobs,
  checkAndStoreBlob,
  storeBlobIfNew,
  migrateMessagesToBlobs,
} from './db';
import { encryptMessage, deriveKeys } from './crypto';
import { decryptBlobRecord } from './chatProtocol';
import type { ChatMessage, BlobRecord } from '../../shared/types';

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
  test('creates database with three object stores (messages deleted in v4 on fresh install)', async () => {
    const db = await openDB();

    // Fresh install: messages store is created (v1/v2) then deleted (v4, empty)
    expect(db.objectStoreNames.contains('messages')).toBe(false);
    expect(db.objectStoreNames.contains('settings')).toBe(true);
    expect(db.objectStoreNames.contains('seq')).toBe(true);
    expect(db.objectStoreNames.contains('blobs')).toBe(true);
    expect(db.objectStoreNames.length).toBe(3);

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
// Bulk operations
// ============================================================================

describe('clearAllData', () => {
  test('clears all stores including blobs', async () => {
    const db = await openDB();

    await putSetting(db, 'nickname', 'Alice');
    await putLastSeenSeq(db, TEST_ROOM, 'device-1', 5);
    await putBlobRecord(db, makeBlobRecord({ uuid: 'blob-1' }));

    await clearAllData(db);

    expect(await getSetting(db, 'nickname')).toBeUndefined();
    expect(await getLastSeenSeq(db, TEST_ROOM, 'device-1')).toBe(0);
    expect(await getBlobRecord(db, 'blob-1')).toBeUndefined();

    db.close();
  });
});

// ============================================================================
// Blobs Store
// ============================================================================

/** Build a minimal BlobRecord for testing */
function makeBlobRecord(overrides: Partial<BlobRecord> = {}): BlobRecord {
  return {
    uuid: crypto.randomUUID(),
    roomId: TEST_ROOM,
    timestamp: Date.now(),
    deviceId: 'test-device',
    seq: 1,
    type: 'text',
    blob: new Uint8Array([1, 2, 3, 4, 5]),
    ...overrides,
  };
}

describe('blobs store schema', () => {
  test('blobs store has uuid keyPath and expected indexes', async () => {
    const db = await openDB();

    const tx = db.transaction('blobs', 'readonly');
    const store = tx.objectStore('blobs');

    expect(store.keyPath).toBe('uuid');
    expect(store.indexNames.contains('by_room_ts')).toBe(true);
    expect(store.indexNames.contains('by_room_seq')).toBe(true);

    db.close();
  });
});

describe('putBlobRecord / getBlobRecord', () => {
  test('roundtrip stores and retrieves blob record', async () => {
    const db = await openDB();
    const record = makeBlobRecord({ uuid: 'blob-1', seq: 3 });

    await putBlobRecord(db, record);
    const retrieved = await getBlobRecord(db, 'blob-1');

    expect(retrieved).toBeDefined();
    expect(retrieved!.uuid).toBe('blob-1');
    expect(retrieved!.roomId).toBe(TEST_ROOM);
    expect(retrieved!.seq).toBe(3);
    expect(retrieved!.blob).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    db.close();
  });

  test('getBlobRecord returns undefined for non-existent uuid', async () => {
    const db = await openDB();
    const result = await getBlobRecord(db, 'nonexistent');
    expect(result).toBeUndefined();
    db.close();
  });
});

describe('getAllBlobs', () => {
  test('returns records ordered by timestamp ascending', async () => {
    const db = await openDB();

    await putBlobRecord(db, makeBlobRecord({ uuid: 'b1', timestamp: 3000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b2', timestamp: 1000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b3', timestamp: 2000 }));

    const results = await getAllBlobs(db, TEST_ROOM);

    expect(results.length).toBe(3);
    expect(results[0]!.uuid).toBe('b2');
    expect(results[1]!.uuid).toBe('b3');
    expect(results[2]!.uuid).toBe('b1');

    db.close();
  });

  test('filters by roomId', async () => {
    const db = await openDB();

    await putBlobRecord(db, makeBlobRecord({ uuid: 'b1', roomId: 'room-a' }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b2', roomId: 'room-b' }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b3', roomId: 'room-a' }));

    const results = await getAllBlobs(db, 'room-a');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.roomId === 'room-a')).toBe(true);

    db.close();
  });

  test('returns empty array for unknown roomId', async () => {
    const db = await openDB();
    const results = await getAllBlobs(db, 'nonexistent-room');
    expect(results).toEqual([]);
    db.close();
  });
});

describe('getBlobsByTimestamp', () => {
  test('returns records in descending order with cursor and limit', async () => {
    const db = await openDB();

    await putBlobRecord(db, makeBlobRecord({ uuid: 'b1', timestamp: 1000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b2', timestamp: 2000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b3', timestamp: 3000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b4', timestamp: 4000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b5', timestamp: 5000 }));

    // before=5000 (exclusive), limit=2 → should get b4, b3
    const results = await getBlobsByTimestamp(db, TEST_ROOM, 5000, 2);

    expect(results.length).toBe(2);
    expect(results[0]!.uuid).toBe('b4');
    expect(results[1]!.uuid).toBe('b3');

    db.close();
  });

  test('filters by roomId', async () => {
    const db = await openDB();

    await putBlobRecord(db, makeBlobRecord({ uuid: 'b1', roomId: 'room-a', timestamp: 1000 }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b2', roomId: 'room-b', timestamp: 2000 }));

    const results = await getBlobsByTimestamp(db, 'room-a', 9999, 10);
    expect(results.length).toBe(1);
    expect(results[0]!.uuid).toBe('b1');

    db.close();
  });
});

describe('clearBlobs', () => {
  test('removes all blob records', async () => {
    const db = await openDB();

    await putBlobRecord(db, makeBlobRecord({ uuid: 'b1' }));
    await putBlobRecord(db, makeBlobRecord({ uuid: 'b2' }));

    await clearBlobs(db);

    expect(await getBlobRecord(db, 'b1')).toBeUndefined();
    expect(await getBlobRecord(db, 'b2')).toBeUndefined();

    db.close();
  });
});

// ============================================================================
// Atomic check-and-store (blobs)
// ============================================================================

describe('checkAndStoreBlob', () => {
  test('stores blob and updates seq on success', async () => {
    const db = await openDB();
    const msg = makeMessage({ seq: 1, deviceId: 'dev-1' });
    const wireBlob = new Uint8Array([10, 20, 30]);

    const result = await checkAndStoreBlob(db, TEST_ROOM, msg, wireBlob);

    expect(result).toEqual({ stored: true });
    const stored = await getBlobRecord(db, msg.uuid);
    expect(stored).toBeDefined();
    expect(stored!.blob).toEqual(wireBlob);
    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(1);

    db.close();
  });

  test('rejects replay (seq <= lastSeenSeq)', async () => {
    const db = await openDB();
    await putLastSeenSeq(db, TEST_ROOM, 'dev-1', 5);

    const msg = makeMessage({ seq: 5, deviceId: 'dev-1' });
    const result = await checkAndStoreBlob(db, TEST_ROOM, msg, new Uint8Array([1]));

    expect(result).toEqual({ stored: false, reason: 'replay' });
    expect(await getBlobRecord(db, msg.uuid)).toBeUndefined();

    db.close();
  });

  test('rejects duplicate UUID', async () => {
    const db = await openDB();
    const msg1 = makeMessage({ seq: 1, uuid: 'same-uuid', deviceId: 'dev-1' });
    await checkAndStoreBlob(db, TEST_ROOM, msg1, new Uint8Array([1]));

    const msg2 = makeMessage({ seq: 2, uuid: 'same-uuid', deviceId: 'dev-1' });
    const result = await checkAndStoreBlob(db, TEST_ROOM, msg2, new Uint8Array([2]));

    expect(result).toEqual({ stored: false, reason: 'duplicate' });
    // seq should NOT have been updated to 2
    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(1);

    db.close();
  });

  test('seq advances across multiple calls', async () => {
    const db = await openDB();

    const msg1 = makeMessage({ seq: 1, deviceId: 'dev-1' });
    await checkAndStoreBlob(db, TEST_ROOM, msg1, new Uint8Array([1]));

    const msg2 = makeMessage({ seq: 2, deviceId: 'dev-1' });
    await checkAndStoreBlob(db, TEST_ROOM, msg2, new Uint8Array([2]));

    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(2);

    // seq=1 should now be rejected as replay
    const msg3 = makeMessage({ seq: 1, deviceId: 'dev-1' });
    const result = await checkAndStoreBlob(db, TEST_ROOM, msg3, new Uint8Array([3]));
    expect(result).toEqual({ stored: false, reason: 'replay' });

    db.close();
  });

  test('atomicity: reject leaves no trace', async () => {
    const db = await openDB();
    await putLastSeenSeq(db, TEST_ROOM, 'dev-1', 5);

    const msg = makeMessage({ seq: 3, deviceId: 'dev-1' });
    await checkAndStoreBlob(db, TEST_ROOM, msg, new Uint8Array([1]));

    // Neither blob nor seq should be changed
    expect(await getBlobRecord(db, msg.uuid)).toBeUndefined();
    expect(await getLastSeenSeq(db, TEST_ROOM, 'dev-1')).toBe(5);

    db.close();
  });
});

describe('storeBlobIfNew', () => {
  test('stores new blob and returns true', async () => {
    const db = await openDB();
    const msg = makeMessage({ seq: 1 });
    const wireBlob = new Uint8Array([10, 20, 30]);

    const result = await storeBlobIfNew(db, TEST_ROOM, msg, wireBlob);

    expect(result).toBe(true);
    const stored = await getBlobRecord(db, msg.uuid);
    expect(stored).toBeDefined();
    expect(stored!.blob).toEqual(wireBlob);

    db.close();
  });

  test('returns false for existing uuid without overwriting', async () => {
    const db = await openDB();
    const msg = makeMessage({ seq: 1 });
    const originalBlob = new Uint8Array([1, 2, 3]);
    const newBlob = new Uint8Array([4, 5, 6]);

    await storeBlobIfNew(db, TEST_ROOM, msg, originalBlob);
    const result = await storeBlobIfNew(db, TEST_ROOM, msg, newBlob);

    expect(result).toBe(false);
    const stored = await getBlobRecord(db, msg.uuid);
    expect(stored!.blob).toEqual(originalBlob);

    db.close();
  });

  test('does NOT check seq — stores even when seq <= lastSeenSeq', async () => {
    const db = await openDB();
    await putLastSeenSeq(db, TEST_ROOM, 'test-device', 10);

    const msg = makeMessage({ seq: 3, deviceId: 'test-device' });
    const result = await storeBlobIfNew(db, TEST_ROOM, msg, new Uint8Array([1]));

    expect(result).toBe(true);
    expect(await getBlobRecord(db, msg.uuid)).toBeDefined();

    db.close();
  });
});

// ============================================================================
// Data migration (v2 plaintext → encrypted blobs)
// ============================================================================

let testKey: CryptoKey;

beforeAll(async () => {
  const keys = await deriveKeys('test phrase', '000000', 'localhost');
  testKey = keys.aesKey;
});

/**
 * Open a v3 database (with messages store) for migration testing.
 * Simulates the v2→v3 upgrade path where messages store still exists with data.
 */
function openV3WithMessages(
  dbName: string,
  messages: Array<ChatMessage & { roomId: string }>,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1+v2: create messages + settings + seq
      if (!db.objectStoreNames.contains('messages')) {
        const msgs = db.createObjectStore('messages', { keyPath: 'uuid' });
        msgs.createIndex('by_timestamp', 'timestamp');
        msgs.createIndex('by_deviceId', 'deviceId');
        msgs.createIndex('by_roomId_timestamp', ['roomId', 'timestamp']);
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('seq')) {
        db.createObjectStore('seq', { keyPath: ['roomId', 'deviceId'] });
      }
      // v3: create blobs
      if (!db.objectStoreNames.contains('blobs')) {
        const blobs = db.createObjectStore('blobs', { keyPath: 'uuid' });
        blobs.createIndex('by_room_ts', ['roomId', 'timestamp']);
        blobs.createIndex('by_room_seq', ['roomId', 'deviceId', 'seq']);
      }
      // Pre-populate messages store
      const store = request.transaction!.objectStore('messages');
      for (const msg of messages) {
        store.put(msg);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('Failed to open v3 db'));
  });
}

describe('migrateMessagesToBlobs', () => {
  const MIGRATE_DB = 'tuturu-migrate-test';

  beforeEach(() => {
    indexedDB.deleteDatabase(MIGRATE_DB);
  });

  test('migrates plaintext messages to encrypted blobs', async () => {
    const msg1 = {
      ...makeMessage({ uuid: 'migrate-1', seq: 1, timestamp: 1000 }),
      roomId: TEST_ROOM,
    };
    const msg2 = {
      ...makeMessage({ uuid: 'migrate-2', seq: 2, timestamp: 2000 }),
      roomId: TEST_ROOM,
    };
    const db = await openV3WithMessages(MIGRATE_DB, [msg1, msg2]);

    await migrateMessagesToBlobs(db, testKey);

    // messages store should be empty
    const checkTx = db.transaction('messages', 'readonly');
    const count = await new Promise<number>((resolve, reject) => {
      const req = checkTx.objectStore('messages').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(count).toBe(0);

    // blobs store should have encrypted records
    const blob1 = await getBlobRecord(db, 'migrate-1');
    const blob2 = await getBlobRecord(db, 'migrate-2');
    expect(blob1).toBeDefined();
    expect(blob2).toBeDefined();
    expect(blob1!.roomId).toBe(TEST_ROOM);
    expect(blob1!.deviceId).toBe(msg1.deviceId);

    // Decrypt should yield original message
    const decrypted = await decryptBlobRecord(testKey, blob1!);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.uuid).toBe(msg1.uuid);
    expect(decrypted!.text).toBe(msg1.text);

    db.close();
  });

  test('no-op when messages store does not exist', async () => {
    const db = await openDB();

    // Fresh v4 db — messages store deleted. Should not throw.
    await migrateMessagesToBlobs(db, testKey);

    const blobs = await getAllBlobs(db, TEST_ROOM);
    expect(blobs).toEqual([]);

    db.close();
  });

  test('no-op when messages store is empty', async () => {
    const db = await openV3WithMessages(MIGRATE_DB, []);

    await migrateMessagesToBlobs(db, testKey);

    const blobs = await getAllBlobs(db, TEST_ROOM);
    expect(blobs).toEqual([]);

    db.close();
  });

  test('idempotent — second call is no-op', async () => {
    const msg = { ...makeMessage({ uuid: 'idem-1', seq: 1 }), roomId: TEST_ROOM };
    const db = await openV3WithMessages(MIGRATE_DB, [msg]);

    await migrateMessagesToBlobs(db, testKey);
    await migrateMessagesToBlobs(db, testKey);

    const blobs = await getAllBlobs(db, TEST_ROOM);
    expect(blobs.length).toBe(1);

    db.close();
  });
});

describe('v4 schema migration', () => {
  test('deletes messages store when empty on fresh install', async () => {
    const db = await openDB();
    expect(db.objectStoreNames.contains('messages')).toBe(false);
    db.close();
  });

  test('keeps messages store when it has data (v2→v4 upgrade)', async () => {
    const UPGRADE_DB = 'tuturu-v2-upgrade-test';
    indexedDB.deleteDatabase(UPGRADE_DB);

    const msg = { ...makeMessage({ uuid: 'keep-1', seq: 1 }), roomId: TEST_ROOM };
    const db = await openV3WithMessages(UPGRADE_DB, [msg]);
    // This is a v3 db with messages data — simulates user who hasn't logged in yet
    expect(db.objectStoreNames.contains('messages')).toBe(true);
    db.close();

    // Now "upgrade" to v4 — messages store has data, should be kept
    const db4 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(UPGRADE_DB, 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction!;
        if (db.objectStoreNames.contains('messages')) {
          const store = tx.objectStore('messages');
          const countReq = store.count();
          countReq.onsuccess = () => {
            if (countReq.result === 0) {
              db.deleteObjectStore('messages');
            }
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(db4.objectStoreNames.contains('messages')).toBe(true);
    db4.close();
    indexedDB.deleteDatabase(UPGRADE_DB);
  });
});

// ============================================================================
// Round-trip integration test
// ============================================================================

describe('encrypt → store → load → decrypt round-trip', () => {
  test('full cycle preserves message content', async () => {
    const db = await openDB();

    const msg = makeMessage({ seq: 1, text: 'Hello encrypted world' });
    const plaintext = new TextEncoder().encode(JSON.stringify(msg));
    const wireBlob = await encryptMessage(testKey, plaintext);

    const storeResult = await checkAndStoreBlob(db, TEST_ROOM, msg, wireBlob);
    expect(storeResult).toEqual({ stored: true });

    const blobs = await getAllBlobs(db, TEST_ROOM);
    expect(blobs.length).toBe(1);

    const decrypted = await decryptBlobRecord(testKey, blobs[0]!);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.uuid).toBe(msg.uuid);
    expect(decrypted!.text).toBe('Hello encrypted world');
    expect(decrypted!.deviceId).toBe(msg.deviceId);
    expect(decrypted!.seq).toBe(msg.seq);

    db.close();
  });
});
