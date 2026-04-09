/**
 * IndexedDB persistence layer with migration framework.
 *
 * @remarks
 * Stores:
 * - `settings` — key-value pairs: nickname, deviceId (keyPath: key)
 * - `seq` — per-roomId+deviceId sequence tracking (compound keyPath: [roomId, deviceId])
 * - `blobs` — encrypted wire blobs + plaintext metadata index (keyPath: uuid)
 *
 * Legacy `messages` store (plaintext) is conditionally deleted in migration v4.
 * If the store still has data (runtime migration hasn't run yet), it is kept until next upgrade.
 *
 * All public functions take an IDBDatabase instance for testability.
 * Use {@link openDB} for the singleton connection in production.
 *
 * @module client/services/db
 */

import { DB_NAME, DB_VERSION } from '../../shared/constants';
import type { ChatMessage, SettingRecord, SeqRecord, BlobRecord } from '../../shared/types';

// ============================================================================
// Migration Framework
// ============================================================================

/**
 * Migration functions keyed by version number.
 * The `onupgradeneeded` handler runs migrations from (oldVersion + 1) to DB_VERSION.
 * Each migration receives the database and the versionchange transaction for store access.
 */
const migrations: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void> = {
  1: (db) => {
    const messages = db.createObjectStore('messages', { keyPath: 'uuid' });
    messages.createIndex('by_timestamp', 'timestamp');
    messages.createIndex('by_deviceId', 'deviceId');

    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('seq', { keyPath: 'deviceId' });
  },
  2: (db) => {
    // Clean break: delete v1 stores without roomId, recreate with roomId support.
    // v2 is pre-production so no data migration is needed.
    db.deleteObjectStore('messages');
    db.deleteObjectStore('seq');

    const messages = db.createObjectStore('messages', { keyPath: 'uuid' });
    messages.createIndex('by_timestamp', 'timestamp');
    messages.createIndex('by_deviceId', 'deviceId');
    messages.createIndex('by_roomId_timestamp', ['roomId', 'timestamp']);

    db.createObjectStore('seq', { keyPath: ['roomId', 'deviceId'] });
  },
  3: (db) => {
    // Encrypted blob storage: wire blobs + plaintext metadata index.
    const blobs = db.createObjectStore('blobs', { keyPath: 'uuid' });
    blobs.createIndex('by_room_ts', ['roomId', 'timestamp']);
    blobs.createIndex('by_room_seq', ['roomId', 'deviceId', 'seq']);
  },
  4: (db, tx) => {
    // Delete legacy plaintext messages store — only if empty.
    // If the runtime data migration (migrateMessagesToBlobs) hasn't run yet,
    // the store still has data and must be kept until next app open after login.
    if (!db.objectStoreNames.contains('messages')) return;
    const store = tx.objectStore('messages');
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result === 0) {
        db.deleteObjectStore('messages');
      }
    };
  },
};

/** Cached database connection (singleton) */
let cachedDB: IDBDatabase | null = null;

/**
 * Open the IndexedDB database, running any pending migrations.
 * Returns a cached connection on subsequent calls.
 *
 * @throws {DOMException} If IndexedDB is unavailable or migration fails
 */
export function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return Promise.resolve(cachedDB);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      const oldVersion = event.oldVersion;
      for (let v = oldVersion + 1; v <= DB_VERSION; v++) {
        const migration = migrations[v];
        if (!migration) {
          throw new Error(
            `Missing migration for IndexedDB version ${v}. ` +
              `Available migrations: ${Object.keys(migrations).join(', ')}`,
          );
        }
        migration(db, tx);
      }
    };

    request.onsuccess = () => {
      cachedDB = request.result;
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new DOMException('Failed to open database'));
    };
  });
}

/**
 * Reset the cached connection. Useful for tests.
 */
export function resetDBCache(): void {
  cachedDB = null;
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Wrap an IDBRequest in a Promise */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('Request failed'));
  });
}

/** Wrap an IDBTransaction completion in a Promise */
function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new DOMException('Transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted'));
  });
}

