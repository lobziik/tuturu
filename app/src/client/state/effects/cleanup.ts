/**
 * Cleanup side effects — resource teardown on hangup and non-retryable errors.
 *
 * @module state/effects/cleanup
 */

import { closeWebSocket, sendMessage } from '../../services/websocket';
import { closePeerConnection } from '../../services/webrtc';
import { stopMediaStream } from '../../services/media';
import type { EffectContext, EffectArgs, ResourceRefs } from './types';

/**
 * Release all mutable resources (peer connection, media streams, WebSocket).
 * Safe to call multiple times — each resource is nulled after cleanup.
 */
export function cleanupResources(refs: ResourceRefs): void {
  console.log('[CLEANUP] Cleaning up resources');
  if (refs.pc.current) {
    closePeerConnection(refs.pc.current);
    refs.pc.current = null;
  }
  if (refs.localStream.current) {
    stopMediaStream(refs.localStream.current);
    refs.localStream.current = null;
  }
  if (refs.ws.current) {
    closeWebSocket(refs.ws.current);
    refs.ws.current = null;
  }
  refs.remoteStream.current = null;
}

/** Handle cleanup-related side effects: hangup and non-retryable errors */
export function handleCleanupEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const { action, newScreen } = args;
  const newState = args.newState;

  // HANGUP → Send leave message and tear down everything
  if (action.type === 'HANGUP') {
    if (refs.ws.current) {
      sendMessage(refs.ws.current, { type: 'leave' });
    }
    cleanupResources(refs);
  }

  // Non-retryable error → Cleanup resources so nothing lingers
  if (newScreen === 'error' && newState.screen.type === 'error' && !newState.screen.canRetry) {
    cleanupResources(refs);
  }
}
