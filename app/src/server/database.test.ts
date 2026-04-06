/**
 * Unit tests for SQLite MessageStore.
 * All tests use in-memory database (":memory:") — no filesystem needed.
 *
 * @module server/database.test
 */

import { describe, test, expect } from 'bun:test';
import { createDatabase } from './database';

const BASE_TIME = 1700000000000;

describe('createDatabase', () => {
  test('insertMessage returns id and createdAt', () => {
    const db = createDatabase(':memory:');
    const result = db.insertMessage('room-1', 'blob-data');
    expect(result.id).toBeGreaterThan(0);
    expect(result.createdAt).toBeGreaterThan(0);
    db.close();
  });

  test('insertMessage with explicit timestamp', () => {
    const db = createDatabase(':memory:');
    const result = db.insertMessage('room-1', 'blob', BASE_TIME);
    expect(result.createdAt).toBe(BASE_TIME);
    db.close();
  });

  test('insertMessage + getHistory roundtrip', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'hello-blob', BASE_TIME);
    const history = db.getHistory('room-1');
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.blob).toBe('hello-blob');
    expect(history.messages[0]!.createdAt).toBe(BASE_TIME);
    expect(history.hasMore).toBe(false);
    db.close();
  });

  test('messages returned newest-first', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'msg-1', BASE_TIME);
    db.insertMessage('room-1', 'msg-2', BASE_TIME + 1000);
    db.insertMessage('room-1', 'msg-3', BASE_TIME + 2000);

    const history = db.getHistory('room-1');
    expect(history.messages.map((m) => m.blob)).toEqual(['msg-3', 'msg-2', 'msg-1']);
    db.close();
  });
});

describe('cursor pagination', () => {
  test('paginate 15 messages with batch size 5 — 3 pages', () => {
    const db = createDatabase(':memory:', 5);

    // Insert 15 messages with distinct timestamps
    for (let i = 0; i < 15; i++) {
      db.insertMessage('room-1', `msg-${i}`, BASE_TIME + i * 1000);
    }

    // Page 1: newest 5
    const page1 = db.getHistory('room-1');
    expect(page1.messages).toHaveLength(5);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages[0]!.blob).toBe('msg-14');
    expect(page1.messages[4]!.blob).toBe('msg-10');

    // Page 2: next 5 (before oldest id of page 1)
    const cursor1 = page1.messages[4]!.id;
    const page2 = db.getHistory('room-1', cursor1);
    expect(page2.messages).toHaveLength(5);
    expect(page2.hasMore).toBe(true);
    expect(page2.messages[0]!.blob).toBe('msg-9');
    expect(page2.messages[4]!.blob).toBe('msg-5');

    // Page 3: last 5
    const cursor2 = page2.messages[4]!.id;
    const page3 = db.getHistory('room-1', cursor2);
    expect(page3.messages).toHaveLength(5);
    expect(page3.hasMore).toBe(false);
    expect(page3.messages[0]!.blob).toBe('msg-4');
    expect(page3.messages[4]!.blob).toBe('msg-0');

    // No duplicates across pages
    const allBlobs = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.blob);
    expect(new Set(allBlobs).size).toBe(15);

    db.close();
  });

  test('pagination with custom limit', () => {
    const db = createDatabase(':memory:', 100);
    for (let i = 0; i < 10; i++) {
      db.insertMessage('room-1', `msg-${i}`, BASE_TIME + i * 1000);
    }

    const page = db.getHistory('room-1', undefined, 3);
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.messages[0]!.blob).toBe('msg-9');
    db.close();
  });

  test('before cursor with large id returns all messages', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'msg-1', BASE_TIME);
    const history = db.getHistory('room-1', 999999);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.blob).toBe('msg-1');
    db.close();
  });
});

describe('TTL cleanup', () => {
  test('cleanup deletes old messages', () => {
    const db = createDatabase(':memory:');
    // Insert messages at different times
    db.insertMessage('room-1', 'old-msg', BASE_TIME);
    db.insertMessage('room-1', 'new-msg', BASE_TIME + 10_000);

    // Cleanup with threshold that only deletes the old message
    // retentionMs such that threshold = now - retentionMs > BASE_TIME but < BASE_TIME + 10000
    // We inserted at BASE_TIME and BASE_TIME+10000. Cleanup deletes where created_at < Date.now() - retentionMs.
    // Since Date.now() >> BASE_TIME, let's use a small retentionMs so threshold > both messages,
    // then verify both are deleted. Or use a large retentionMs and verify none are deleted.

    // Better approach: cleanup threshold = Date.now() - retentionMs
    // If retentionMs = 0, threshold = Date.now() which is >> BASE_TIME + 10000, deletes all
    const deleted = db.cleanup(0);
    expect(deleted).toBe(2);
    expect(db.getHistory('room-1').messages).toHaveLength(0);
    db.close();
  });

  test('cleanup preserves recent messages', () => {
    const db = createDatabase(':memory:');
    const now = Date.now();
    db.insertMessage('room-1', 'recent-msg', now);

    // retentionMs = 1 hour — threshold = now - 3600000, recent message survives
    const deleted = db.cleanup(3_600_000);
    expect(deleted).toBe(0);
    expect(db.getHistory('room-1').messages).toHaveLength(1);
    db.close();
  });

  test('cleanup returns correct count', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'msg-1', BASE_TIME);
    db.insertMessage('room-1', 'msg-2', BASE_TIME + 1000);
    db.insertMessage('room-1', 'msg-3', BASE_TIME + 2000);

    // All 3 are old (BASE_TIME << Date.now()), retentionMs=0 deletes all
    const deleted = db.cleanup(0);
    expect(deleted).toBe(3);
    db.close();
  });
});

describe('edge cases', () => {
  test('empty room returns empty history with hasMore: false', () => {
    const db = createDatabase(':memory:');
    const history = db.getHistory('nonexistent-room');
    expect(history.messages).toHaveLength(0);
    expect(history.hasMore).toBe(false);
    db.close();
  });

  test('limit 0 returns empty result', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'msg', BASE_TIME);
    const history = db.getHistory('room-1', undefined, 0);
    expect(history.messages).toHaveLength(0);
    expect(history.hasMore).toBe(true);
    db.close();
  });

  test('negative limit treated as 0', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-1', 'msg', BASE_TIME);
    const history = db.getHistory('room-1', undefined, -5);
    expect(history.messages).toHaveLength(0);
    expect(history.hasMore).toBe(true);
    db.close();
  });

  test('excessive limit clamped to maxBatchSize', () => {
    const db = createDatabase(':memory:', 5);
    for (let i = 0; i < 10; i++) {
      db.insertMessage('room-1', `msg-${i}`, BASE_TIME + i * 1000);
    }
    const history = db.getHistory('room-1', undefined, 999999);
    expect(history.messages).toHaveLength(5);
    expect(history.hasMore).toBe(true);
    db.close();
  });

  test('multiple rooms have isolated histories', () => {
    const db = createDatabase(':memory:');
    db.insertMessage('room-A', 'msg-A', BASE_TIME);
    db.insertMessage('room-B', 'msg-B', BASE_TIME + 1000);

    const historyA = db.getHistory('room-A');
    expect(historyA.messages).toHaveLength(1);
    expect(historyA.messages[0]!.blob).toBe('msg-A');

    const historyB = db.getHistory('room-B');
    expect(historyB.messages).toHaveLength(1);
    expect(historyB.messages[0]!.blob).toBe('msg-B');
    db.close();
  });

  test('close() does not throw', () => {
    const db = createDatabase(':memory:');
    expect(() => db.close()).not.toThrow();
  });
});
