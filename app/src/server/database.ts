/**
 * SQLite message store for persistent chat history.
 *
 * Factory function creates a MessageStore backed by bun:sqlite.
 * Uses WAL mode for concurrent reads, prepared statements for performance.
 *
 * @module server/database
 */

import { Database } from 'bun:sqlite';
import { HISTORY_BATCH_SIZE } from '../shared/constants';

/** Single history message record */
export interface HistoryRecord {
  id: number;
  blob: string;
  createdAt: number;
}

/** Result of inserting a message */
export interface InsertResult {
  id: number;
  createdAt: number;
}

/** Paginated history result */
export interface HistoryResult {
  messages: HistoryRecord[];
  hasMore: boolean;
}

/** Message store interface — all chat persistence operations */
export interface MessageStore {
  /**
   * Insert an encrypted message blob for a room.
   * @param roomId - Room identifier
   * @param blob - Encrypted message blob (base64)
   * @param createdAt - Server timestamp override (default: Date.now()). Used in tests.
   */
  insertMessage(roomId: string, blob: string, createdAt?: number): InsertResult;
  /** Fetch history with cursor-based pagination. Messages returned newest-first. */
  getHistory(roomId: string, before?: number, limit?: number): HistoryResult;
  /** Delete messages older than retentionMs. Returns number of deleted rows. */
  cleanup(retentionMs: number): number;
  /** Close the database connection. */
  close(): void;
}

/**
 * Create a MessageStore backed by SQLite.
 *
 * @param path - Database file path, or ":memory:" for in-memory (tests)
 * @param maxBatchSize - Maximum messages per history page (default: HISTORY_BATCH_SIZE)
 */
export function createDatabase(
  path: string,
  maxBatchSize: number = HISTORY_BATCH_SIZE,
): MessageStore {
  const db = new Database(path);

  // Performance pragmas
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      blob TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages (room_id, created_at DESC)
  `);

  // Prepared statements
  const insertStmt = db.prepare<
    { id: number | bigint; created_at: number },
    [string, string, number]
  >('INSERT INTO messages (room_id, blob, created_at) VALUES (?, ?, ?) RETURNING id, created_at');

  const selectNewestStmt = db.prepare<
    { id: number | bigint; blob: string; created_at: number },
    [string, number]
  >('SELECT id, blob, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?');

  const selectBeforeStmt = db.prepare<
    { id: number | bigint; blob: string; created_at: number },
    [string, number, number]
  >(
    'SELECT id, blob, created_at FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
  );

  const cleanupStmt = db.prepare<void, [number]>('DELETE FROM messages WHERE created_at < ?');

  function insertMessage(roomId: string, blob: string, createdAt?: number): InsertResult {
    const ts = createdAt ?? Date.now();
    const row = insertStmt.get(roomId, blob, ts);
    if (!row) {
      throw new Error('INSERT RETURNING failed — no row returned');
    }
    return { id: Number(row.id), createdAt: row.created_at };
  }

  function getHistory(roomId: string, before?: number, limit?: number): HistoryResult {
    // Clamp limit: non-positive → 0, undefined → maxBatchSize, excessive → maxBatchSize
    let effectiveLimit: number;
    if (limit === undefined) {
      effectiveLimit = maxBatchSize;
    } else if (limit <= 0) {
      effectiveLimit = 0;
    } else {
      effectiveLimit = Math.min(limit, maxBatchSize);
    }

    if (effectiveLimit === 0) {
      // Still need to determine hasMore for zero-limit requests
      const checkRows =
        before !== undefined
          ? selectBeforeStmt.all(roomId, before, 1)
          : selectNewestStmt.all(roomId, 1);
      return { messages: [], hasMore: checkRows.length > 0 };
    }

    // Fetch one extra to determine hasMore
    const fetchCount = effectiveLimit + 1;
    const rows =
      before !== undefined
        ? selectBeforeStmt.all(roomId, before, fetchCount)
        : selectNewestStmt.all(roomId, fetchCount);

    const hasMore = rows.length > effectiveLimit;
    const resultRows = hasMore ? rows.slice(0, effectiveLimit) : rows;

    return {
      messages: resultRows.map((r) => ({
        id: Number(r.id),
        blob: r.blob,
        createdAt: r.created_at,
      })),
      hasMore,
    };
  }

  const changesStmt = db.prepare<{ c: number }, []>('SELECT changes() as c');

  function cleanup(retentionMs: number): number {
    const threshold = Date.now() - retentionMs;
    cleanupStmt.run(threshold);
    const row = changesStmt.get();
    return row ? row.c : 0;
  }

  function close(): void {
    db.close();
  }

  return { insertMessage, getHistory, cleanup, close };
}
