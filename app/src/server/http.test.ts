/**
 * Unit tests for the HTTP request handler.
 *
 * Tests static asset serving, ETag caching, health endpoint,
 * blob upload/download with auth and rate limiting.
 *
 * @module server/http.test
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import type { Server } from 'bun';
import type { LoadedAssets } from './assets';
import type { BlobStore } from './blob';
import type { ServerClientData } from './rooms';
import { createFetchHandler } from './http';

// ============================================================================
// Mock factories
// ============================================================================

function createMockAssets(): LoadedAssets {
  return {
    text: {
      indexHtml: '<html>test</html>',
      styles: 'body { color: red; }',
      clientJs: 'console.log("test");',
      e2eeWorkerJs: 'self.onmessage = () => {};',
      webmanifest: '{"name":"test"}',
    },
    binary: {
      faviconIco: new ArrayBuffer(4),
      favicon16: new ArrayBuffer(4),
      favicon32: new ArrayBuffer(4),
      appleTouchIcon: new ArrayBuffer(4),
      androidChrome192: new ArrayBuffer(4),
      androidChrome512: new ArrayBuffer(4),
    },
    etags: {
      html: '"html-hash"',
      css: '"css-hash"',
      js: '"js-hash"',
      e2eeWorkerJs: '"e2ee-hash"',
      manifest: '"manifest-hash"',
    },
  };
}

function createMockBlobStore(): BlobStore & { _has(blobId: string): boolean } {
  const blobs = new Map<string, Uint8Array>();
  return {
    write(blobId: string, data: Uint8Array) {
      blobs.set(blobId, data);
    },
    read(blobId: string): Uint8Array | null {
      return blobs.get(blobId) ?? null;
    },
    exists(blobId: string): boolean {
      return blobs.has(blobId);
    },
    cleanup(): number {
      return 0;
    },
    _has(blobId: string): boolean {
      return blobs.has(blobId);
    },
  };
}

const MOCK_SERVER = {} as Server<ServerClientData>;
const BLOB_TOKEN = 'test-token-123';
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

let handler: ReturnType<typeof createFetchHandler>;
let blobStore: BlobStore;

beforeEach(() => {
  blobStore = createMockBlobStore();
  handler = createFetchHandler({
    assets: createMockAssets(),
    blobStore,
    blobMaxBytes: 1024,
    blobRateLimitMs: 1000,
    blobUploadToken: BLOB_TOKEN,
    getRoomCount: () => 3,
  });
});

// ============================================================================
// Static assets
// ============================================================================

describe('static assets', () => {
  test('GET / returns HTML', () => {
    const req = new Request('http://localhost/');
    const res = handler(req, MOCK_SERVER);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
    expect((res as Response).headers.get('Content-Type')).toBe('text/html');
    expect((res as Response).headers.get('ETag')).toBe('"html-hash"');
    expect((res as Response).headers.get('Cache-Control')).toBe('no-cache');
  });

  test('GET /styles.css returns CSS with immutable cache', () => {
    const req = new Request('http://localhost/styles.css');
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('GET /e2ee-worker.js returns JS with ETag', () => {
    const req = new Request('http://localhost/e2ee-worker.js');
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    expect(res.headers.get('ETag')).toBe('"e2ee-hash"');
  });

  test('GET / with matching ETag returns 304', () => {
    const req = new Request('http://localhost/', {
      headers: { 'If-None-Match': '"html-hash"' },
    });
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(304);
  });

  test('GET /favicon.ico returns binary', () => {
    const req = new Request('http://localhost/favicon.ico');
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/x-icon');
  });

  test('GET /nonexistent returns 404', () => {
    const req = new Request('http://localhost/nonexistent');
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Health endpoint
// ============================================================================

describe('health endpoint', () => {
  test('GET /health returns JSON with status and rooms', async () => {
    const req = new Request('http://localhost/health');
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.rooms).toBe(3);
    expect(typeof body.timestamp).toBe('number');
  });
});

// ============================================================================
// Blob endpoints
// ============================================================================

describe('blob endpoints', () => {
  test('POST /api/blob/{uuid} with valid auth creates blob', async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'POST',
      body: data,
      headers: { Authorization: `Bearer ${BLOB_TOKEN}` },
    });
    const res = (await handler(req, MOCK_SERVER)) as Response;
    expect(res.status).toBe(201);
    expect(blobStore.exists(VALID_UUID)).toBe(true);
  });

  test('POST /api/blob/{uuid} without token returns 403 when no upload token configured', async () => {
    const noTokenHandler = createFetchHandler({
      assets: createMockAssets(),
      blobStore,
      blobMaxBytes: 1024,
      blobRateLimitMs: 1000,
      blobUploadToken: undefined,
      getRoomCount: () => 0,
    });
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'POST',
      body: new Uint8Array([1]),
      headers: { Authorization: 'Bearer anything' },
    });
    const res = (await noTokenHandler(req, MOCK_SERVER)) as Response;
    expect(res.status).toBe(403);
  });

  test('POST /api/blob/{uuid} with wrong token returns 401', async () => {
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'POST',
      body: new Uint8Array([1]),
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const res = (await handler(req, MOCK_SERVER)) as Response;
    expect(res.status).toBe(401);
  });

  test('POST /api/blob/{uuid} with oversized body returns 413', async () => {
    const bigData = new Uint8Array(2048); // exceeds blobMaxBytes=1024
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'POST',
      body: bigData,
      headers: { Authorization: `Bearer ${BLOB_TOKEN}` },
    });
    const res = (await handler(req, MOCK_SERVER)) as Response;
    expect(res.status).toBe(413);
  });

  test('POST /api/blob/not-a-uuid returns 400', async () => {
    const req = new Request('http://localhost/api/blob/not-a-uuid', {
      method: 'POST',
      body: new Uint8Array([1]),
    });
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(400);
  });

  test('GET /api/blob/{uuid} returns stored blob', async () => {
    blobStore.write(VALID_UUID, new Uint8Array([10, 20, 30]));
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`);
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    const data = new Uint8Array(await res.arrayBuffer());
    expect(data).toEqual(new Uint8Array([10, 20, 30]));
  });

  test('GET /api/blob/{uuid} for nonexistent blob returns 404', () => {
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`);
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(404);
  });

  test('DELETE /api/blob/{uuid} returns 405', () => {
    const req = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'DELETE',
    });
    const res = handler(req, MOCK_SERVER) as Response;
    expect(res.status).toBe(405);
  });

  test('POST /api/blob/{uuid} rate limiting returns 429', async () => {
    // First upload succeeds
    const req1 = new Request(`http://localhost/api/blob/${VALID_UUID}`, {
      method: 'POST',
      body: new Uint8Array([1]),
      headers: { Authorization: `Bearer ${BLOB_TOKEN}`, 'X-Real-IP': '1.2.3.4' },
    });
    const res1 = (await handler(req1, MOCK_SERVER)) as Response;
    expect(res1.status).toBe(201);

    // Second upload from same IP within rate window returns 429
    const uuid2 = '550e8400-e29b-41d4-a716-446655440001';
    const req2 = new Request(`http://localhost/api/blob/${uuid2}`, {
      method: 'POST',
      body: new Uint8Array([2]),
      headers: { Authorization: `Bearer ${BLOB_TOKEN}`, 'X-Real-IP': '1.2.3.4' },
    });
    const res2 = (await handler(req2, MOCK_SERVER)) as Response;
    expect(res2.status).toBe(429);
  });
});
