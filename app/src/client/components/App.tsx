/**
 * Root Preact component — owns state, refs, side effects, and screen routing.
 *
 * @remarks
 * Architecture:
 * - `useReducer` for serializable state (screen, ICE config) + re-renders
 * - `useRef` for mutable resources (ws, pc, localStream, remoteStream)
 * - Side effects run **synchronously in dispatch**, not in useEffect.
 *   This mirrors v1's pattern and avoids the problem where actions that
 *   don't change state (RECEIVED_ANSWER, RECEIVED_ICE_CANDIDATE, etc.)
 *   would never trigger a useEffect because Preact skips re-render when
 *   useReducer returns the same state reference.
 *
 * @module components/App
 */

import { useReducer, useEffect, useRef, useCallback } from 'preact/hooks';
import { reducer } from '../state/reducer';
import { initialState, type AppState, type Action, type Screen } from '../state/types';
import { AppContext, createDebugReducer } from '../state/context';
import type { Dispatch } from '../state/context';

import {
  createWebSocket,
  setupWebSocketHandlers,
  sendMessage,
  closeWebSocket,
} from '../services/websocket';
import { getUserMedia, stopMediaStream, flipCamera } from '../services/media';
import {
  createPeerConnection,
  closePeerConnection,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
} from '../services/webrtc';

import { PinEntryScreen } from './PinEntryScreen';
import { ConnectingScreen } from './ConnectingScreen';
import { AcquiringMediaScreen } from './AcquiringMediaScreen';
import { CallScreen } from './CallScreen';
import { ErrorBanner } from './ErrorBanner';

const debugReducer = createDebugReducer(reducer);

