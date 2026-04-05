/**
 * WebSocket side effects — connection creation and message sending.
 *
 * @module state/effects/websocket
 */

import { createWebSocket, setupWebSocketHandlers, sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen } from './types';

/** Handle WebSocket-related side effects */
export function handleWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);

  // Entering connecting → Create WebSocket and wire up handlers
  if (newScreen?.type === 'connecting' && prevScreen?.type !== 'connecting') {
    const ws = createWebSocket();
    setupWebSocketHandlers(dispatch, ws);
    refs.ws.current = ws;
  }

  // Media acquired + now waiting → Send join to server (v2 protocol)
  if (action.type === 'MEDIA_ACQUIRED' && newScreen?.type === 'waiting-for-peer') {
    if (newState.phase === 'room') {
      sendMessage(refs.ws.current, {
        type: 'join',
        v: 1,
        roomId: newState.roomId,
        encryptedNickname: newState.nickname,
      });
    }
  }
}
