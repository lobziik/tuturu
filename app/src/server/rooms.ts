/**
 * N-peer room management with call state.
 *
 * Factory creates a RoomManager that tracks peer membership and video call participation.
 * All outgoing messages go through an injected `send` callback — no direct ws.send.
 *
 * @module server/rooms
 */

import type { ServerWebSocket } from 'bun';
import type { ServerToClientMessage } from '../shared/schemas';

/** WebSocket data attached to each connection */
export interface ServerClientData {
  /** Unique peer identifier (crypto.randomUUID() at connect) */
  peerId: string;
  /** Room the peer has joined, or null if not yet joined */
  roomId: string | null;
}

/** Peer in a room */
export interface Peer {
  peerId: string;
  ws: ServerWebSocket<ServerClientData>;
  /** Encrypted nickname blob — opaque to server */
  encryptedNickname: string;
}

/** Room state */
interface Room {
  peers: Map<string, Peer>;
  callPeers: Set<string>;
}

/** Callback for sending messages to a WebSocket client */
export type SendFn = (
  ws: ServerWebSocket<ServerClientData>,
  message: ServerToClientMessage,
) => void;

/** Room manager interface */
export interface RoomManager {
  /** Add peer to room. Broadcasts peer-joined to existing peers. Returns peer list or error. */
  join(
    roomId: string,
    peerId: string,
    ws: ServerWebSocket<ServerClientData>,
    encryptedNickname: string,
  ): { peers: Peer[] } | { error: 'full' };

  /** Remove peer from room. Auto-leaves call if in one. Broadcasts peer-left. Deletes room if empty. */
  leave(roomId: string, peerId: string): void;

  /** Get all peers in a room */
  getPeers(roomId: string): Peer[];

  /** Look up which room a peer belongs to */
  getRoomIdForPeer(peerId: string): string | undefined;

  /** Send message to all peers in room, optionally excluding one */
  broadcast(roomId: string, message: ServerToClientMessage, excludePeerId?: string): void;

  /** Send message to a specific peer. Returns false if peer not found. */
  routeToPeer(roomId: string, targetPeerId: string, message: ServerToClientMessage): boolean;

  /** Peer joins the video call. Broadcasts peer-joined-call. Returns existing call peers. */
  joinCall(
    roomId: string,
    peerId: string,
  ): { callPeers: string[] } | { error: 'not_in_room' | 'call_full' };

  /** Peer leaves the video call. Broadcasts peer-left-call. */
  leaveCall(roomId: string, peerId: string): void;

  /** Get all peers currently in a video call */
  getCallPeers(roomId: string): string[];

  /** Number of active rooms (for health endpoint) */
  getRoomCount(): number;

  /** Clear all rooms (for test cleanup) */
  clear(): void;
}

/**
 * Create a RoomManager.
 *
 * @param options.maxParticipants - Maximum peers per room
 * @param options.send - Callback for sending messages to WebSocket clients
 */
