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
 */
export interface EffectArgs {
  readonly prevState: AppState;
  readonly newState: AppState;
  readonly action: Action;
  /** Convenience: prevState.screen.type */
  readonly prevScreen: Screen['type'];
  /** Convenience: newState.screen.type */
  readonly newScreen: Screen['type'];
}
