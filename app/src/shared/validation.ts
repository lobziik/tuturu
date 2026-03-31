/**
 * Shared validation helpers for both client and server.
 *
 * @module shared/validation
 */

import { BLOB_MAX_BYTES } from './constants';

/** UUID v4 format: 8-4-4(version=4)-4(variant=8/9/a/b)-12 hex chars */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate that a string is a well-formed UUID v4 */
export function isValidUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** Validate that a byte count is within the allowed blob upload range */
export function isValidBlobSize(bytes: number): boolean {
  return Number.isInteger(bytes) && bytes > 0 && bytes <= BLOB_MAX_BYTES;
}