export function createRoomManager(options: { maxParticipants: number; send: SendFn }): RoomManager {
  const { maxParticipants, send } = options;
  const rooms = new Map<string, Room>();
  /** Reverse lookup: peerId → roomId */
  const peerRooms = new Map<string, string>();

  function getOrCreateRoom(roomId: string): Room {
    let room = rooms.get(roomId);
    if (!room) {
      room = { peers: new Map(), callPeers: new Set() };
      rooms.set(roomId, room);
    }
    return room;
  }

  function join(
    roomId: string,
    peerId: string,
    ws: ServerWebSocket<ServerClientData>,
    encryptedNickname: string,
  ): { peers: Peer[] } | { error: 'full' } {
    const room = getOrCreateRoom(roomId);

    if (room.peers.size >= maxParticipants) {
      return { error: 'full' };
    }

    const peer: Peer = { peerId, ws, encryptedNickname };

    // Collect existing peers BEFORE adding the new one
    const existingPeers = Array.from(room.peers.values());

    room.peers.set(peerId, peer);
    peerRooms.set(peerId, roomId);

    // Broadcast peer-joined to existing peers
    const count = room.peers.size;
    for (const existing of existingPeers) {
      send(existing.ws, {
        type: 'peer-joined',
        v: 1,
        peerId,
        encryptedNickname,
        count,
      });
    }

    console.log(`[ROOM] Peer ${peerId} joined room ${roomId} (${count}/${maxParticipants})`);
    return { peers: existingPeers };
  }

  function leave(roomId: string, peerId: string): void {
    const room = rooms.get(roomId);
    if (!room) return;

    // Auto-leave call if in one
    if (room.callPeers.has(peerId)) {
      leaveCall(roomId, peerId);
    }

    room.peers.delete(peerId);
    peerRooms.delete(peerId);
    const count = room.peers.size;

    // Broadcast peer-left to remaining peers
    for (const remaining of room.peers.values()) {
      send(remaining.ws, {
        type: 'peer-left',
        v: 1,
        peerId,
        count,
      });
    }

    console.log(`[ROOM] Peer ${peerId} left room ${roomId} (${count}/${maxParticipants})`);

    // Delete room if empty
    if (count === 0) {
      rooms.delete(roomId);
      console.log(`[ROOM] Deleted empty room ${roomId}`);
    }
  }

  function getPeers(roomId: string): Peer[] {
    const room = rooms.get(roomId);
    return room ? Array.from(room.peers.values()) : [];
  }

  function getRoomIdForPeer(peerId: string): string | undefined {
    return peerRooms.get(peerId);
  }

  function broadcast(roomId: string, message: ServerToClientMessage, excludePeerId?: string): void {
    const room = rooms.get(roomId);
    if (!room) return;

    for (const peer of room.peers.values()) {
      if (peer.peerId !== excludePeerId) {
        send(peer.ws, message);
      }
    }
  }

  function routeToPeer(
    roomId: string,
    targetPeerId: string,
    message: ServerToClientMessage,
  ): boolean {
    const room = rooms.get(roomId);
    if (!room) return false;

    const peer = room.peers.get(targetPeerId);
    if (!peer) return false;

    send(peer.ws, message);
    return true;
  }

  function joinCall(
    roomId: string,
    peerId: string,
  ): { callPeers: string[] } | { error: 'not_in_room' | 'call_full' } {
    const room = rooms.get(roomId);
    if (!room?.peers.has(peerId)) {
      return { error: 'not_in_room' };
    }

    // 1-to-1 guard: reject if call already has 2 participants
    if (room.callPeers.size >= 2) {
      return { error: 'call_full' };
    }

    // Collect existing call peers BEFORE adding the new one
    const existingCallPeers = Array.from(room.callPeers);

    room.callPeers.add(peerId);

    // Broadcast peer-joined-call to existing call peers
    for (const existingPeerId of existingCallPeers) {
      const peer = room.peers.get(existingPeerId);
      if (peer) {
        send(peer.ws, { type: 'peer-joined-call', v: 1, peerId });
      }
    }

    console.log(`[CALL] Peer ${peerId} joined call in room ${roomId}`);
    return { callPeers: existingCallPeers };
  }

  function leaveCall(roomId: string, peerId: string): void {
    const room = rooms.get(roomId);
    if (!room?.callPeers.has(peerId)) return;

    room.callPeers.delete(peerId);

    // Broadcast peer-left-call to remaining call peers
    for (const remainingPeerId of room.callPeers) {
      const peer = room.peers.get(remainingPeerId);
      if (peer) {
        send(peer.ws, { type: 'peer-left-call', v: 1, peerId });
      }
    }

    console.log(`[CALL] Peer ${peerId} left call in room ${roomId}`);
  }

  function getCallPeers(roomId: string): string[] {
    const room = rooms.get(roomId);
    return room ? Array.from(room.callPeers) : [];
  }

  function getRoomCount(): number {
    return rooms.size;
  }

  function clear(): void {
    rooms.clear();
    peerRooms.clear();
  }

  return {
    join,
    leave,
    getPeers,
    getRoomIdForPeer,
    broadcast,
    routeToPeer,
    joinCall,
    leaveCall,
    getCallPeers,
    getRoomCount,
    clear,
  };
}
