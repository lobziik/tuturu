/**
 * Thin WebSocket router — Zod parse → dispatch to handlers.
 *
 * Responsibilities: receive raw message, validate with Zod, dispatch by type.
 * No business logic. No direct database/rooms calls.
 *
 * @module server/ws
 */

import type { ServerWebSocket } from 'bun';
import { ClientToServerMessageSchema } from '../shared/schemas';
import type { Handlers } from './handlers';
import type { ServerClientData, SendFn } from './rooms';

/**
 * Create WebSocket event handlers for Bun.serve().
 *
 * @param handlers - Message handler implementations
 * @param send - Send callback for outgoing messages
 */
export function createWebSocketHandlers(
  handlers: Handlers,
  send: SendFn,
): {
  open: (ws: ServerWebSocket<ServerClientData>) => void;
  message: (ws: ServerWebSocket<ServerClientData>, raw: string | Buffer) => void;
  close: (ws: ServerWebSocket<ServerClientData>) => void;
} {
  function open(ws: ServerWebSocket<ServerClientData>): void {
    console.log(`[WS] Peer ${ws.data.peerId} connected`);
  }

  function message(ws: ServerWebSocket<ServerClientData>, raw: string | Buffer): void {
    const peerId = ws.data.peerId;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', v: 1, code: 'INVALID_MESSAGE', message: 'Invalid JSON' });
      return;
    }

    const result = ClientToServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      send(ws, {
        type: 'error',
        v: 1,
        code: 'INVALID_MESSAGE',
        message: 'Message validation failed',
      });
      return;
    }

    const msg = result.data;
    console.log(`[WS] ${peerId} → ${msg.type}`);

    switch (msg.type) {
      case 'join':
        handlers.handleJoin(ws, peerId, msg);
        break;
      case 'leave':
        handlers.handleLeave(ws, peerId);
        break;
      case 'chat':
        handlers.handleChat(ws, peerId, msg);
        break;
      case 'history-request':
        handlers.handleHistoryRequest(ws, peerId, msg);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handlers.handleRelay(ws, peerId, msg);
        break;
      case 'pong':
        handlers.handlePong(ws, peerId);
        break;
      case 'join-call':
        handlers.handleJoinCall(ws, peerId);
        break;
      case 'leave-call':
        handlers.handleLeaveCall(ws, peerId);
        break;
      case 'chat-received':
        handlers.handleChatReceived(ws, peerId, msg);
        break;
    }
  }

  function close(ws: ServerWebSocket<ServerClientData>): void {
    const peerId = ws.data.peerId;
    console.log(`[WS] Peer ${peerId} disconnected`);
    handlers.handleDisconnect(ws, peerId);
  }

  return { open, message, close };
}
