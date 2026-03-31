/**
 * Tests for shared validation helpers
 *
 * @module shared/validation.test
 */

import { describe, test, expect } from 'bun:test';
import { isValidUuidV4, isValidBlobSize } from './validation';
import { BLOB_MAX_BYTES } from './constants';

describe('isValidUuidV4', () => {
  test('accepts valid UUID v4', () => {
    expect(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUuidV4('6ba7b810-9dad-41d0-80b4-00c04fd430c8')).toBe(true);
    expect(isValidUuidV4('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
  });

  test('accepts uppercase hex', () => {
    expect(isValidUuidV4('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  test('rejects UUID v1 (version digit != 4)', () => {
    // v1: third group starts with 1
    expect(isValidUuidV4('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  test('rejects UUID v3 (version digit != 4)', () => {
    expect(isValidUuidV4('550e8400-e29b-31d4-a716-446655440000')).toBe(false);
  });

  test('rejects UUID v5 (version digit != 4)', () => {
    expect(isValidUuidV4('550e8400-e29b-51d4-a716-446655440000')).toBe(false);
  });

  test('rejects invalid variant digit', () => {
    // Variant must be 8, 9, a, or b in position 19
    expect(isValidUuidV4('550e8400-e29b-41d4-0716-446655440000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-41d4-f716-446655440000')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidUuidV4('')).toBe(false);
  });

  test('rejects random string', () => {
    expect(isValidUuidV4('not-a-uuid')).toBe(false);
  });

  test('rejects UUID without dashes', () => {
    expect(isValidUuidV4('550e8400e29b41d4a716446655440000')).toBe(false);
  });

  test('rejects UUID with wrong length', () => {
    expect(isValidUuidV4('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-41d4-a716-4466554400000')).toBe(false);
  });
});

describe('isValidBlobSize', () => {
  test('accepts 1 byte', () => {
    expect(isValidBlobSize(1)).toBe(true);
  });

  test('accepts maximum size', () => {
    expect(isValidBlobSize(BLOB_MAX_BYTES)).toBe(true);
  });

  test('accepts typical photo size', () => {
    expect(isValidBlobSize(5_000_000)).toBe(true);
  });

  test('rejects 0 bytes', () => {
    expect(isValidBlobSize(0)).toBe(false);
  });

  test('rejects negative bytes', () => {
    expect(isValidBlobSize(-1)).toBe(false);
  });

  test('rejects over maximum', () => {
    expect(isValidBlobSize(BLOB_MAX_BYTES + 1)).toBe(false);
  });

  test('rejects non-integer', () => {
    expect(isValidBlobSize(1.5)).toBe(false);
  });

  test('rejects NaN', () => {
    expect(isValidBlobSize(NaN)).toBe(false);
  });

  test('rejects Infinity', () => {
    expect(isValidBlobSize(Infinity)).toBe(false);
  });
});
