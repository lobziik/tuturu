/**
 * HTTP request routing.
 *
 * Handles static asset serving with ETag caching, health endpoint,
 * blob upload/download endpoints, and WebSocket upgrades.
 *
 * @module server/http
 */

import type { Server } from 'bun';
import type { LoadedAssets, TextAssets, BinaryAssets, AssetEtags } from './assets';
import type { BlobStore } from './blob';
import type { ServerClientData } from './rooms';
import { isValidUuidV4 } from '../shared/validation';

/** Dependencies for the HTTP handler */
interface HttpDeps {
  assets: LoadedAssets;
  blobStore: BlobStore;
  blobMaxBytes: number;
  blobRateLimitMs: number;
  /** Optional bearer token for blob uploads. When absent, uploads are disabled. */
  blobUploadToken: string | undefined;
  getRoomCount: () => number;
}

const BLOB_PATTERN = /^\/api\/blob\/([^/]+)$/;

/**
 * Create HTTP request handler with loaded assets and blob store.
 *
 * @param deps - Handler dependencies
 * @returns Fetch handler function for Bun.serve
 */
export function createFetchHandler(deps: HttpDeps) {
  const { assets, blobStore, blobMaxBytes, blobRateLimitMs, blobUploadToken, getRoomCount } = deps;
  const { text, binary, etags } = assets;

  /** Rate limiter: IP → last upload timestamp */
  const uploadTimestamps = new Map<string, number>();

  return function fetch(
    req: Request,
    server: Server<ServerClientData>,
  ): Response | Promise<Response> | undefined {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          rooms: getRoomCount(),
          timestamp: Date.now(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, {
        data: {
          peerId: crypto.randomUUID(),
          roomId: null,
        } satisfies ServerClientData,
      });

      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return undefined;
    }

    // Blob endpoints: POST /api/blob/{blobId} and GET /api/blob/{blobId}
    const blobMatch = BLOB_PATTERN.exec(url.pathname);
    if (blobMatch) {
      const blobId = blobMatch[1]!;

      if (!isValidUuidV4(blobId)) {
        return new Response(JSON.stringify({ error: 'Invalid blob ID — must be UUID v4' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (req.method === 'POST') {
        return handleBlobUpload(
          req,
          blobId,
          blobMaxBytes,
          blobRateLimitMs,
          blobStore,
          blobUploadToken,
          uploadTimestamps,
        );
      }

      if (req.method === 'GET') {
        return handleBlobDownload(blobId, blobStore);
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // Static assets (extracted to reduce cognitive complexity)
    return serveStaticAsset(url.pathname, req, text, binary, etags);
  };
}

/**
 * Serve embedded static assets with ETag-based caching.
 *
 * @returns Response for known assets, or 404
 */
function serveStaticAsset(
  pathname: string,
  req: Request,
  text: TextAssets,
  binary: BinaryAssets,
  etags: AssetEtags,
): Response {
  if (pathname === '/' || pathname === '/index.html') {
    if (req.headers.get('If-None-Match') === etags.html) {
      return new Response(null, { status: 304 });
    }
    return new Response(text.indexHtml, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
        ETag: etags.html,
      },
    });
  }

  if (pathname === '/styles.css') {
    if (req.headers.get('If-None-Match') === etags.css) {
      return new Response(null, { status: 304 });
    }
    return new Response(text.styles, {
      headers: {
        'Content-Type': 'text/css',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etags.css,
      },
    });
  }

  if (pathname === '/index.js') {
    if (req.headers.get('If-None-Match') === etags.js) {
      return new Response(null, { status: 304 });
    }
    return new Response(text.clientJs, {
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etags.js,
      },
    });
  }

  if (pathname === '/e2ee-worker.js') {
    if (req.headers.get('If-None-Match') === etags.e2eeWorkerJs) {
      return new Response(null, { status: 304 });
    }
    return new Response(text.e2eeWorkerJs, {
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etags.e2eeWorkerJs,
      },
    });
  }

  if (pathname === '/site.webmanifest') {
    if (req.headers.get('If-None-Match') === etags.manifest) {
      return new Response(null, { status: 304 });
    }
    return new Response(text.webmanifest, {
      headers: {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        ETag: etags.manifest,
      },
    });
  }

  // Binary assets (favicons, icons) — long cache, no ETag
  const binaryRoutes: Record<string, { body: ArrayBuffer; contentType: string }> = {
    '/favicon.ico': { body: binary.faviconIco, contentType: 'image/x-icon' },
    '/favicon-16x16.png': { body: binary.favicon16, contentType: 'image/png' },
    '/favicon-32x32.png': { body: binary.favicon32, contentType: 'image/png' },
    '/apple-touch-icon.png': { body: binary.appleTouchIcon, contentType: 'image/png' },
    '/android-chrome-192x192.png': { body: binary.androidChrome192, contentType: 'image/png' },
    '/android-chrome-512x512.png': { body: binary.androidChrome512, contentType: 'image/png' },
  };

  const binaryAsset = binaryRoutes[pathname];
  if (binaryAsset) {
    return new Response(binaryAsset.body, {
      headers: {
        'Content-Type': binaryAsset.contentType,
        'Cache-Control': 'public, max-age=604800',
      },
    });
  }

  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/** Handle blob upload with token auth, rate limiting, and size validation */
async function handleBlobUpload(
  req: Request,
  blobId: string,
  blobMaxBytes: number,
  blobRateLimitMs: number,
  blobStore: BlobStore,
  uploadToken: string | undefined,
  uploadTimestamps: Map<string, number>,
): Promise<Response> {
  // Always consume the request body — Bun keeps connections alive, and an
  // unconsumed body on a keep-alive connection corrupts subsequent requests.
  const buffer = await req.arrayBuffer();

  if (!uploadToken) {
    return new Response(JSON.stringify({ error: 'Blob upload is disabled' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (authHeader !== `Bearer ${uploadToken}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (buffer.byteLength > blobMaxBytes) {
    return new Response(JSON.stringify({ error: 'Blob too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limit by IP
  const ip = req.headers.get('X-Forwarded-For') ?? req.headers.get('X-Real-IP') ?? 'unknown';
  const now = Date.now();
  const lastUpload = uploadTimestamps.get(ip);
  if (lastUpload && now - lastUpload < blobRateLimitMs) {
    return new Response(JSON.stringify({ error: 'Rate limited — try again later' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  uploadTimestamps.set(ip, now);

  blobStore.write(blobId, new Uint8Array(buffer));
  return new Response(null, { status: 201 });
}

/** Handle blob download */
function handleBlobDownload(blobId: string, blobStore: BlobStore): Response {
  const data = blobStore.read(blobId);
  if (!data) {
    return new Response(JSON.stringify({ error: 'Blob not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(data.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}
