/**
 * Cleanup side effects — resource teardown for calls and room exit.
 *
 * Two levels of cleanup:
 * - Call: tears down WebRTC + media, keeps WS alive for chat
 * - Room: tears down everything including WS and timers
 *
 * @module state/effects/cleanup
 */

import { closeWebSocket, sendMessage } from '../../services/websocket';
import { closePeerConnection } from '../../services/webrtc';
import { stopMediaStream } from '../../services/media';
import type { EffectContext, EffectArgs, ResourceRefs } from './types';
import { getScreen } from './types';

/**
 * Release video call resources (peer connection, media streams).
 * Does NOT close the room-level WebSocket — chat stays alive.
 */
export function cleanupCallResources(refs: ResourceRefs): void {
  console.log('[CLEANUP] Cleaning up call resources');
  if (refs.pc.current) {
    closePeerConnection(refs.pc.current);
    refs.pc.current = null;
  }
  if (refs.localStream.current) {
    stopMediaStream(refs.localStream.current);
    refs.localStream.current = null;
  }
  refs.remoteStream.current = null;
}

/**
 * Release all resources including room-level WebSocket and timers.
 * Called on page unload or when leaving the room entirely.
 */
export function cleanupRoomResources(refs: ResourceRefs): void {
  console.log('[CLEANUP] Cleaning up all room resources');
  cleanupCallResources(refs);

  if (refs.ws.current) {
    closeWebSocket(refs.ws.current);
    refs.ws.current = null;
  }
  if (refs.deadTimer.current !== null) {
    clearTimeout(refs.deadTimer.current);
    refs.deadTimer.current = null;
  }
  if (refs.reconnectTimer.current !== null) {
    clearTimeout(refs.reconnectTimer.current);
    refs.reconnectTimer.current = null;
  }
}

/** Handle cleanup-related side effects: hangup and non-retryable errors */
export function handleCleanupEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const { action, newState, prevState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);

  // HANGUP → Tear down call resources, send leave-call, keep WS alive
  if (action.type === 'HANGUP') {
    if (refs.ws.current) {
      sendMessage(refs.ws.current, { type: 'leave-call', v: 1 });
    }
    cleanupCallResources(refs);
  }

  // PEER_LEFT_CALL → Remote peer left, tear down call resources (no leave-call needed)
  if (action.type === 'PEER_LEFT_CALL') {
    cleanupCallResources(refs);
  }

  // Entering error screen → Cleanup call resources so nothing lingers
  if (newScreen?.type === 'error' && prevScreen?.type !== 'error') {
    cleanupCallResources(refs);
  }

  // DISMISS_ERROR → Cleanup any lingering call resources (e.g. retryable media errors)
  if (action.type === 'DISMISS_ERROR' && prevScreen?.type === 'error') {
    cleanupCallResources(refs);
  }
}
