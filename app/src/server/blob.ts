/**
 * Filesystem-backed blob storage for encrypted photo uploads.
 *
 * Files stored flat in a single directory, named by UUID v4.
 * Cleanup deletes files older than the retention period by mtime.
 *
 * @module server/blob
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isValidUuidV4 } from '../shared/validation';

/** Blob store interface — encrypted file storage operations */
export interface BlobStore {
  /** Write blob data to disk. Throws if blobId is not a valid UUID v4. */
  write(blobId: string, data: Uint8Array): void;
  /** Read blob data from disk. Returns null if not found. Throws if blobId is invalid. */
  read(blobId: string): Uint8Array | null;
  /** Check if a blob exists. Throws if blobId is invalid. */
  exists(blobId: string): boolean;
  /** Delete blobs older than retentionMs (by mtime). Returns number of deleted files. */
  cleanup(retentionMs: number): number;
}

/**
 * Validate blobId format. Throws on invalid UUID v4.
 *
 * @throws Error if blobId is not a valid UUID v4
 */
function assertValidBlobId(blobId: string): void {
  if (!isValidUuidV4(blobId)) {
    throw new Error(`Invalid blob ID: ${blobId} — must be UUID v4`);
  }
}

/**
 * Create a BlobStore backed by the filesystem.
 *
 * @param dir - Directory path for blob storage. Created if it doesn't exist.
 */
export function createBlobStore(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true });

  function blobPath(blobId: string): string {
    return join(dir, blobId);
  }

  function write(blobId: string, data: Uint8Array): void {
    assertValidBlobId(blobId);
    writeFileSync(blobPath(blobId), data);
  }

  function read(blobId: string): Uint8Array | null {
    assertValidBlobId(blobId);
    try {
      return new Uint8Array(readFileSync(blobPath(blobId)));
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  function exists(blobId: string): boolean {
    assertValidBlobId(blobId);
    try {
      statSync(blobPath(blobId));
      return true;
    } catch {
      return false;
    }
  }

  function cleanup(retentionMs: number): number {
    const threshold = Date.now() - retentionMs;
    let deleted = 0;

    for (const name of readdirSync(dir)) {
      try {
        const filePath = join(dir, name);
        const stat = statSync(filePath);
        if (stat.mtimeMs < threshold) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // File may have been deleted concurrently — skip
      }
    }

    return deleted;
  }

  return { write, read, exists, cleanup };
}
