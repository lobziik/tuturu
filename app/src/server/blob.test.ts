/**
 * Unit tests for filesystem BlobStore.
 * Each test uses a fresh temporary directory.
 *
 * @module server/blob.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBlobStore, type BlobStore } from './blob';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-41d8-80b4-00c04fd430c8';
const INVALID_UUID = 'not-a-uuid';

let tempDir: string;
let store: BlobStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tuturu-blob-test-'));
  store = createBlobStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('write + read', () => {
  test('binary roundtrip', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    store.write(VALID_UUID, data);
    const result = store.read(VALID_UUID);
    expect(result).toEqual(data);
  });

  test('large blob roundtrip', () => {
    const data = new Uint8Array(1024 * 1024); // 1 MB
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    store.write(VALID_UUID, data);
    const result = store.read(VALID_UUID);
    expect(result).toEqual(data);
  });

  test('overwrite existing blob', () => {
    store.write(VALID_UUID, new Uint8Array([1, 2, 3]));
    store.write(VALID_UUID, new Uint8Array([4, 5, 6]));
    const result = store.read(VALID_UUID);
    expect(result).toEqual(new Uint8Array([4, 5, 6]));
  });
});

describe('validation', () => {
  test('write with invalid UUID throws', () => {
    expect(() => store.write(INVALID_UUID, new Uint8Array([1]))).toThrow('Invalid blob ID');
  });

  test('read with invalid UUID throws', () => {
    expect(() => store.read(INVALID_UUID)).toThrow('Invalid blob ID');
  });

  test('exists with invalid UUID throws', () => {
    expect(() => store.exists(INVALID_UUID)).toThrow('Invalid blob ID');
  });
});

describe('read nonexistent', () => {
  test('read nonexistent blobId returns null', () => {
    const result = store.read(VALID_UUID);
    expect(result).toBeNull();
  });
});

describe('exists', () => {
  test('returns false before write', () => {
    expect(store.exists(VALID_UUID)).toBe(false);
  });

  test('returns true after write', () => {
    store.write(VALID_UUID, new Uint8Array([1]));
    expect(store.exists(VALID_UUID)).toBe(true);
  });
});

describe('cleanup', () => {
  test('deletes files older than retention', () => {
    store.write(VALID_UUID, new Uint8Array([1, 2, 3]));

    // Set mtime to the past (1 hour ago)
    const pastTime = new Date(Date.now() - 3_600_000);
    utimesSync(join(tempDir, VALID_UUID), pastTime, pastTime);

    // Cleanup with 30 min retention — file should be deleted
    const deleted = store.cleanup(1_800_000);
    expect(deleted).toBe(1);
    expect(store.exists(VALID_UUID)).toBe(false);
  });

  test('preserves fresh files', () => {
    store.write(VALID_UUID, new Uint8Array([1, 2, 3]));

    // Cleanup with 1 hour retention — file is fresh, should survive
    const deleted = store.cleanup(3_600_000);
    expect(deleted).toBe(0);
    expect(store.exists(VALID_UUID)).toBe(true);
  });

  test('returns correct count', () => {
    store.write(VALID_UUID, new Uint8Array([1]));
    store.write(VALID_UUID_2, new Uint8Array([2]));

    // Set both to the past
    const pastTime = new Date(Date.now() - 3_600_000);
    utimesSync(join(tempDir, VALID_UUID), pastTime, pastTime);
    utimesSync(join(tempDir, VALID_UUID_2), pastTime, pastTime);

    const deleted = store.cleanup(1_800_000);
    expect(deleted).toBe(2);
  });
});

describe('multiple blobs', () => {
  test('independent lifecycle', () => {
    store.write(VALID_UUID, new Uint8Array([1, 2, 3]));
    store.write(VALID_UUID_2, new Uint8Array([4, 5, 6]));

    expect(store.read(VALID_UUID)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.read(VALID_UUID_2)).toEqual(new Uint8Array([4, 5, 6]));

    // Delete only one via cleanup
    const pastTime = new Date(Date.now() - 3_600_000);
    utimesSync(join(tempDir, VALID_UUID), pastTime, pastTime);

    store.cleanup(1_800_000);
    expect(store.exists(VALID_UUID)).toBe(false);
    expect(store.exists(VALID_UUID_2)).toBe(true);
  });
});
