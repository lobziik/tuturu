import { serve } from 'bun';
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

// Embedded static assets (bundled at compile time)
import indexHtml from '../public/index.html' with { type: 'text' };
import styles from '../public/styles.css' with { type: 'text' };
import clientJs from '../public/index.js' with { type: 'text' };

// Type assertions to ensure TypeScript treats these as strings
const indexHtmlStr = indexHtml as unknown as string;
const stylesStr = styles as unknown as string;
const clientJsStr = clientJs as unknown as string;

/**
 * Client connection information (server-side)
 * Combines ClientData with Bun's ServerWebSocket reference
 */
interface Client {
  id: string;
  pin: string;
  ws: ServerWebSocket<ClientData>;
}

/**
 * Room for PIN-based matching
 * Maximum 2 clients per room for peer-to-peer calls
 */
interface Room {
  pin: string;
  clients: Client[];
  createdAt: number;
}

/**
 * Active rooms: Map<PIN, Room>
 */
const rooms = new Map<string, Room>();

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
 * Get or create room for PIN
 */
function getOrCreateRoom(pin: string): Room {
  let room = rooms.get(pin);
  if (!room) {
    room = {
      pin,
      clients: [],
      createdAt: Date.now(),
    };
    rooms.set(pin, room);
    console.log(`[ROOM] Created room for PIN ${pin}`);
  }
  return room;
}

/**
 * Add client to room
 * FAILS if room is full (>2 clients)
 */
function addClientToRoom(room: Room, client: Client): void {
  if (room.clients.length >= 2) {
    throw new RoomFullError(room.pin);
  }
  room.clients.push(client);
  console.log(`[ROOM] Client ${client.id} joined room ${room.pin} (${room.clients.length}/2)`);
}

/**
 * Remove client from room and cleanup if empty
 */
function removeClientFromRoom(client: Client): void {
  const room = rooms.get(client.pin);
  if (!room) return;

  const index = room.clients.findIndex((c) => c.id === client.id);
  if (index !== -1) {
    room.clients.splice(index, 1);
    console.log(`[ROOM] Client ${client.id} left room ${room.pin} (${room.clients.length}/2)`);
  }

  // Notify other peer that this client left
  if (room.clients.length === 1) {
    const remaining = room.clients[0];
    if (remaining) {
      sendMessage(remaining.ws, { type: 'peer-left' });
    }
  }

  // Cleanup empty room
  if (room.clients.length === 0) {
    rooms.delete(room.pin);
    console.log(`[ROOM] Deleted empty room ${room.pin}`);
  }
}

/**
 * Get peer in the same room
 */
function getPeer(client: Client): Client | null {
  const room = rooms.get(client.pin);
  if (!room) return null;

  return room.clients.find((c) => c.id !== client.id) || null;
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

        // Add client to room (fails if full)
        addClientToRoom(room, client);

        // Send ICE server configuration
        // STUN servers from config (validated and parsed)
        const iceServers: IceServerConfig[] = config.stunServers.map((url) => ({
          urls: url,
        }));

        // Add TURN servers if configured (DPI-resistant priority order)
        if (isTurnConfigured()) {
          const domain = `turn.${config.domain}`;
          const username = config.turnUsername!;
          const credential = config.turnPassword!;

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

        sendMessage(ws, {
          type: 'join-pin',
          data: { iceServers },
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
        removeClientFromRoom(client);
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
          rooms: rooms.size,
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

    // Serve embedded static assets
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(indexHtmlStr, {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    if (url.pathname === '/styles.css') {
      return new Response(stylesStr, {
        headers: {
          'Content-Type': 'text/css',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (url.pathname === '/index.js') {
      return new Response(clientJsStr, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=3600',
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
      removeClientFromRoom(client);
    },

    // Note: Bun's WebSocket error handler removed from types in recent versions
    // Errors are handled in message/close handlers
  },
});

console.log(`
╔═══════════════════════════════════════╗
║         tuturu WebRTC Server          ║
╚═══════════════════════════════════════╝

🚀 Server running on http://localhost:${config.port}
📞 WebSocket endpoint: ws://localhost:${config.port}/ws
🏥 Health check: http://localhost:${config.port}/health
🌍 Environment: ${config.nodeEnv}

📡 STUN servers: ${config.stunServers.length} configured
${config.externalIp ? `🌐 External IP: ${config.externalIp}` : '⚠️  No EXTERNAL_IP configured'}
${isTurnConfigured() ? `✅ TURN server configured` : '⚠️  No TURN server configured (STUN only)'}

Press Ctrl+C to stop
`);

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  // Intentionally ignore the Promise; we're exiting immediately
  void server.stop();
  process.exit(0);
});
