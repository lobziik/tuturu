/**
 * Unit tests for worker binary extraction logic.
 *
 * Tests `extractWorkerBin` (compiled-mode extraction) using real filesystem.
 * Imports from `worker-extract.ts` (not `worker-bin.ts`) to avoid triggering
 * the `import ... with { type: 'file' }` side effect that requires the
 * embedded binary to exist on disk.
 *
 * @module server/worker-bin.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractWorkerBin } from './worker-extract';

/** True when worker-bin.ts can be loaded — requires both the embedded file and the node_modules binary. */
const canLoadWorkerBin =
  existsSync(resolve(import.meta.dir, './mediasoup-worker')) &&
  existsSync(
    resolve(import.meta.dir, '../../node_modules/mediasoup/worker/out/Release/mediasoup-worker'),
  );

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tuturu-worker-bin-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('extractWorkerBin', () => {
  const FAKE_BINARY = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);

  test('extracts binary to target directory', async () => {
    const result = await extractWorkerBin(FAKE_BINARY, tempDir);

    expect(result.extracted).toBe(true);
    expect(result.path).toBe(join(tempDir, 'mediasoup-worker'));

    const written = readFileSync(result.path);
    expect(new Uint8Array(written)).toEqual(FAKE_BINARY);
  });

  test('creates target directory if missing', async () => {
    const nestedDir = join(tempDir, 'nested', 'deep');

    const result = await extractWorkerBin(FAKE_BINARY, nestedDir);

    expect(result.extracted).toBe(true);
    expect(result.path).toBe(join(nestedDir, 'mediasoup-worker'));

    const written = readFileSync(result.path);
    expect(new Uint8Array(written)).toEqual(FAKE_BINARY);
  });

  test('sets executable permission on extracted binary', async () => {
    const result = await extractWorkerBin(FAKE_BINARY, tempDir);

    const stat = statSync(result.path);
    // Check owner execute bit (0o100)
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  test('writes sidecar hash file alongside binary', async () => {
    const result = await extractWorkerBin(FAKE_BINARY, tempDir);

    const hashPath = result.path + '.hash';
    const savedHash = readFileSync(hashPath, 'utf8').trim();

    expect(savedHash.length).toBeGreaterThan(0);
    // Hash should be a hex string
    expect(savedHash).toMatch(/^[0-9a-f]+$/);
  });

  test('skips extraction when hash matches (up-to-date)', async () => {
    // First extraction
    const first = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(first.extracted).toBe(true);

    // Second extraction with same content
    const second = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(second.extracted).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test('re-extracts when binary content changes', async () => {
    const first = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(first.extracted).toBe(true);

    const updatedBinary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 5, 6, 7, 8]);
    const second = await extractWorkerBin(updatedBinary, tempDir);
    expect(second.extracted).toBe(true);

    const written = readFileSync(second.path);
    expect(new Uint8Array(written)).toEqual(updatedBinary);
  });

  test('re-extracts when hash file is missing but binary exists', async () => {
    // First extraction
    const first = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(first.extracted).toBe(true);

    // Remove sidecar hash file
    rmSync(first.path + '.hash');

    // Should re-extract because hash file is missing
    const second = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(second.extracted).toBe(true);
  });

  test('re-extracts when hash file has stale content', async () => {
    // First extraction
    const first = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(first.extracted).toBe(true);

    // Tamper with the hash file
    writeFileSync(first.path + '.hash', 'stale-hash-value');

    // Should re-extract because hash doesn't match
    const second = await extractWorkerBin(FAKE_BINARY, tempDir);
    expect(second.extracted).toBe(true);
  });

  test('updates sidecar hash after re-extraction', async () => {
    await extractWorkerBin(FAKE_BINARY, tempDir);

    const updatedBinary = new Uint8Array([9, 10, 11, 12]);
    const result = await extractWorkerBin(updatedBinary, tempDir);

    const hashPath = result.path + '.hash';
    const newHash = readFileSync(hashPath, 'utf8').trim();
    const expectedHash = Bun.hash(updatedBinary).toString(16);

    expect(newHash).toBe(expectedHash);
  });
});

describe('resolveWorkerBin (dev mode)', () => {
  // Dynamic import to avoid loading worker-bin.ts (and its embedded binary import)
  // in CI environments where the mediasoup-worker file doesn't exist.
  test.skipIf(!canLoadWorkerBin)('returns node_modules worker path in dev mode', async () => {
    const { resolveWorkerBin } = await import('./worker-bin');
    const result = await resolveWorkerBin();

    expect(result.extracted).toBe(false);
    expect(result.path).toContain('node_modules/mediasoup/worker/out/Release/mediasoup-worker');
  });
});
