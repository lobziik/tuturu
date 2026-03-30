/**
 * WebSocket side effects — connection creation and message sending.
 *
 * @module state/effects/websocket
 */

import { createWebSocket, setupWebSocketHandlers, sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';

/** Handle WebSocket-related side effects */
export function handleWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;

  // Entering connecting → Create WebSocket and wire up handlers
  if (newState.screen.type === 'connecting' && prevState.screen.type !== 'connecting') {
    const ws = createWebSocket();
    setupWebSocketHandlers(dispatch, ws);
    refs.ws.current = ws;
  }

  // Media acquired + now waiting → Send join-pin to server
  if (action.type === 'MEDIA_ACQUIRED' && newState.screen.type === 'waiting-for-peer') {
    sendMessage(refs.ws.current, { type: 'join-pin', pin: newState.screen.pin });
  }
}
