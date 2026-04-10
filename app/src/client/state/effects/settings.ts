/**
 * Settings side effects — nickname change, history clearing, room exit.
 *
 * @module state/effects/settings
 */

import { putSetting, clearBlobs } from '../../services/db';
import { closeWebSocket, createWebSocket, setupWebSocketHandlers } from '../../services/websocket';
import { cleanupRoomResources } from './cleanup';
import type { EffectContext, EffectArgs } from './types';

/** Handle settings-related side effects */
export function handleSettingsEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;

  // CHANGE_NICKNAME → persist to IDB, reconnect WS with new encrypted nickname
  if (action.type === 'CHANGE_NICKNAME' && newState.phase === 'room') {
    const db = refs.db.current;
    const aesKey = refs.aesKey.current;
    if (!db || !aesKey) return;

    // Persist new nickname to IDB
    void putSetting(db, 'nickname', action.nickname);

    // Cancel any pending reconnect timer to prevent race with old nickname
    if (refs.reconnectTimer.current !== null) {
      clearTimeout(refs.reconnectTimer.current);
      refs.reconnectTimer.current = null;
    }
    refs.reconnectAttempt.current = 0;

    // Close existing WS (intentional close won't trigger auto-reconnect)
    if (refs.ws.current) {
      closeWebSocket(refs.ws.current);
    }

    // Create new WS with updated nickname
    const ws = createWebSocket();
    refs.ws.current = ws;
    setupWebSocketHandlers(dispatch, ws, refs, {
      roomId: newState.roomId,
      nickname: action.nickname,
      aesKey,
    });
  }

  // CLEAR_HISTORY → wipe encrypted blobs from IDB
  if (action.type === 'CLEAR_HISTORY') {
    const db = refs.db.current;
    if (!db) return;
    void clearBlobs(db);
  }

  // LEAVE_ROOM → tear down all room resources
  if (action.type === 'LEAVE_ROOM' && prevState.phase === 'room') {
    cleanupRoomResources(refs);
    refs.aesKey.current = null;
  }
}
