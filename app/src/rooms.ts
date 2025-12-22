/**
 * Room management for PIN-based peer matching
 *
 * Manages rooms with maximum 2 clients per PIN for peer-to-peer video calls.
 * Tracks TURN credentials per client for revocation on disconnect.
 */

import type { ServerWebSocket } from 'bun';
import type { ClientData, ServerToClientMessage } from './types';
import { revokeTurnCredentials, revokeTurnCredentialsBatch } from './turn';

/**
 * Client connection information (server-side)
 * Combines ClientData with Bun's ServerWebSocket reference
 */
export interface Client {
  id: string;
  pin: string;
  ws: ServerWebSocket<ClientData>;
}

/**
 * Tracked TURN credentials for a client
 */
interface TrackedCredentials {
  username: string;
  expiresAt: number;
}

/**
 * Room for PIN-based matching
 * Maximum 2 clients per room for peer-to-peer calls
 */
interface Room {
  pin: string;
  clients: Client[];
  createdAt: number;
  /** TURN credentials by client ID for revocation on disconnect */
  turnCredentials: Map<string, TrackedCredentials>;
}

/**
 * Active rooms: Map<PIN, Room>
 */
const rooms = new Map<string, Room>();

/**
 * Get or create room for PIN
 *
 * @param pin - 6-digit PIN for room matching
 * @returns The existing or newly created room
 */
export function getOrCreateRoom(pin: string): Room {
  let room = rooms.get(pin);
  if (!room) {
    room = {
      pin,
      clients: [],
      createdAt: Date.now(),
      turnCredentials: new Map(),
    };
    rooms.set(pin, room);
    console.log(`[ROOM] Created room for PIN ${pin}`);
  }
  return room;
}

/**
 * Add client to room.
 *
 * @param room - Room to add client to
 * @param client - Client to add
 * @returns true if added, false if room is full
 */
export function addClientToRoom(room: Room, client: Client): boolean {
  if (room.clients.length >= 2) {
    return false;
  }
  room.clients.push(client);
  console.log(`[ROOM] Client ${client.id} joined room ${room.pin} (${room.clients.length}/2)`);
  return true;
}

/**
 * Track TURN credentials for a client in a room.
 *
 * @param room - Room containing the client
 * @param clientId - Client ID
 * @param credentials - TURN credentials to track
 */
export function trackClientCredentials(
  room: Room,
  clientId: string,
  credentials: TrackedCredentials,
): void {
  room.turnCredentials.set(clientId, credentials);
}

/**
 * Remove client from room, revoke their TURN credentials, and cleanup if empty.
 *
 * @param client - Client to remove
 * @param sendMessage - Function to send messages to WebSocket clients
 */
export function removeClientFromRoom(
  client: Client,
  sendMessage: (ws: ServerWebSocket<ClientData>, message: ServerToClientMessage) => void,
): void {
  const room = rooms.get(client.pin);
  if (!room) return;

  const index = room.clients.findIndex((c) => c.id === client.id);
  if (index !== -1) {
    room.clients.splice(index, 1);
    console.log(`[ROOM] Client ${client.id} left room ${room.pin} (${room.clients.length}/2)`);
  }

  // Revoke this client's TURN credentials
  const creds = room.turnCredentials.get(client.id);
  if (creds) {
    void revokeTurnCredentials(creds.username, creds.expiresAt);
    room.turnCredentials.delete(client.id);
  }

  // Notify remaining peer that this client left
  if (room.clients.length === 1) {
    const remaining = room.clients[0];
    if (remaining) {
      sendMessage(remaining.ws, { type: 'peer-left' });
    }
  }

  // Cleanup empty room and revoke all remaining credentials
  if (room.clients.length === 0) {
    // Revoke any remaining tracked credentials (shouldn't happen normally)
    if (room.turnCredentials.size > 0) {
      const remainingCreds = Array.from(room.turnCredentials.values());
      void revokeTurnCredentialsBatch(remainingCreds);
    }
    rooms.delete(room.pin);
    console.log(`[ROOM] Deleted empty room ${room.pin}`);
  }
}

/**
 * Gets peer in the same room
 *
 * @param client - Client to find peer for
 * @returns The peer client or null if no peer exists
 */
export function getPeer(client: Client): Client | null {
  const room = rooms.get(client.pin);
  if (!room) return null;

  return room.clients.find((c) => c.id !== client.id) || null;
}

/**
 * Get current room count (for health endpoint)
 */
export function getRoomCount(): number {
  return rooms.size;
}
