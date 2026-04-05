/**
 * Video-call WebSocket side effects — call-level signaling only.
 *
 * Room-level WS lifecycle (connect, heartbeat, reconnect) is handled by
 * roomWebSocket.ts. This module only handles call-specific messages:
 * sending join-call when media is acquired.
 *
 * @module state/effects/websocket
 */

import { sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen } from './types';

/** Handle video-call WebSocket side effects */
export function handleWebSocketEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const { action, newState } = args;
  const newScreen = getScreen(newState);

  // Media acquired + now waiting → Send join-call to server
  if (action.type === 'MEDIA_ACQUIRED' && newScreen?.type === 'waiting-for-peer') {
    sendMessage(refs.ws.current, { type: 'join-call', v: 1 });
  }
}
