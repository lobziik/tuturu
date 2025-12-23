/**
 * HTTP request routing
 *
 * Handles static asset serving with ETag caching, health endpoint, and WebSocket upgrades.
 */

import type { Server } from 'bun';
import type { ClientData } from '../types';
import type { LoadedAssets } from './assets';
import { getRoomCount } from './rooms';
import { generateClientId } from './websocket';

/**
 * Create HTTP request handler with loaded assets.
 *
 * @param assets - Loaded static assets
 * @returns Fetch handler function for Bun.serve
 */
export function createFetchHandler(assets: LoadedAssets) {
  const { text, binary, etags } = assets;

  return function fetch(req: Request, server: Server<ClientData>): Response | undefined {
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
          id: generateClientId(),
          pin: '',
        } as ClientData,
      });

      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return undefined;
    }

    // Serve embedded static assets with ETag-based caching
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Return 304 Not Modified if content unchanged
      if (req.headers.get('If-None-Match') === etags.html) {
        return new Response(null, { status: 304 });
      }
      return new Response(text.indexHtml, {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache', // Always revalidate
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
