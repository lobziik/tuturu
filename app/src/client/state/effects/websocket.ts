/**
 * WebSocket side effects — connection creation and message sending.
 *
 * @module state/effects/websocket
 */

import type { Screen } from '../types';
import { createWebSocket, setupWebSocketHandlers, sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';

/** Handle WebSocket-related side effects */
export function handleWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevScreen, newScreen } = args;
  const newState = args.newState;

  // Entering connecting → Create WebSocket and wire up handlers
  if (newScreen === 'connecting' && prevScreen !== 'connecting') {
    const ws = createWebSocket();
    setupWebSocketHandlers(dispatch, ws);
    refs.ws.current = ws;
  }

  // Media acquired + now waiting → Send join-pin to server
  if (action.type === 'MEDIA_ACQUIRED' && newScreen === 'waiting-for-peer') {
    const pin = (newState.screen as Extract<Screen, { type: 'waiting-for-peer' }>).pin;
    sendMessage(refs.ws.current, { type: 'join-pin', pin });
  }
}
