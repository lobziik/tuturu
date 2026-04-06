/**
 * Room-level WebSocket side effects — connection, heartbeat, and reconnect.
 *
 * Manages the WS lifecycle at the room level (not tied to video call).
 * The WS connects when entering room phase and stays alive for chat.
 *
 * @module state/effects/roomWebSocket
 */

import { WS_DEAD_DETECTION_MS, MAX_RECONNECT_ATTEMPTS } from '../../../shared/constants';
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

/** Handle room-level WebSocket side effects */
export function handleRoomWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const { action, prevState, newState } = args;

  // === Entering room phase → Create WS, load IDB cache, init seq ===
  if (prevState.phase !== 'room' && newState.phase === 'room') {
    handleRoomEntry(ctx, newState);
  }

  // === Heartbeat: respond to pings, manage dead detection ===
  if (action.type === 'PING_RECEIVED' && newState.phase === 'room') {
    sendMessage(refs.ws.current, { type: 'pong', v: 1 });
    resetDeadTimer(ctx);
  }

  // === Start dead timer on successful connection ===
  if (action.type === 'WS_ROOM_CONNECTED') {
    refs.reconnectAttempt.current = 0;
    clearReconnectTimer(refs);
    resetDeadTimer(ctx);
  }

  // === Manual reconnect requested by user ===
  if (action.type === 'RECONNECT_REQUESTED' && newState.phase === 'room') {
    const aesKey = refs.aesKey.current;
    if (!aesKey) {
      console.error('[ROOM_WS] Cannot reconnect: aesKey not available');
      return;
    }
    refs.reconnectAttempt.current = 0;
    clearReconnectTimer(refs);
    connectWebSocket(ctx, { roomId: newState.roomId, nickname: newState.nickname, aesKey });
  }

  // === Disconnection / close / error → reconnect ===
  if (newState.phase === 'room') {
    handleDisconnection(ctx, action, newState);
  }
}

/** Initialize room: connect WS, load IDB cache, load seq counter */
function handleRoomEntry(
  ctx: EffectContext,
  newState: Extract<EffectArgs['newState'], { phase: 'room' }>,
): void {
  const { refs, dispatch } = ctx;
  const { roomId, nickname, deviceId } = newState;
  const aesKey = refs.aesKey.current;

  if (!aesKey) {
    console.error('[ROOM_WS] Cannot connect: aesKey not available');
    return;
  }

  connectWebSocket(ctx, { roomId, nickname, aesKey });
  loadCachedMessages(refs.db.current, roomId, dispatch);
  initSeqCounter(refs, refs.db.current, roomId, deviceId);
}

/** Load cached messages from IndexedDB for instant display */
function loadCachedMessages(
  db: IDBDatabase | null,
  roomId: string,
  dispatch: EffectContext['dispatch'],
): void {
  if (!db) return;

  void (async () => {
    try {
      const cached = await getMessagesByTimestamp(db, roomId, Date.now() + 1, 200);
      if (cached.length > 0) {
        dispatch({
          type: 'HISTORY_LOADED',
          messages: cached.slice().reverse(),
          cursor: null,
          hasMore: false,
          fromCache: true,
        });
      }
    } catch (err) {
      console.error('[ROOM_WS] Failed to load cached messages from IDB:', err);
    }
  })();
}

/** Initialize seq counter from IDB (must complete before sends are allowed) */
function initSeqCounter(
  refs: EffectContext['refs'],
  db: IDBDatabase | null,
  roomId: string,
  deviceId: string,
): void {
  refs.seqLoaded.current = false;

  if (!db) {
    refs.seqLoaded.current = true;
    return;
  }

  void (async () => {
    try {
      const { getOwnSeq } = await import('../../services/db');
      const ownSeq = await getOwnSeq(db, roomId, deviceId);
      refs.seq.current = ownSeq;
    } catch (err) {
      console.error('[ROOM_WS] Failed to load seq counter:', err);
    } finally {
      refs.seqLoaded.current = true;
    }
  })();
}

/** Handle disconnection/close/error actions — trigger reconnect when appropriate */
function handleDisconnection(
  ctx: EffectContext,
  action: EffectArgs['action'],
  newState: Extract<EffectArgs['newState'], { phase: 'room' }>,
): void {
  const { refs } = ctx;

  if (action.type === 'WS_ROOM_DISCONNECTED') {
    clearDeadTimer(refs);
    startReconnect(ctx, newState.roomId, newState.nickname);
    return;
  }

  if (action.type === 'WS_CLOSED' && !action.intentional) {
    clearDeadTimer(refs);
    refs.ws.current = null;
    startReconnect(ctx, newState.roomId, newState.nickname);
    return;
  }

  if (action.type === 'WS_ERROR') {
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

  refs.deadTimer.current = globalThis.setTimeout(() => {
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

/** Start reconnect with exponential backoff. No-op if a reconnect timer is already pending. */
function startReconnect(ctx: EffectContext, roomId: string, nickname: string): void {
  const { refs, dispatch } = ctx;

  // Guard: prevent duplicate reconnect timers (e.g. WS_ROOM_DISCONNECTED + WS_CLOSED race)
  if (refs.reconnectTimer.current !== null) {
    return;
  }

  const attempt = refs.reconnectAttempt.current;

  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[ROOM_WS] Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
    dispatch({ type: 'WS_RECONNECT_EXHAUSTED' });
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

  refs.reconnectTimer.current = globalThis.setTimeout(() => {
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
