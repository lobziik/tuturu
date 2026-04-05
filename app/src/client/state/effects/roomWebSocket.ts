/**
 * Room-level WebSocket side effects — connection, heartbeat, and reconnect.
 *
 * Manages the WS lifecycle at the room level (not tied to video call).
 * The WS connects when entering room phase and stays alive for chat.
 *
 * @module state/effects/roomWebSocket
 */

import { WS_DEAD_DETECTION_MS } from '../../../shared/constants';
import {
  createWebSocket,
  setupWebSocketHandlers,
  sendMessage,
  closeWebSocket,
} from '../../services/websocket';
import type { WsRoomContext } from '../../services/websocket';
import { getMessagesByTimestamp } from '../../services/db';
import type { EffectContext, EffectArgs } from './types';

/** Maximum reconnect delay in milliseconds */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Base reconnect delay in milliseconds */
const BASE_RECONNECT_DELAY_MS = 1_000;

/** Maximum number of reconnect attempts before giving up */
const MAX_RECONNECT_ATTEMPTS = 20;

/** Handle room-level WebSocket side effects */
export function handleRoomWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;

  // === Entering room phase → Create WS and connect ===
  if (prevState.phase !== 'room' && newState.phase === 'room') {
    const { roomId, nickname, deviceId } = newState;
    const aesKey = refs.aesKey.current;

    if (!aesKey) {
      console.error('[ROOM_WS] Cannot connect: aesKey not available');
      return;
    }

    const roomContext: WsRoomContext = { roomId, nickname, aesKey };
    connectWebSocket(ctx, roomContext);

    // Load cached messages from IndexedDB for instant display
    const db = refs.db.current;
    if (db) {
      void (async () => {
        try {
          const cached = await getMessagesByTimestamp(db, Date.now() + 1, 200);
          if (cached.length > 0) {
            dispatch({
              type: 'HISTORY_LOADED',
              // getMessagesByTimestamp returns newest-first, reverse to ascending
              messages: cached.reverse(),
              cursor: null,
              hasMore: true, // Server will clarify the actual value
            });
          }
        } catch (err) {
          console.error('[ROOM_WS] Failed to load cached messages from IDB:', err);
        }
      })();
    }

    // Initialize seq counter from IDB
    if (db) {
      void (async () => {
        try {
          const { getOwnSeq } = await import('../../services/db');
          const ownSeq = await getOwnSeq(db, deviceId);
          refs.seq.current = ownSeq;
        } catch (err) {
          console.error('[ROOM_WS] Failed to load seq counter:', err);
        }
      })();
    }
  }

  // === Heartbeat: respond to pings, manage dead detection ===
  if (action.type === 'PING_RECEIVED' && newState.phase === 'room') {
    // Send pong
    sendMessage(refs.ws.current, { type: 'pong', v: 1 });

    // Reset dead detection timer
    resetDeadTimer(ctx);
  }

  // === Start dead timer on successful connection ===
  if (action.type === 'WS_ROOM_CONNECTED') {
    refs.reconnectAttempt.current = 0;
    clearReconnectTimer(refs);
    resetDeadTimer(ctx);
  }

  // === Handle disconnection — trigger reconnect ===
  if (action.type === 'WS_ROOM_DISCONNECTED' && newState.phase === 'room') {
    clearDeadTimer(refs);
    startReconnect(ctx, newState.roomId, newState.nickname);
  }

  // === Unintentional WS close → initiate reconnect ===
  if (action.type === 'WS_CLOSED' && !action.intentional && newState.phase === 'room') {
    clearDeadTimer(refs);
    refs.ws.current = null;
    startReconnect(ctx, newState.roomId, newState.nickname);
  }

  // === WS error without close (some browsers) → treat as disconnection ===
  if (action.type === 'WS_ERROR' && newState.phase === 'room') {
    // If WS is already closed or closing, the WS_CLOSED handler will deal with it.
    // Only act if WS appears gone.
    if (!refs.ws.current || refs.ws.current.readyState >= WebSocket.CLOSING) {
      clearDeadTimer(refs);
      refs.ws.current = null;
      startReconnect(ctx, newState.roomId, newState.nickname);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Create a new WebSocket and wire up handlers */
function connectWebSocket(ctx: EffectContext, roomContext: WsRoomContext): void {
  const { refs, dispatch } = ctx;

  // Close existing WS if any
  if (refs.ws.current) {
    closeWebSocket(refs.ws.current);
  }

  const ws = createWebSocket();
  refs.ws.current = ws;

  setupWebSocketHandlers(dispatch, ws, refs, roomContext);
}

/** Reset the dead detection timer (60s from now) */
function resetDeadTimer(ctx: EffectContext): void {
  const { refs, dispatch } = ctx;

  if (refs.deadTimer.current !== null) {
    clearTimeout(refs.deadTimer.current);
  }

  refs.deadTimer.current = window.setTimeout(() => {
    console.warn('[ROOM_WS] No ping received within deadline — connection dead');
    refs.deadTimer.current = null;
    dispatch({ type: 'WS_ROOM_DISCONNECTED' });
  }, WS_DEAD_DETECTION_MS);
}

/** Clear the dead detection timer */
function clearDeadTimer(refs: EffectContext['refs']): void {
  if (refs.deadTimer.current !== null) {
    clearTimeout(refs.deadTimer.current);
    refs.deadTimer.current = null;
  }
}

/** Clear the reconnect timer */
function clearReconnectTimer(refs: EffectContext['refs']): void {
  if (refs.reconnectTimer.current !== null) {
    clearTimeout(refs.reconnectTimer.current);
    refs.reconnectTimer.current = null;
  }
}

/** Start reconnect with exponential backoff */
function startReconnect(ctx: EffectContext, roomId: string, nickname: string): void {
  const { refs, dispatch } = ctx;
  const attempt = refs.reconnectAttempt.current;

  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[ROOM_WS] Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
    dispatch({
      type: 'WS_ROOM_DISCONNECTED',
    });
    return;
  }

  // Exponential backoff with jitter
  const baseDelay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt),
    MAX_RECONNECT_DELAY_MS,
  );
  const jitter = baseDelay * (0.5 + Math.random() * 0.5);
  const delay = Math.round(jitter);

  console.log(`[ROOM_WS] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
  dispatch({ type: 'WS_ROOM_RECONNECTING', attempt: attempt + 1 });

  refs.reconnectAttempt.current = attempt + 1;

  clearReconnectTimer(refs);
  refs.reconnectTimer.current = window.setTimeout(() => {
    refs.reconnectTimer.current = null;

    const aesKey = refs.aesKey.current;
    if (!aesKey) {
      console.error('[ROOM_WS] Cannot reconnect: aesKey lost');
      return;
    }

    const roomContext: WsRoomContext = { roomId, nickname, aesKey };
    connectWebSocket(ctx, roomContext);
  }, delay);
}
