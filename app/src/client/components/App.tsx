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
import { initialState, type AppState, type Action, type RoomState } from '../state/types';
import { AppContext, createDebugReducer } from '../state/context';
import type { Dispatch } from '../state/context';
import { runEffects, cleanupRoomResources, type ResourceRefs } from '../state/effects';
import { openDB, getSetting } from '../services/db';

import { NicknameScreen } from './NicknameScreen';
import { LoginScreen } from './LoginScreen';
import { AcquiringMediaScreen } from './AcquiringMediaScreen';
import { CallScreen } from './CallScreen';
import { ErrorBanner } from './ErrorBanner';
import { RoomScreen } from './RoomScreen';

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
  const aesKeyRef = useRef<CryptoKey | null>(null);
  const dbRef = useRef<IDBDatabase | null>(null);
  const deadTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const seqLoadedRef = useRef<boolean>(false);
  const makingOfferRef = useRef<boolean>(false);

  // Stable container object for effect handlers (memoized so identity doesn't change)
  const refs = useMemo<ResourceRefs>(
    () => ({
      ws: wsRef,
      pc: pcRef,
      localStream: localStreamRef,
      remoteStream: remoteStreamRef,
      errorTimeout: errorTimeoutRef,
      aesKey: aesKeyRef,
      db: dbRef,
      deadTimer: deadTimerRef,
      reconnectTimer: reconnectTimerRef,
      reconnectAttempt: reconnectAttemptRef,
      seq: seqRef,
      seqLoaded: seqLoadedRef,
      makingOffer: makingOfferRef,
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
    if (action.type === 'SUBMIT_LOGIN') {
      refs.aesKey.current = action.aesKey;
    }

    // Side effects — synchronous, before re-render
    runEffects({ refs, dispatch }, { prevState, newState, action });

    // Trigger Preact re-render
    rawDispatch(action);
  };

  // Page unload cleanup
  useEffect(() => {
    const handleUnload = () => cleanupRoomResources(refs);
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  // Startup: open IndexedDB, cache ref, check for saved nickname
  useEffect(() => {
    openDB()
      .then((db) => {
        refs.db.current = db;
        return getSetting(db, 'nickname');
      })
      .then((nickname) => {
        if (nickname) {
          dispatch({ type: 'NICKNAME_LOADED', nickname });
        }
      })
      .catch((err: unknown) => {
        console.error('[App] IndexedDB startup check failed:', err);
      });
  }, []);

  // Phase-level routing
  const renderPhase = () => {
    switch (state.phase) {
      case 'nickname':
        return <NicknameScreen dispatch={dispatch} />;

      case 'login':
        return <LoginScreen nickname={state.nickname} dispatch={dispatch} />;

      case 'room':
        return renderRoomScreen(state);
    }
  };

  // Screen routing within room phase — view-based: chat or call
  const renderRoomScreen = (roomState: RoomState) => {
    // Chat view — default home screen
    if (roomState.view === 'chat') {
      return (
        <RoomScreen
          messages={roomState.messages}
          deviceId={roomState.deviceId}
          wsStatus={roomState.wsStatus}
          historyHasMore={roomState.historyHasMore}
          dispatch={dispatch}
        />
      );
    }

    // Call view — video call sub-state machine
    switch (roomState.screen.type) {
      case 'idle':
        // Safety fallback — idle screen shouldn't render in call view
        return null;

      case 'acquiring-media':
        return <AcquiringMediaScreen />;

      case 'waiting-for-peer':
      case 'negotiating':
      case 'call':
        return (
          <CallScreen
            screen={roomState.screen}
            localStream={refs.localStream.current}
            remoteStream={refs.remoteStream.current}
            dispatch={dispatch}
          />
        );

      case 'error':
        return <ErrorBanner message={roomState.screen.message} dispatch={dispatch} />;
    }
  };

  return <AppContext.Provider value={{ state, dispatch }}>{renderPhase()}</AppContext.Provider>;
}