// ============================================================================
// Blobs Store
// ============================================================================

/** Store an encrypted blob record */
export async function putBlobRecord(db: IDBDatabase, record: BlobRecord): Promise<void> {
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').put(record);
  await promisifyTransaction(tx);
}

/** Retrieve a blob record by UUID, or undefined if not found */
export async function getBlobRecord(
  db: IDBDatabase,
  uuid: string,
): Promise<BlobRecord | undefined> {
  const tx = db.transaction('blobs', 'readonly');
  const result = await promisifyRequest(tx.objectStore('blobs').get(uuid));
  return result as BlobRecord | undefined;
}

/**
 * Retrieve all blob records for a room, ordered by timestamp ascending.
 * Used for bulk decryption on room entry (cold start).
 */
export function getAllBlobs(db: IDBDatabase, roomId: string): Promise<BlobRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const index = tx.objectStore('blobs').index('by_room_ts');

    const range = IDBKeyRange.bound([roomId], [roomId, Infinity]);
    const request = index.openCursor(range, 'next');

    const results: BlobRecord[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value as BlobRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new DOMException('Cursor request failed'));
  });
}

/**
 * Retrieve blob records for a room with cursor-based pagination (newest first).
 *
 * @param db - IndexedDB database connection
 * @param roomId - Room to retrieve blobs for
 * @param before - Only return blobs with timestamp < before (unix ms)
 * @param limit - Maximum number of blobs to return
 */
export function getBlobsByTimestamp(
  db: IDBDatabase,
  roomId: string,
  before: number,
  limit: number,
): Promise<BlobRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const index = tx.objectStore('blobs').index('by_room_ts');

    const range = IDBKeyRange.bound([roomId], [roomId, before], false, true);
    const request = index.openCursor(range, 'prev');

    const results: BlobRecord[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value as BlobRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new DOMException('Cursor request failed'));
  });
}

/** Delete all blob records from the store */
export async function clearBlobs(db: IDBDatabase): Promise<void> {
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').clear();
  await promisifyTransaction(tx);
}

// ============================================================================
// Settings Store
// ============================================================================

/** Store a setting value */
export async function putSetting(db: IDBDatabase, key: string, value: string): Promise<void> {
  const record: SettingRecord = { key, value };
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(record);
  await promisifyTransaction(tx);
}

/** Retrieve a setting value, or undefined if not set */
export async function getSetting(db: IDBDatabase, key: string): Promise<string | undefined> {
  const tx = db.transaction('settings', 'readonly');
  const result = await promisifyRequest(tx.objectStore('settings').get(key));
  if (!result) return undefined;
  return (result as SettingRecord).value;
}

/**
 * Get the device ID, generating one if it doesn't exist yet.
 * Device ID is a random UUID v4 that persists across sessions.
 */
export async function getOrCreateDeviceId(db: IDBDatabase): Promise<string> {
  const existing = await getSetting(db, 'deviceId');
  if (existing) return existing;

  const deviceId = crypto.randomUUID();
  await putSetting(db, 'deviceId', deviceId);
  return deviceId;
}

// ============================================================================
// Seq Store
// ============================================================================

/**
 * Get the last seen sequence number for a deviceId in a room.
 * Returns 0 for unknown devices.
 */
export async function getLastSeenSeq(
  db: IDBDatabase,
  roomId: string,
  deviceId: string,
): Promise<number> {
  const tx = db.transaction('seq', 'readonly');
  const result = await promisifyRequest(tx.objectStore('seq').get([roomId, deviceId]));
  if (!result) return 0;
  return (result as SeqRecord).lastSeenSeq;
}

/** Update the last seen sequence number for a deviceId in a room */
export async function putLastSeenSeq(
  db: IDBDatabase,
  roomId: string,
  deviceId: string,
  seq: number,
): Promise<void> {
  const record: SeqRecord = { roomId, deviceId, lastSeenSeq: seq };
  const tx = db.transaction('seq', 'readwrite');
  tx.objectStore('seq').put(record);
  await promisifyTransaction(tx);
}

