/**
 * Effect orchestrator — runs all domain effect handlers in order.
 *
 * @remarks
 * Called synchronously from the dispatch wrapper in App.tsx.
 * Order: cleanup first (teardown before creating new resources),
 * then room WS → chat → call WS → media → webrtc → error.
 *
 * @module state/effects/orchestrator
 */

import type { EffectContext, EffectArgs } from './types';
import { handleCleanupEffects } from './cleanup';
import { handleRoomWebSocketEffects } from './roomWebSocket';
import { handlePeerEffects } from './peers';
import { handleChatEffects } from './chat';
import { handleSettingsEffects } from './settings';
import { handleWebSocketEffects } from './websocket';
import { handleMediaEffects } from './media';
import { handleWebRTCEffects } from './webrtc';
import { handleSfuEffects } from './sfu';
import { handleErrorEffects } from './error';

/**
 * Run all side effects for a state transition.
 * Must be called synchronously — NOT from useEffect.
 */
export function runEffects(ctx: EffectContext, args: EffectArgs): void {
  handleCleanupEffects(ctx, args);
  handleRoomWebSocketEffects(ctx, args);
  handlePeerEffects(ctx, args);
  handleChatEffects(ctx, args);
  handleSettingsEffects(ctx, args);
  handleWebSocketEffects(ctx, args);
  handleMediaEffects(ctx, args);
  handleWebRTCEffects(ctx, args);
  handleSfuEffects(ctx, args);
  handleErrorEffects(ctx, args);
}
