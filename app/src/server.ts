/**
 * tuturu WebRTC Signaling Server
 *
 * WebSocket-based signaling for PIN-based peer-to-peer video calls.
 * Handles room management, ICE server configuration, and WebRTC offer/answer exchange.
 */

import { serve, type BunFile } from 'bun';
import type { ServerWebSocket } from 'bun';
import {
  type ClientToServerMessage,
  type ServerToClientMessage,
  type ClientData,
  type IceServerConfig,
  InvalidPinError,
  RoomFullError,
  InvalidMessageError,
} from './types';
import { config, isTurnConfigured } from './config';
import {
  type Client,
  getOrCreateRoom,
  addClientToRoom,
  removeClientFromRoom,
  getPeer,
  getRoomCount,
  trackClientCredentials,
} from './rooms';
import {
  initTurnRedis,
  generateTurnCredentials,
  isRevocationEnabled,
  closeTurnRedis,
} from './turn';

// Embedded static assets (bundled at compile time)
import indexHtml from '../public/index.html' with { type: 'text' };
import styles from '../public/styles.css' with { type: 'text' };
import clientJs from '../public/index.js' with { type: 'text' };

// Favicon assets - embedded as BunFile in compiled mode, string path in dev mode
import webmanifest from '../public/site.webmanifest' with { type: 'text' };
import faviconIcoFile from '../public/favicon.ico' with { type: 'file' };
import favicon16File from '../public/favicon-16x16.png' with { type: 'file' };
import favicon32File from '../public/favicon-32x32.png' with { type: 'file' };
import appleTouchIconFile from '../public/apple-touch-icon.png' with { type: 'file' };
import androidChrome192File from '../public/android-chrome-192x192.png' with { type: 'file' };
import androidChrome512File from '../public/android-chrome-512x512.png' with { type: 'file' };

/**
 * Helper to read file content - handles both dev mode (string path) and compiled mode (BunFile)
 * In dev mode: import with { type: 'file' } returns a string path
 * In compiled mode: import with { type: 'file' } returns a BunFile object
 * TypeScript declares these as Blob (global.d.ts), but runtime behavior differs
 */
async function readFileContent(file: string | BunFile | Blob): Promise<ArrayBuffer> {
  if (typeof file === 'string') {
    return await Bun.file(file).arrayBuffer();
  }
  return await file.arrayBuffer();
}

// Read binary content at startup
const faviconIco = await readFileContent(faviconIcoFile);
const favicon16 = await readFileContent(favicon16File);
const favicon32 = await readFileContent(favicon32File);
const appleTouchIcon = await readFileContent(appleTouchIconFile);
const androidChrome192 = await readFileContent(androidChrome192File);
const androidChrome512 = await readFileContent(androidChrome512File);

// Type assertions to ensure TypeScript treats these as strings
const indexHtmlStr = indexHtml as unknown as string;
const stylesStr = styles as unknown as string;
const clientJsStr = clientJs as unknown as string;
const webmanifestStr = webmanifest as unknown as string;

/**
 * Generate ETags from content hashes (computed once at startup)
 * Used for cache validation - browsers send If-None-Match header
 * and server returns 304 Not Modified if content unchanged
 */
const htmlEtag = `"${Bun.hash(indexHtmlStr).toString(16)}"`;
const cssEtag = `"${Bun.hash(stylesStr).toString(16)}"`;
const jsEtag = `"${Bun.hash(clientJsStr).toString(16)}"`;
const manifestEtag = `"${Bun.hash(webmanifestStr).toString(16)}"`;

/**
 * Client ID counter for unique identification
 */
let clientIdCounter = 0;

/**
 * Validate PIN format (6 digits)
 */
function validatePin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new InvalidPinError(pin);
  }
}

/**
 * Generate unique client ID
 */
function generateClientId(): string {
  return `client-${++clientIdCounter}-${Date.now()}`;
}

/**
 * Send message to WebSocket client
 * FAILS LOUD on serialization or send errors
 * Note: Bun's ServerWebSocket doesn't expose readyState, so we rely on send() throwing if closed
 */
