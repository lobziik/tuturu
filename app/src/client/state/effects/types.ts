/**
 * Types for the side effects system.
 *
 * @remarks
 * Effect handlers receive an {@link EffectContext} (stable refs + dispatch)
 * and {@link EffectArgs} (per-action state transition info).
 * They run synchronously in the dispatch path — NOT in useEffect.
 *
 * @module state/effects/types
 */

import type { AppState, Action, Screen } from '../types';
import type { Dispatch } from '../context';
import type { IceServerConfig, IceTransportPolicy } from '../../../shared/types';

/**
 * Mutable resource refs that effect handlers read and write.
 * Each field mirrors a `useRef` container from App.tsx.
 */
export interface ResourceRefs {
  ws: { current: WebSocket | null };
  pc: { current: RTCPeerConnection | null };
  localStream: { current: MediaStream | null };
  remoteStream: { current: MediaStream | null };
  errorTimeout: { current: number | null };
  aesKey: { current: CryptoKey | null };
  /** IndexedDB connection for chat protocol operations */
  db: { current: IDBDatabase | null };
  /** Timer for 60s dead connection detection (no ping from server) */
  deadTimer: { current: number | null };
  /** Timer for reconnect with exponential backoff */
  reconnectTimer: { current: number | null };
  /** Current reconnect attempt counter (reset on successful connect) */
  reconnectAttempt: { current: number };
  /** Monotonic outgoing message sequence counter (persisted to IDB) */
  seq: { current: number };
  /** Whether seq counter has been loaded from IDB (guards against sending with seq=0) */
  seqLoaded: { current: boolean };
  /**
   * True while createOffer() → setLocalDescription() is in flight.
   * Used by handleOffer for glare detection: if makingOffer is true but
   * signalingState is still 'stable', we know an offer is pending and
   * must treat incoming offers as collisions (perfect negotiation pattern).
   */
  makingOffer: { current: boolean };
  /**
   * True after join-call is sent to the server, false after leave-call
   * is sent or WS disconnects. Guards against sending leave-call when
   * we never joined (e.g. media error before waiting-for-peer).
   */
  inCall: { current: boolean };
}

/**
 * Stable context shared across all effect handlers.
 * Created once in App.tsx; holds refs (not values) so identity never changes.
 */
export interface EffectContext {
  readonly refs: ResourceRefs;
  readonly dispatch: Dispatch;
}

/**
 * Per-dispatch arguments describing the state transition that occurred.
 * Created fresh for each action processed.
 *
 * @remarks
 * Handlers should use {@link getScreen} to access the call screen safely,
 * then check the screen's `type` directly so TypeScript can narrow.
 */
export interface EffectArgs {
  readonly prevState: AppState;
  readonly newState: AppState;
  readonly action: Action;
}

/**
 * Phase-safe screen accessor. Returns the call screen if in room phase, null otherwise.
 * Effects only apply to the video call sub-machine which exists within room phase.
 */
export function getScreen(state: AppState): Screen | null {
  return state.phase === 'room' ? state.screen : null;
}

/** ICE configuration extracted from room-phase state */
export interface IceConfig {
  iceServers: IceServerConfig[] | null;
  iceTransportPolicy: IceTransportPolicy;
}

/**
 * Phase-safe ICE config accessor. Returns ICE config if in room phase, null otherwise.
 */
export function getIceConfig(state: AppState): IceConfig | null {
  return state.phase === 'room'
    ? { iceServers: state.iceServers, iceTransportPolicy: state.iceTransportPolicy }
    : null;
}
