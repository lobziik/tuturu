/**
 * Effect orchestrator — runs all domain effect handlers in order.
 *
 * @remarks
 * Called synchronously from the dispatch wrapper in App.tsx.
 * Order matters: WS must exist before media can send join-pin,
 * PC must exist before WebRTC negotiation runs.
 *
 * @module state/effects/orchestrator
 */

import type { EffectContext, EffectArgs } from './types';
import { handleWebSocketEffects } from './websocket';
import { handleMediaEffects } from './media';
import { handleWebRTCEffects } from './webrtc';
import { handleCleanupEffects } from './cleanup';
import { handleErrorEffects } from './error';

/**
 * Run all side effects for a state transition.
 * Must be called synchronously — NOT from useEffect.
 */
export function runEffects(ctx: EffectContext, args: EffectArgs): void {
  handleWebSocketEffects(ctx, args);
  handleMediaEffects(ctx, args);
  handleWebRTCEffects(ctx, args);
  handleCleanupEffects(ctx, args);
  handleErrorEffects(ctx, args);
}