// ============================================================================
// Own Seq Counter (outgoing messages)
// ============================================================================

/**
 * Get the outgoing message sequence counter for a device in a room.
 * Stored in the settings store with key `seq:{roomId}:{deviceId}`.
 * Returns 0 if no messages have been sent from this device in this room yet.
 */
export async function getOwnSeq(
  db: IDBDatabase,
  roomId: string,
  deviceId: string,
): Promise<number> {
  const value = await getSetting(db, `seq:${roomId}:${deviceId}`);
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new TypeError(
      `Corrupt own seq counter for device ${deviceId} in room ${roomId}: "${value}"`,
    );
  }
  return parsed;
}

/** Persist the outgoing message sequence counter for a device in a room */
export async function putOwnSeq(
  db: IDBDatabase,
  roomId: string,
  deviceId: string,
  seq: number,
): Promise<void> {
  await putSetting(db, `seq:${roomId}:${deviceId}`, String(seq));
}

// ============================================================================
// Atomic compound operations
// ============================================================================

/** Result of atomic check-and-store: either stored, or rejected with reason */
type StoreResult = { stored: true } | { stored: false; reason: 'replay' | 'duplicate' };

/**
 * Atomically check replay/dedup guards and store an encrypted blob in a single readwrite transaction.
 *
 * Performs in one IDB transaction on blobs + seq stores:
 * 1. Read lastSeenSeq for message.deviceId in roomId — reject if message.seq <= lastSeenSeq
 * 2. Read blobs store by UUID — reject if already exists
 * 3. Write BlobRecord (metadata from message + wireBlob) + update lastSeenSeq
 *
 * This eliminates TOCTOU races when multiple messages are processed concurrently.
 */
export function checkAndStoreBlob(
  db: IDBDatabase,
  roomId: string,
  message: ChatMessage,
  wireBlob: Uint8Array,
): Promise<StoreResult> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['blobs', 'seq'], 'readwrite');
    const seqStore = tx.objectStore('seq');
    const blobStore = tx.objectStore('blobs');
    let intentionalAbort = false;

    // Step 1: Read lastSeenSeq (compound key: [roomId, deviceId])
    const seqReq = seqStore.get([roomId, message.deviceId]);
    seqReq.onsuccess = () => {
      const record = seqReq.result as SeqRecord | undefined;
      const lastSeenSeq = record?.lastSeenSeq ?? 0;

      if (message.seq <= lastSeenSeq) {
        intentionalAbort = true;
        tx.abort();
        resolve({ stored: false, reason: 'replay' });
        return;
      }

      // Step 2: Check UUID dedup
      const blobReq = blobStore.get(message.uuid);
      blobReq.onsuccess = () => {
        if (blobReq.result !== undefined) {
          intentionalAbort = true;
          tx.abort();
          resolve({ stored: false, reason: 'duplicate' });
          return;
        }

        // Step 3: Write BlobRecord + update seq
        const blobRecord: BlobRecord = {
          uuid: message.uuid,
          roomId,
          timestamp: message.timestamp,
          deviceId: message.deviceId,
          seq: message.seq,
          type: message.type,
          blob: wireBlob,
        };
        blobStore.put(blobRecord);
        seqStore.put({
          roomId,
          deviceId: message.deviceId,
          lastSeenSeq: message.seq,
        } satisfies SeqRecord);
        // Transaction will auto-commit; oncomplete resolves below
      };
      blobReq.onerror = () => reject(blobReq.error ?? new DOMException('Blob lookup failed'));
    };
    seqReq.onerror = () => reject(seqReq.error ?? new DOMException('Sequence lookup failed'));

    tx.oncomplete = () => resolve({ stored: true });
    tx.onerror = () => reject(tx.error ?? new DOMException('Transaction failed'));
    tx.onabort = () => {
      if (intentionalAbort) return;
      reject(tx.error ?? new DOMException('Transaction aborted'));
    };
  });
}