/** Root application component with state provider, side effects, and screen routing */
export function App() {
  const [state, rawDispatch] = useReducer(debugReducer, initialState);

  // === Mutable resource refs (not in reducer state) ===
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  // Authoritative state ref — updated synchronously in dispatch,
  // used to compute prev/new screen for side effects.
  const stateRef = useRef<AppState>(initialState);
  const errorTimeoutRef = useRef<number | null>(null);

  // === Cleanup helper (stable ref — no deps change) ===
  const cleanupResources = useCallback(() => {
    console.log('[CLEANUP] Cleaning up resources');
    if (pcRef.current) {
      closePeerConnection(pcRef.current);
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      stopMediaStream(localStreamRef.current);
      localStreamRef.current = null;
    }
    if (wsRef.current) {
      closeWebSocket(wsRef.current);
      wsRef.current = null;
    }
    remoteStreamRef.current = null;
  }, []);

  /**
   * Dispatch with synchronous side effects.
   *
   * Flow: capture prev state → compute new state → run side effects → trigger re-render.
   * This ensures side effects fire for EVERY action, even those where the reducer
   * returns the same state reference (RECEIVED_ANSWER, RECEIVED_ICE_CANDIDATE, etc.).
   *
   * Uses a ref-based dispatch to avoid circular dependency issues with useCallback.
   */
  const dispatchRef = useRef<Dispatch>(null!);

  const dispatch: Dispatch = useCallback((action: Action) => {
    dispatchRef.current(action);
  }, []);

  // TODO! ME! This is bullshit going on down below, this need to be spillted and became cleaner. Ideally go to state module. Or rebuild with types heavily.
  // code stincs right away

  // The actual implementation lives in a ref so it always sees current closure values
  // without needing to be re-created (which would break callback identity for children).
  dispatchRef.current = (action: Action) => {
    const prevState = stateRef.current;
    const newState = reducer(prevState, action);
    stateRef.current = newState;

    // Capture resource payloads into refs before side effects run
    if (action.type === 'MEDIA_ACQUIRED') {
      localStreamRef.current = action.stream;
    }
    if (action.type === 'RTC_TRACK_RECEIVED') {
      remoteStreamRef.current = action.stream;
    }

    // === Side effects (synchronous, before re-render) ===
    handleSideEffects(prevState, newState, action);

    // Trigger re-render via Preact's useReducer
    rawDispatch(action);
  };

  /** Process side effects based on state transition and action */
  function handleSideEffects(prevState: AppState, newState: AppState, action: Action): void {
    const prevType = prevState.screen.type;
    const newType = newState.screen.type;
    const newScreen = newState.screen;

    // --- CONNECTING → Create WebSocket ---
    if (newType === 'connecting' && prevType !== 'connecting') {
      const ws = createWebSocket();
      setupWebSocketHandlers(dispatch, ws);
      wsRef.current = ws;
    }

    // --- ACQUIRING MEDIA → Get user media ---
    if (newType === 'acquiring-media' && prevType !== 'acquiring-media') {
      void getUserMedia(dispatch);
    }

    // --- MEDIA ACQUIRED → Send join-pin message ---
    if (action.type === 'MEDIA_ACQUIRED' && newType === 'waiting-for-peer') {
      const pin = (newScreen as Extract<Screen, { type: 'waiting-for-peer' }>).pin;
      sendMessage(wsRef.current, { type: 'join-pin', pin });
    }

    // --- NEGOTIATING (caller) → Create peer connection and offer ---
    if (
      newType === 'negotiating' &&
      prevType !== 'negotiating' &&
      newScreen.type === 'negotiating' &&
      newScreen.role === 'caller'
    ) {
      const pc = createPeerConnection(
        {
          iceServers: newState.iceServers ?? [],
          iceTransportPolicy: newState.iceTransportPolicy,
        },
        localStreamRef.current,
        wsRef.current,
        dispatch,
      );
      pcRef.current = pc;

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          sendMessage(wsRef.current, { type: 'offer', data: pc.localDescription! });
          console.log('[RTC] Sent offer');
        })
        .catch((error: Error) => {
          console.error('[RTC] Failed to create offer:', error);
          dispatch({
            type: 'RTC_FAILED',
            reason: `Failed to create offer: ${error.message}`,
          });
        });
    }

    // --- RECEIVED OFFER → Create peer connection (callee) and handle offer ---
    if (action.type === 'RECEIVED_OFFER') {
      if (!pcRef.current) {
        const pc = createPeerConnection(
          {
            iceServers: newState.iceServers ?? [],
            iceTransportPolicy: newState.iceTransportPolicy,
          },
          localStreamRef.current,
          wsRef.current,
          dispatch,
        );
        pcRef.current = pc;
      }
      void handleOffer(pcRef.current, action.offer, wsRef.current, dispatch);
    }

    // --- RECEIVED ANSWER → Set remote description ---
    if (action.type === 'RECEIVED_ANSWER') {
      void handleAnswer(pcRef.current, action.answer, dispatch);
    }

    // --- RECEIVED ICE CANDIDATE → Add to peer connection ---
    if (action.type === 'RECEIVED_ICE_CANDIDATE') {
      void handleIceCandidate(pcRef.current, action.candidate, dispatch);
    }

    // --- TOGGLE MUTE → Update audio track ---
    if (action.type === 'TOGGLE_MUTE' && localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (
        audioTrack &&
        (newType === 'waiting-for-peer' || newType === 'negotiating' || newType === 'call')
      ) {
        const screen = newScreen as Extract<
          Screen,
          { type: 'waiting-for-peer' } | { type: 'negotiating' } | { type: 'call' }
        >;
        audioTrack.enabled = !screen.muted;
        console.log('[MEDIA] Audio', screen.muted ? 'muted' : 'unmuted');
      }
    }

    // --- TOGGLE VIDEO → Update video track ---
    if (action.type === 'TOGGLE_VIDEO' && localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (
        videoTrack &&
        (newType === 'waiting-for-peer' || newType === 'negotiating' || newType === 'call')
      ) {
        const screen = newScreen as Extract<
          Screen,
          { type: 'waiting-for-peer' } | { type: 'negotiating' } | { type: 'call' }
        >;
        videoTrack.enabled = !screen.videoOff;
        console.log('[MEDIA] Video', screen.videoOff ? 'off' : 'on');
      }
    }

    // --- FLIP CAMERA → Switch camera facing mode ---
    if (action.type === 'FLIP_CAMERA' && localStreamRef.current) {
      void flipCamera(localStreamRef.current, pcRef.current, dispatch);
    }

    // --- HANGUP → Send leave message and cleanup ---
    if (action.type === 'HANGUP') {
      if (wsRef.current) {
        sendMessage(wsRef.current, { type: 'leave' });
      }
      cleanupResources();
    }

    // --- ERROR → Auto-dismiss after 5 seconds ---
    if (newType === 'error' && prevType !== 'error') {
      if (errorTimeoutRef.current !== null) {
        clearTimeout(errorTimeoutRef.current);
      }
      errorTimeoutRef.current = window.setTimeout(() => {
        dispatch({ type: 'DISMISS_ERROR' });
        errorTimeoutRef.current = null;
      }, 5000);
    }

    // --- Leaving error → Clear timeout ---
    if (prevType === 'error' && newType !== 'error') {
      if (errorTimeoutRef.current !== null) {
        clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }
    }

    // --- Non-retryable error → Cleanup resources ---
    if (newType === 'error' && newScreen.type === 'error' && !newScreen.canRetry) {
      cleanupResources();
    }
  }

  // === Page unload cleanup ===
  useEffect(() => {
    const handleUnload = () => {
      if (wsRef.current) {
        wsRef.current.close(1000, 'User closed page');
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  // === Screen routing ===
  const renderScreen = () => {
    switch (state.screen.type) {
      case 'pin-entry':
        return <PinEntryScreen dispatch={dispatch} />;

      case 'connecting':
        return <ConnectingScreen />;

      case 'acquiring-media':
        return <AcquiringMediaScreen />;

      case 'waiting-for-peer':
      case 'negotiating':
      case 'call':
        return (
          <CallScreen
            screen={state.screen}
            localStream={localStreamRef.current}
            remoteStream={remoteStreamRef.current}
            dispatch={dispatch}
          />
        );

      case 'error':
        return (
          <ErrorBanner
            message={state.screen.message}
            canRetry={state.screen.canRetry}
            dispatch={dispatch}
          />
        );
    }
  };

  return <AppContext.Provider value={{ state, dispatch }}>{renderScreen()}</AppContext.Provider>;
}
