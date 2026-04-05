/**
 * HTTP request routing.
 *
 * Handles static asset serving with ETag caching, health endpoint,
 * blob upload/download endpoints, and WebSocket upgrades.
 *
 * @module server/http
 */

import type { Server } from 'bun';
import type { LoadedAssets } from './assets';
import type { BlobStore } from './blob';
import type { ServerClientData } from './rooms';
import { isValidUuidV4 } from '../shared/validation';

/** Dependencies for the HTTP handler */
interface HttpDeps {
  assets: LoadedAssets;
  blobStore: BlobStore;
  blobMaxBytes: number;
  blobRateLimitMs: number;
  getRoomCount: () => number;
}

/**
 * Create HTTP request handler with loaded assets and blob store.
 *
 * @param deps - Handler dependencies
 * @returns Fetch handler function for Bun.serve
 */
export function createFetchHandler(deps: HttpDeps) {
  const { assets, blobStore, blobMaxBytes, blobRateLimitMs, getRoomCount } = deps;
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
    const blobMatch = url.pathname.match(/^\/api\/blob\/([^/]+)$/);
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
          uploadTimestamps,
        );
      }

      if (req.method === 'GET') {
        return handleBlobDownload(blobId, blobStore);
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // Serve embedded static assets with ETag-based caching
    if (url.pathname === '/' || url.pathname === '/index.html') {
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

    if (url.pathname === '/styles.css') {
      if (req.headers.get('If-None-Match') === etags.css) {
        return new Response(null, { status: 304 });
      }
      return new Response(text.styles, {
        headers: {
          'Content-Type': 'text/css',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: etags.css,
        },
      });
    }

    if (url.pathname === '/index.js') {
      if (req.headers.get('If-None-Match') === etags.js) {
        return new Response(null, { status: 304 });
      }
      return new Response(text.clientJs, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: etags.js,
        },
      });
    }

    // Favicon routes
    if (url.pathname === '/favicon.ico') {
      return new Response(binary.faviconIco, {
        headers: {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/favicon-16x16.png') {
      return new Response(binary.favicon16, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/favicon-32x32.png') {
      return new Response(binary.favicon32, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/apple-touch-icon.png') {
      return new Response(binary.appleTouchIcon, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/android-chrome-192x192.png') {
      return new Response(binary.androidChrome192, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/android-chrome-512x512.png') {
      return new Response(binary.androidChrome512, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/site.webmanifest') {
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

    // 404 for unknown paths
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
}

/** Handle blob upload with rate limiting and size validation */
async function handleBlobUpload(
  req: Request,
  blobId: string,
  blobMaxBytes: number,
  blobRateLimitMs: number,
  blobStore: BlobStore,
  uploadTimestamps: Map<string, number>,
): Promise<Response> {
  // Always consume the request body — Bun keeps connections alive, and an
  // unconsumed body on a keep-alive connection corrupts subsequent requests.
  const buffer = await req.arrayBuffer();

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