/**
 * Store a blob record if the UUID doesn't already exist (dedup-only, no seq check).
 * Used for history messages that have seq <= lastSeenSeq by definition.
 *
 * @returns true if stored, false if uuid already exists
 */
export function storeBlobIfNew(
  db: IDBDatabase,
  roomId: string,
  message: ChatMessage,
  wireBlob: Uint8Array,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const store = tx.objectStore('blobs');
    let alreadyExists = false;

    const getReq = store.get(message.uuid);
    getReq.onsuccess = () => {
      if (getReq.result !== undefined) {
        alreadyExists = true;
        // Let transaction complete naturally — nothing to write
        return;
      }

      const record: BlobRecord = {
        uuid: message.uuid,
        roomId,
        timestamp: message.timestamp,
        deviceId: message.deviceId,
        seq: message.seq,
        type: message.type,
        blob: wireBlob,
      };
      store.put(record);
    };
    getReq.onerror = () => reject(getReq.error ?? new DOMException('Blob lookup failed'));

    tx.oncomplete = () => resolve(!alreadyExists);
    tx.onerror = () => reject(tx.error ?? new DOMException('Transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted'));
  });
}

// ============================================================================
// Data migration (v2 plaintext → v3 encrypted blobs)
// ============================================================================

/**
 * Migrate plaintext messages from the `messages` store to encrypted blobs.
 * Three-phase approach avoids IDB transaction auto-close during async encryption:
 * 1. Phase A (readonly tx): read all plaintext records
 * 2. Phase B (no tx): encrypt each record
 * 3. Phase C (readwrite tx): write blobs + clear messages
 *
 * Safe to re-run: if messages store is empty or deleted (v4 migration), this is a no-op.
 * If interrupted, messages store still has data and migration retries on next login.
 */
export async function migrateMessagesToBlobs(db: IDBDatabase, aesKey: CryptoKey): Promise<void> {
  // messages store may have been deleted by v4 schema migration
  if (!db.objectStoreNames.contains('messages')) return;

  // Phase A: Read all plaintext messages
  const readTx = db.transaction('messages', 'readonly');
  const allRecords = await promisifyRequest(readTx.objectStore('messages').getAll());

  if (!allRecords || allRecords.length === 0) return;

  console.log(`[MIGRATION] Migrating ${allRecords.length} plaintext messages to encrypted blobs`);

  // Lazy import to avoid circular dependency (db.ts should not statically import crypto.ts)
  const { encryptMessage } = await import('./crypto');

  // Phase B: Encrypt each record (async, outside IDB transaction)
  const pairs: Array<{ record: ChatMessage & { roomId: string }; wireBlob: Uint8Array }> = [];
  for (const record of allRecords) {
    const typedRecord = record as ChatMessage & { roomId: string };
    const plaintext = new TextEncoder().encode(JSON.stringify(typedRecord));
    const wireBlob = await encryptMessage(aesKey, plaintext);
    pairs.push({ record: typedRecord, wireBlob });
  }

  // Phase C: Write all blobs + clear messages (single readwrite transaction)
  const writeTx = db.transaction(['messages', 'blobs'], 'readwrite');
  const blobStore = writeTx.objectStore('blobs');
  for (const { record, wireBlob } of pairs) {
    const blobRecord: BlobRecord = {
      uuid: record.uuid,
      roomId: record.roomId,
      timestamp: record.timestamp,
      deviceId: record.deviceId,
      seq: record.seq,
      type: record.type,
      blob: wireBlob,
    };
    blobStore.put(blobRecord);
  }
  writeTx.objectStore('messages').clear();
  await promisifyTransaction(writeTx);

  console.log(`[MIGRATION] Successfully migrated ${pairs.length} messages`);
}

// ============================================================================
// Bulk operations
// ============================================================================

/** Clear all data from all active stores */
export async function clearAllData(db: IDBDatabase): Promise<void> {
  const storeNames = Array.from(db.objectStoreNames);
  const tx = db.transaction(storeNames, 'readwrite');
  for (const name of storeNames) {
    tx.objectStore(name).clear();
  }
  await promisifyTransaction(tx);
}
