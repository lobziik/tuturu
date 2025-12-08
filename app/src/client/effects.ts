/**
 * Side effect orchestration
 * Detects state transitions and triggers appropriate side effects
 */

import type { AppState, Action } from './state';
import { createWebSocket, setupWebSocketHandlers, sendMessage, closeWebSocket } from './websocket';
import { getUserMedia, stopMediaStream } from './media';
import {
  createPeerConnection,
  closePeerConnection,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
} from './webrtc';

/**
 * Dispatch function type
 */
type Dispatch = (action: Action) => void;

/**
 * Error display timeout tracker
 * Prevents race condition when multiple errors occur in sequence
 */
let errorTimeoutId: number | null = null;

/**
 * Handle side effects based on state transitions
 * Called after every state update, compares previous and new state
 *
 * @param prevState - State before transition
 * @param newState - State after transition
 * @param action - Action that caused transition
 * @param dispatch - Function to dispatch new actions
 *
 * @remarks
 * Side Effect Categories:
 * 1. Resource creation (WebSocket, MediaStream, RTCPeerConnection)
 * 2. Message sending (via WebSocket)
 * 3. Resource cleanup (stop streams, close connections)
 * 4. Track manipulation (mute/unmute, video on/off)
 * 5. Timeout management (error display)
 *
 * State Machine Boundary:
 * - Reducer is pure (no side effects)
 * - This module handles ALL side effects
 * - Keeps side effect logic separate and testable
 */
export function handleSideEffects(
  prevState: AppState,
  newState: AppState,
  action: Action,
  dispatch: Dispatch,
): void {
  const prevScreen = prevState.screen.type;
  const newScreen = newState.screen.type;

  // ===== CONNECTING → Create WebSocket =====
  if (newScreen === 'connecting' && prevScreen !== 'connecting') {
    const ws = createWebSocket();
    setupWebSocketHandlers(dispatch, ws);
    // Store WebSocket in state via a hack: mutate newState
    // This is acceptable because effects run before render
    // Alternative: dispatch WS_CREATED action with ws instance
    newState.ws = ws;
  }

  // ===== ACQUIRING MEDIA → Get user media =====
  if (newScreen === 'acquiring-media' && prevScreen !== 'acquiring-media') {
    void getUserMedia(dispatch);
  }

  // ===== MEDIA ACQUIRED → Send join-pin message =====
  if (action.type === 'MEDIA_ACQUIRED' && newState.screen.type === 'waiting-for-peer') {
    const pin = newState.screen.pin;
    sendMessage(newState.ws, { type: 'join-pin', pin });
  }

  // ===== NEGOTIATING (caller) → Create peer connection and offer =====
  if (
    newScreen === 'negotiating' &&
    prevScreen !== 'negotiating' &&
    newState.screen.type === 'negotiating' &&
    newState.screen.role === 'caller'
  ) {
    const pc = createPeerConnection(newState, dispatch);
    newState.pc = pc;

    // Create and send offer
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendMessage(newState.ws, { type: 'offer', data: pc.localDescription! });
        console.log('[RTC] Sent offer');
      })
      .catch((error) => {
        console.error('[RTC] Failed to create offer:', error);
        dispatch({
          type: 'RTC_FAILED',
          reason: `Failed to create offer: ${(error as Error).message}`,
        });
      });
  }

  // ===== RECEIVED OFFER → Create peer connection and handle offer =====
  if (action.type === 'RECEIVED_OFFER') {
    if (!newState.pc) {
      const pc = createPeerConnection(newState, dispatch);
      newState.pc = pc;
    }
    void handleOffer(newState.pc, action.offer, newState.ws, dispatch);
  }

  // ===== RECEIVED ANSWER → Set remote description =====
  if (action.type === 'RECEIVED_ANSWER') {
    void handleAnswer(newState.pc, action.answer, dispatch);
  }

  // ===== RECEIVED ICE CANDIDATE → Add to peer connection =====
  if (action.type === 'RECEIVED_ICE_CANDIDATE') {
    void handleIceCandidate(newState.pc, action.candidate, dispatch);
  }

  // ===== TOGGLE MUTE → Update audio track =====
  if (action.type === 'TOGGLE_MUTE' && newState.localStream) {
    const audioTrack = newState.localStream.getAudioTracks()[0];
    if (audioTrack && newState.screen.type === 'call') {
      audioTrack.enabled = !newState.screen.muted;
      console.log('[MEDIA] Audio', newState.screen.muted ? 'muted' : 'unmuted');
    }
  }

  // ===== TOGGLE VIDEO → Update video track =====
  if (action.type === 'TOGGLE_VIDEO' && newState.localStream) {
    const videoTrack = newState.localStream.getVideoTracks()[0];
    if (videoTrack && newState.screen.type === 'call') {
      videoTrack.enabled = !newState.screen.videoOff;
      console.log('[MEDIA] Video', newState.screen.videoOff ? 'off' : 'on');
    }
  }

  // ===== HANGUP → Send leave message and cleanup =====
  if (action.type === 'HANGUP') {
    if (newState.ws) {
      sendMessage(newState.ws, { type: 'leave' });
    }
    cleanup(newState);
  }

  // ===== ERROR → Auto-hide after 5 seconds =====
  if (newScreen === 'error' && prevScreen !== 'error') {
    // Clear previous timeout to fix race condition
    if (errorTimeoutId !== null) {
      clearTimeout(errorTimeoutId);
    }

    errorTimeoutId = window.setTimeout(() => {
      dispatch({ type: 'DISMISS_ERROR' });
      errorTimeoutId = null;
    }, 5000);
  }

  // ===== CLEANUP on transition away from error =====
  if (prevScreen === 'error' && newScreen !== 'error') {
    if (errorTimeoutId !== null) {
      clearTimeout(errorTimeoutId);
      errorTimeoutId = null;
    }
  }

  // ===== CLEANUP on terminal errors =====
  if (newScreen === 'error' && newState.screen.type === 'error' && !newState.screen.canRetry) {
    cleanup(newState);
  }
}

/**
 * Cleanup all resources
 * Closes connections and stops media streams
 *
 * @param state - Current state with resource references
 *
 * @remarks
 * Cleanup Order:
 * 1. Close peer connection (stops RTP packets)
 * 2. Stop local media stream (releases camera/mic)
 * 3. Close WebSocket (ends signaling)
 *
 * Resource Leak Prevention:
 * - Always stop media tracks (turns off camera LED)
 * - Always close peer connection (releases network resources)
 * - Always close WebSocket (server can free room)
 *
 * Idempotent: Safe to call multiple times
 */
function cleanup(state: AppState): void {
  console.log('[CLEANUP] Cleaning up resources');

  if (state.pc) {
    closePeerConnection(state.pc);
    state.pc = null;
  }

  if (state.localStream) {
    stopMediaStream(state.localStream);
    state.localStream = null;
  }

  if (state.ws) {
    closeWebSocket(state.ws);
    state.ws = null;
  }

  // Clear remote stream reference
  state.remoteStream = null;

  // Note: Video elements cleared by render.ts
}