function sendMessage(ws: ServerWebSocket<ClientData>, message: ServerToClientMessage): void {
  try {
    const json = JSON.stringify(message);
    const result = ws.send(json);

    // Bun's send() returns a number (bytes sent) or -1 on failure
    if (result === -1) {
      throw new Error('WebSocket send failed (connection may be closed)');
    }
  } catch (error) {
    throw new Error(
      `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build ICE server configuration for WebRTC
 * Includes STUN servers and TURN servers with ephemeral credentials if configured
 */
function buildIceServers(
  room: ReturnType<typeof getOrCreateRoom>,
  clientId: string,
): IceServerConfig[] {
  // STUN servers from config (validated and parsed)
  const iceServers: IceServerConfig[] = config.stunServers.map((url) => ({
    urls: url,
  }));

  // Add TURN servers if configured (DPI-resistant priority order)
  if (isTurnConfigured()) {
    const domain = `t.${config.domain}`;

    // Generate ephemeral credentials for this client
    const { username, credential, expiresAt } = generateTurnCredentials(clientId);

    // Track credentials for revocation when client disconnects
    trackClientCredentials(room, clientId, { username, expiresAt });

    console.log(`[ICE] Generated ephemeral credentials for ${clientId}, TTL: 4h`);

    // Priority 1: TURNS on 443 (most likely to bypass DPI)
    // Routes through nginx SNI router to coturn:5349
    iceServers.push({
      urls: `turns:${domain}:443?transport=tcp`,
      username,
      credential,
    });

    // Priority 2: TURNS on standard TLS port 5349
    // Direct connection to coturn (fallback if nginx routing fails)
    iceServers.push({
      urls: `turns:${domain}:5349?transport=tcp`,
      username,
      credential,
    });

    // Priority 3: TURN TCP on 3478 (unencrypted but standard port)
    iceServers.push({
      urls: `turn:${domain}:3478?transport=tcp`,
      username,
      credential,
    });

    // Priority 4: TURN UDP on 3478 (likely blocked in restrictive networks)
    iceServers.push({
      urls: `turn:${domain}:3478?transport=udp`,
      username,
      credential,
    });

    console.log(`[ICE] Configured TURN server: ${domain} (4 transports)`);
  }

  return iceServers;
}

/**
 * Handle incoming WebSocket message
 * FAILS FAST on invalid messages
 */
function handleMessage(ws: ServerWebSocket<ClientData>, rawMessage: string | Buffer): void {
  const clientData = ws.data;

  try {
    // Parse message (validated below)
    const message = JSON.parse(rawMessage.toString()) as ClientToServerMessage;

    if (!message.type) {
      throw new InvalidMessageError('Missing message type');
    }

    console.log(`[MSG] ${clientData.id} -> ${message.type}`);

    switch (message.type) {
      case 'join-pin': {
        if (!message.pin) {
          throw new InvalidMessageError('Missing PIN in join-pin message');
        }

        // Validate PIN format
        validatePin(message.pin);

        // Get or create room
        const room = getOrCreateRoom(message.pin);

        // Update client's PIN
        clientData.pin = message.pin;

        // Create full Client object with WebSocket reference
        const client: Client = {
          ...clientData,
          ws,
        };

        // Add client to room (returns false if full)
        if (!addClientToRoom(room, client)) {
          throw new RoomFullError(room.pin);
        }

        // Build ICE server configuration with ephemeral credentials
        const iceServers = buildIceServers(room, clientData.id);

        sendMessage(ws, {
          type: 'join-pin',
          data: {
            iceServers,
            iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
          },
        });

        // Notify peer if they're already in the room
        // Only the FIRST peer (already in room) should create the offer
        const peer = getPeer(client);
        if (peer) {
          sendMessage(peer.ws, { type: 'peer-joined' });
          // Note: New peer (ws) does NOT receive peer-joined
          // They will wait for the incoming offer from the first peer
        }

        break;
      }

      case 'offer': {
        // Create full Client object to find peer
        const client: Client = {
          ...clientData,
          ws,
        };

        // Relay message to peer
        const peer = getPeer(client);
        if (!peer) {
          console.warn(`[MSG] No peer found for ${clientData.id} to relay ${message.type}`);
          return;
        }

        sendMessage(peer.ws, {
          type: 'offer',
          data: message.data,
        });

        break;
      }

      case 'answer': {
        const client: Client = {
          ...clientData,
          ws,
        };
        const peer = getPeer(client);
        if (!peer) {
          console.warn(`[MSG] No peer found for ${clientData.id} to relay ${message.type}`);
          return;
        }
        sendMessage(peer.ws, {
          type: 'answer',
          data: message.data,
        });
        break;
      }

      case 'ice-candidate': {
        const client: Client = {
          ...clientData,
          ws,
        };
        const peer = getPeer(client);
        if (!peer) {
          console.warn(`[MSG] No peer found for ${clientData.id} to relay ${message.type}`);
          return;
        }
        sendMessage(peer.ws, {
          type: 'ice-candidate',
          data: message.data,
        });
        break;
      }

      case 'leave': {
        // Create full Client object to remove from room
        const client: Client = {
          ...clientData,
          ws,
        };
        removeClientFromRoom(client, sendMessage);
        break;
      }

      default:
        throw new InvalidMessageError('Unknown message type');
    }
  } catch (error) {
    // FAIL LOUD: Send error to client and log
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${clientData.id}: ${errorMessage}`);

    // Only send error message if WebSocket is still open
    try {
      sendMessage(ws, {
        type: 'error',
        error: errorMessage,
      });
    } catch (sendError) {
      // WebSocket already closed - just log
      console.error(
        `[ERROR] Could not send error to ${clientData.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
      );
    }

    // Close connection on critical errors
    if (
      error instanceof InvalidPinError ||
      error instanceof RoomFullError ||
      error instanceof InvalidMessageError
    ) {
      try {
        ws.close(1008, errorMessage);
      } catch {
        // Connection already closed
        console.error(`[ERROR] Could not close connection for ${clientData.id}: already closed`);
      }
    }
  }
}

/**
 * Start HTTP and WebSocket server
 */
const server = serve<ClientData>({
  port: config.port,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          rooms: getRoomCount(),
          redisRevocation: isRevocationEnabled(),
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
      if (req.headers.get('If-None-Match') === htmlEtag) {
        return new Response(null, { status: 304 });
      }
      return new Response(indexHtmlStr, {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache', // Always revalidate
          ETag: htmlEtag,
        },
      });
    }

    if (url.pathname === '/styles.css') {
      if (req.headers.get('If-None-Match') === cssEtag) {
        return new Response(null, { status: 304 });
      }
      return new Response(stylesStr, {
        headers: {
          'Content-Type': 'text/css',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: cssEtag,
        },
      });
    }

    if (url.pathname === '/index.js') {
      if (req.headers.get('If-None-Match') === jsEtag) {
        return new Response(null, { status: 304 });
      }
      return new Response(clientJsStr, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: jsEtag,
        },
      });
    }

    // Favicon routes
    if (url.pathname === '/favicon.ico') {
      return new Response(faviconIco, {
        headers: {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/favicon-16x16.png') {
      return new Response(favicon16, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/favicon-32x32.png') {
      return new Response(favicon32, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/apple-touch-icon.png') {
      return new Response(appleTouchIcon, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/android-chrome-192x192.png') {
      return new Response(androidChrome192, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/android-chrome-512x512.png') {
      return new Response(androidChrome512, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    if (url.pathname === '/site.webmanifest') {
      if (req.headers.get('If-None-Match') === manifestEtag) {
        return new Response(null, { status: 304 });
      }
      return new Response(webmanifestStr, {
        headers: {
          'Content-Type': 'application/manifest+json',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: manifestEtag,
        },
      });
    }

    // 404 for unknown paths
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  },

  websocket: {
    open(ws) {
      const clientData = ws.data as ClientData;
      console.log(`[WS] Client ${clientData.id} connected`);
    },

    message(ws, message) {
      handleMessage(ws, message);
    },

    close(ws) {
      const clientData = ws.data as ClientData;
      console.log(`[WS] Client ${clientData.id} disconnected`);

      // Create full Client object to remove from room
      const client: Client = {
        ...clientData,
        ws,
      };
      removeClientFromRoom(client, sendMessage);
    },

    // Note: Bun's WebSocket error handler removed from types in recent versions
    // Errors are handled in message/close handlers
  },
});

// Initialize Redis for TURN credential revocation
await initTurnRedis();

console.log(`
╔═══════════════════════════════════════╗
║         tuturu WebRTC Server          ║
╚═══════════════════════════════════════╝

🚀 Server running on http://localhost:${config.port}
📞 WebSocket endpoint: ws://localhost:${config.port}/ws
🏥 Health check: http://localhost:${config.port}/health
🌍 Environment: ${config.nodeEnv}

📡 STUN servers: ${config.stunServers.join(', ')}
${config.externalIp ? `🌐 External IP: ${config.externalIp}` : '⚠️  No EXTERNAL_IP configured'}
${isTurnConfigured() ? `✅ TURN server configured (ephemeral credentials)` : '⚠️  No TURN server configured (STUN only)'}
${isRevocationEnabled() ? `✅ Redis connected (credential revocation enabled)` : '⚠️  Redis not available (credentials expire naturally)'}
Force relay: ${config.forceRelay ? 'enabled' : 'disabled'}

Press Ctrl+C to stop
`);

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down server...');
  await closeTurnRedis();
  void server.stop();
  process.exit(0);
});
