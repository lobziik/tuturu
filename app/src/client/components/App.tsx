/**
 * Root Preact component — owns state, refs, dispatch wrapper, and screen routing.
 *
 * @remarks
 * Side effects run **synchronously in dispatch** via {@link runEffects},
 * not in useEffect. This avoids the problem where actions that don't change
 * state (RECEIVED_ANSWER, RECEIVED_ICE_CANDIDATE, etc.) would never trigger
 * a re-render, causing useEffect-based effects to be silently skipped.
 *
 * @module components/App
 */

import { useReducer, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { reducer } from '../state/reducer';
import { initialState, type AppState, type Action } from '../state/types';
import { AppContext, createDebugReducer } from '../state/context';
import type { Dispatch } from '../state/context';
import { runEffects, cleanupResources, type ResourceRefs } from '../state/effects';

import { PinEntryScreen } from './PinEntryScreen';
import { ConnectingScreen } from './ConnectingScreen';
import { AcquiringMediaScreen } from './AcquiringMediaScreen';
import { CallScreen } from './CallScreen';
import { ErrorBanner } from './ErrorBanner';

const debugReducer = createDebugReducer(reducer);

/** Root application component with state provider, side effects, and screen routing */
export function App() {
  const [state, rawDispatch] = useReducer(debugReducer, initialState);

  // Mutable resource refs — individual useRef calls for hook-order stability
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);

  // Stable container object for effect handlers (memoized so identity doesn't change)
  const refs = useMemo<ResourceRefs>(
    () => ({
      ws: wsRef,
      pc: pcRef,
      localStream: localStreamRef,
      remoteStream: remoteStreamRef,
      errorTimeout: errorTimeoutRef,
    }),
    [],
  );

  // Authoritative state ref — updated synchronously in dispatch
  const stateRef = useRef<AppState>(initialState);

  // Stable dispatch via ref indirection (avoids circular useCallback deps)
  const dispatchRef = useRef<Dispatch>(null!);
  const dispatch: Dispatch = useCallback((action: Action) => {
    dispatchRef.current(action);
  }, []);

  // Dispatch implementation: prev state → reducer → side effects → re-render
  dispatchRef.current = (action: Action) => {
    const prevState = stateRef.current;
    const newState = reducer(prevState, action);
    stateRef.current = newState;

    // Capture resource payloads into refs before side effects run
    if (action.type === 'MEDIA_ACQUIRED') {
      refs.localStream.current = action.stream;
    }
    if (action.type === 'RTC_TRACK_RECEIVED') {
      refs.remoteStream.current = action.stream;
    }

    // Side effects — synchronous, before re-render
    runEffects({ refs, dispatch }, { prevState, newState, action });

    // Trigger Preact re-render
    rawDispatch(action);
  };

  // Page unload cleanup
  useEffect(() => {
    const handleUnload = () => cleanupResources(refs);
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  // Screen routing
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
            localStream={refs.localStream.current}
            remoteStream={refs.remoteStream.current}
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
