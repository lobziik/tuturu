/**
 * WebSocket message handling
 *
 * Handles WebRTC signaling messages: join-pin, offer, answer, ice-candidate, leave.
 * FAILS FAST on invalid messages with clear error reporting.
 */

import type { ServerWebSocket } from 'bun';
import {
  type ClientToServerMessage,
  type ServerToClientMessage,
  type ClientData,
  InvalidPinError,
  RoomFullError,
  InvalidMessageError,
} from '../types';
import { config } from './config';
import {
  type Client,
  getOrCreateRoom,
  addClientToRoom,
  removeClientFromRoom,
  getPeer,
} from './rooms';
import { buildIceServers } from './ice';

/**
 * Client ID counter for unique identification
 */
let clientIdCounter = 0;

/**
 * Generate unique client ID
 */
export function generateClientId(): string {
  return `client-${++clientIdCounter}-${Date.now()}`;
}

/**
 * Validate PIN format (6 digits)
 */
function validatePin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new InvalidPinError(pin);
  }
}

/**
 * Send message to WebSocket client
 * FAILS LOUD on serialization or send errors
 * Note: Bun's ServerWebSocket doesn't expose readyState, so we rely on send() throwing if closed
 */
export function sendMessage(ws: ServerWebSocket<ClientData>, message: ServerToClientMessage): void {
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
export function handleMessage(ws: ServerWebSocket<ClientData>, rawMessage: string | Buffer): void {
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
        const iceServers = buildIceServers(clientData.id);

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
 * Handle WebSocket connection open
 */
export function handleOpen(ws: ServerWebSocket<ClientData>): void {
  const clientData = ws.data as ClientData;
  console.log(`[WS] Client ${clientData.id} connected`);
}

/**
 * Handle WebSocket connection close
 */
export function handleClose(ws: ServerWebSocket<ClientData>): void {
  const clientData = ws.data as ClientData;
  console.log(`[WS] Client ${clientData.id} disconnected`);

  // Create full Client object to remove from room
  const client: Client = {
    ...clientData,
    ws,
  };
  removeClientFromRoom(client, sendMessage);
}
