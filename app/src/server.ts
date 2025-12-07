import { serve, file } from 'bun';
import type { ServerWebSocket } from 'bun';
import {
  type Message,
  type Client,
  type Room,
  type ServerConfig,
  type IceServerConfig,
  InvalidPinError,
  RoomFullError,
  InvalidMessageError,
} from './types';

/**
 * Server configuration from environment variables
 */
const config: ServerConfig = {
  port: parseInt(process.env.BUN_PORT || '3000'),
  turnUsername: process.env.TURN_USERNAME,
  turnPassword: process.env.TURN_PASSWORD,
  turnRealm: process.env.TURN_REALM,
  externalIp: process.env.EXTERNAL_IP,
};

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
    sendMessage(room.clients[0].ws, { type: 'peer-left' });
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
 * FAILS LOUD on serialization errors
 */
function sendMessage(ws: ServerWebSocket<Client>, message: Message): void {
  try {
    const json = JSON.stringify(message);
    ws.send(json);
  } catch (error) {
    throw new Error(`Failed to serialize message: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle incoming WebSocket message
 * FAILS FAST on invalid messages
 */
function handleMessage(ws: ServerWebSocket<Client>, rawMessage: string | Buffer): void {
  const client = ws.data;

  try {
    // Parse message
    const message: Message = JSON.parse(rawMessage.toString());

    if (!message.type) {
      throw new InvalidMessageError('Missing message type');
    }

    console.log(`[MSG] ${client.id} -> ${message.type}`);

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
        client.pin = message.pin;

        // Add client to room (fails if full)
        addClientToRoom(room, client);

        // Send ICE server configuration
        const iceServers: IceServerConfig[] = [
          { urls: 'stun:stun.l.google.com:19302' },
        ];

        // Add TURN server if configured
        if (config.turnUsername && config.turnPassword && config.externalIp) {
          iceServers.push({
            urls: [
              `turn:${config.externalIp}:3478?transport=udp`,
              `turn:${config.externalIp}:3478?transport=tcp`,
            ],
            username: config.turnUsername,
            credential: config.turnPassword,
          });
        }

        sendMessage(ws, {
          type: 'join-pin',
          data: { iceServers },
        });

        // Notify peer if they're already in the room
        const peer = getPeer(client);
        if (peer) {
          sendMessage(peer.ws, { type: 'peer-joined' });
          sendMessage(ws, { type: 'peer-joined' });
        }

        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay message to peer
        const peer = getPeer(client);
        if (!peer) {
          console.warn(`[MSG] No peer found for ${client.id} to relay ${message.type}`);
          return;
        }

        sendMessage(peer.ws, {
          type: message.type,
          data: message.data,
        });

        break;
      }

      case 'leave': {
        removeClientFromRoom(client);
        break;
      }

      default:
        throw new InvalidMessageError(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    // FAIL LOUD: Send error to client and log
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${client.id}: ${errorMessage}`);

    sendMessage(ws, {
      type: 'error',
      error: errorMessage,
    });

    // Close connection on critical errors
    if (
      error instanceof InvalidPinError ||
      error instanceof RoomFullError ||
      error instanceof InvalidMessageError
    ) {
      ws.close(1008, errorMessage);
    }
  }
}

/**
 * Start HTTP and WebSocket server
 */
const server = serve({
  port: config.port,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        timestamp: Date.now(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, {
        data: {
          id: generateClientId(),
          pin: '',
        } as Omit<Client, 'ws'>,
      });

      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return undefined;
    }

    // Serve static files from public/
    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    return new Response(file(`./public${filePath}`));
  },

  websocket: {
    open(ws) {
      const client = ws.data as Client;
      console.log(`[WS] Client ${client.id} connected`);
    },

    message(ws, message) {
      handleMessage(ws, message);
    },

    close(ws) {
      const client = ws.data as Client;
      console.log(`[WS] Client ${client.id} disconnected`);
      removeClientFromRoom(client);
    },

    error(ws, error) {
      const client = ws.data as Client;
      console.error(`[WS ERROR] Client ${client.id}:`, error);
      removeClientFromRoom(client);
    },
  },
});

console.log(`
╔═══════════════════════════════════════╗
║         tuturu WebRTC Server          ║
╚═══════════════════════════════════════╝

🚀 Server running on http://localhost:${config.port}
📞 WebSocket endpoint: ws://localhost:${config.port}/ws
🏥 Health check: http://localhost:${config.port}/health

${config.externalIp ? `🌐 External IP: ${config.externalIp}` : '⚠️  No EXTERNAL_IP configured'}
${config.turnUsername ? `✅ TURN server configured` : '⚠️  No TURN server configured (STUN only)'}

Press Ctrl+C to stop
`);

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  server.stop();
  process.exit(0);
});
