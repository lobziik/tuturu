/**
 * IndexedDB persistence layer with migration framework.
 *
 * @remarks
 * Stores:
 * - `messages` — decrypted chat messages with roomId (keyPath: uuid)
 * - `settings` — key-value pairs: nickname, deviceId (keyPath: key)
 * - `seq` — per-roomId+deviceId sequence tracking (compound keyPath: [roomId, deviceId])
 *
 * All public functions take an IDBDatabase instance for testability.
 * Use {@link openDB} for the singleton connection in production.
 *
 * @module client/services/db
 */

import { DB_NAME, DB_VERSION } from '../../shared/constants';
import type { ChatMessage, SettingRecord, SeqRecord } from '../../shared/types';

// ============================================================================
// Migration Framework
// ============================================================================

/**
 * Migration functions keyed by version number.
 * The `onupgradeneeded` handler runs migrations from (oldVersion + 1) to DB_VERSION.
 */
const migrations: Record<number, (db: IDBDatabase) => void> = {
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
      const oldVersion = event.oldVersion;
      for (let v = oldVersion + 1; v <= DB_VERSION; v++) {
        const migration = migrations[v];
        if (!migration) {
          throw new Error(
            `Missing migration for IndexedDB version ${v}. ` +
              `Available migrations: ${Object.keys(migrations).join(', ')}`,
          );
        }
        migration(db);
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
// Messages Store
// ============================================================================

/** Store a decrypted chat message scoped to a room */
export async function putMessage(
  db: IDBDatabase,
  roomId: string,
  message: ChatMessage,
): Promise<void> {
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put({ ...message, roomId });
  await promisifyTransaction(tx);
}

/** Retrieve a message by UUID, or undefined if not found */
export async function getMessage(db: IDBDatabase, uuid: string): Promise<ChatMessage | undefined> {
  const tx = db.transaction('messages', 'readonly');
  const result = await promisifyRequest(tx.objectStore('messages').get(uuid));
  return result as ChatMessage | undefined;
}

/**
 * Retrieve messages for a room ordered by timestamp (newest first), with cursor-based pagination.
 *
 * @param db - IndexedDB database connection
 * @param roomId - Room to retrieve messages for
 * @param before - Only return messages with timestamp < before (unix ms). Omit for latest.
 * @param limit - Maximum number of messages to return
 */
export async function getMessagesByTimestamp(
  db: IDBDatabase,
  roomId: string,
  before: number,
  limit: number,
): Promise<ChatMessage[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const index = tx.objectStore('messages').index('by_roomId_timestamp');

    // Compound index [roomId, timestamp]: lower bound is [roomId] (min timestamp),
    // upper bound is [roomId, before) (exclusive on timestamp)
    const range = IDBKeyRange.bound([roomId], [roomId, before], false, true);
    const request = index.openCursor(range, 'prev');

    const results: ChatMessage[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value as ChatMessage);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new DOMException('Cursor request failed'));
  });
}

/** Delete all messages from the store */
export async function clearMessages(db: IDBDatabase): Promise<void> {
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').clear();
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
export type StoreResult = { stored: true } | { stored: false; reason: 'replay' | 'duplicate' };

/**
 * Atomically check replay/dedup guards and store a message in a single readwrite transaction.
 *
 * Performs in one IDB transaction:
 * 1. Read lastSeenSeq for message.deviceId in roomId — reject if message.seq <= lastSeenSeq
 * 2. Read messages store by UUID — reject if already exists
 * 3. Write message (with roomId) + update lastSeenSeq
 *
 * This eliminates TOCTOU races when multiple messages are processed concurrently.
 */
export function checkAndStoreMessage(
  db: IDBDatabase,
  roomId: string,
  message: ChatMessage,
): Promise<StoreResult> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['messages', 'seq'], 'readwrite');
    const seqStore = tx.objectStore('seq');
    const messagesStore = tx.objectStore('messages');

    // Step 1: Read lastSeenSeq (compound key: [roomId, deviceId])
    const seqReq = seqStore.get([roomId, message.deviceId]);
    seqReq.onsuccess = () => {
      const record = seqReq.result as SeqRecord | undefined;
      const lastSeenSeq = record?.lastSeenSeq ?? 0;

      if (message.seq <= lastSeenSeq) {
        tx.abort();
        resolve({ stored: false, reason: 'replay' });
        return;
      }

      // Step 2: Check UUID dedup
      const msgReq = messagesStore.get(message.uuid);
      msgReq.onsuccess = () => {
        if (msgReq.result !== undefined) {
          tx.abort();
          resolve({ stored: false, reason: 'duplicate' });
          return;
        }

        // Step 3: Write message (with roomId) + update seq
        messagesStore.put({ ...message, roomId });
        seqStore.put({
          roomId,
          deviceId: message.deviceId,
          lastSeenSeq: message.seq,
        } satisfies SeqRecord);
        // Transaction will auto-commit; oncomplete resolves below
      };
      msgReq.onerror = () => reject(msgReq.error ?? new DOMException('Message lookup failed'));
    };
    seqReq.onerror = () => reject(seqReq.error ?? new DOMException('Sequence lookup failed'));

    tx.oncomplete = () => resolve({ stored: true });
    tx.onerror = () => reject(tx.error ?? new DOMException('Transaction failed'));
    // onabort fires for our intentional aborts — already resolved above
    tx.onabort = () => {
      // Intentional aborts (replay/duplicate) already resolved — this is a no-op for those.
      // For unexpected aborts (e.g. QuotaExceededError), this rejects the promise.
      reject(tx.error ?? new DOMException('Transaction aborted'));
    };
  });
}

// ============================================================================
// Bulk operations
// ============================================================================

/** Clear all data from all stores (messages, settings, seq) */
export async function clearAllData(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(['messages', 'settings', 'seq'], 'readwrite');
  tx.objectStore('messages').clear();
  tx.objectStore('settings').clear();
  tx.objectStore('seq').clear();
  await promisifyTransaction(tx);
}
