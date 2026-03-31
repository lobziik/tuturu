/**
 * State machine types for tuturu client.
 *
 * @remarks
 * AppState uses a phase-based discriminated union on the `phase` field.
 * Currently only the `room` phase is active (v1 video call flow).
 * `nickname` and `login` phases will be populated in Session 5.
 *
 * Within the `room` phase, `Screen` is a nested discriminated union on `type`
 * that drives the video call sub-state machine.
 *
 * Screen Transition Flow (Happy Path):
 * ```
 * pin-entry -> connecting -> acquiring-media -> waiting-for-peer ->
 * negotiating -> call
 * ```
 *
 * Error States:
 * - Any screen can transition to `error`
 * - Error screen can return to `pin-entry` (if canRetry=true)
 *
 * @module state/types
 */

import type { IceServerConfig, IceTransportPolicy } from '../../types';

// ============================================================================
// Screen types — video call sub-state machine (within room phase)
// ============================================================================

/** Screen types - discriminated union for type-safe state transitions */
export type Screen =
  | { type: 'pin-entry' }
  | { type: 'connecting'; pin: string }
  | { type: 'acquiring-media'; pin: string }
  | { type: 'waiting-for-peer'; pin: string; muted: boolean; videoOff: boolean; pipHidden: boolean }
  | {
      type: 'negotiating';
      pin: string;
      role: 'caller' | 'callee';
      muted: boolean;
      videoOff: boolean;
      pipHidden: boolean;
    }
  | { type: 'call'; pin: string; muted: boolean; videoOff: boolean; pipHidden: boolean }
  | { type: 'error'; message: string; canRetry: boolean; previousScreen?: Screen };

// ============================================================================
// AppState — phase-based discriminated union
// ============================================================================

/**
 * Application state — discriminated union on `phase`.
 *
 * @remarks
 * - `nickname`: First launch, user enters display name
 * - `login`: User enters passphrase + PIN for key derivation
 * - `room`: Active session — video call sub-state machine + (future) chat
 *
 * Mutable resources (ws, pc, localStream, remoteStream) live in useRef,
 * NOT on state. This keeps the reducer pure and state serializable.
 */
export type AppState =
  | { phase: 'nickname' }
  | { phase: 'login'; nickname: string }
  | {
      phase: 'room';
      /** Video call sub-state machine */
      screen: Screen;
      /** ICE server configuration (STUN/TURN servers) */
      iceServers: IceServerConfig[] | null;
      /** ICE transport policy: 'all' (default) or 'relay' (force TURN) */
      iceTransportPolicy: IceTransportPolicy;
    };

/** Extract the room-phase state for components that only operate in room phase */
export type RoomState = Extract<AppState, { phase: 'room' }>;

// ============================================================================
// Actions
// ============================================================================

/**
 * Actions — all possible state transitions.
 *
 * @remarks
 * Categories:
 * 1. Phase Transitions (SUBMIT_NICKNAME, NICKNAME_LOADED, SUBMIT_LOGIN)
 * 2. User Interactions (SUBMIT_PIN, TOGGLE_MUTE, etc.)
 * 3. WebSocket Lifecycle (WS_CONNECTED, WS_CLOSED, etc.)
 * 4. Media Lifecycle (MEDIA_ACQUIRED, MEDIA_ERROR)
 * 5. Signaling Messages (PEER_JOINED, RECEIVED_OFFER, etc.)
 * 6. WebRTC Lifecycle (RTC_CONNECTED, RTC_FAILED, etc.)
 */
export type Action =
  // Phase transitions
  | { type: 'SUBMIT_NICKNAME'; nickname: string }
  | { type: 'NICKNAME_LOADED'; nickname: string }
  | { type: 'SUBMIT_LOGIN' }

  // User interactions (room phase — video call)
  | { type: 'SUBMIT_PIN'; pin: string }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'TOGGLE_VIDEO' }
  | { type: 'TOGGLE_PIP_VISIBILITY' }
  | { type: 'FLIP_CAMERA' }
  | { type: 'HANGUP' }
  | { type: 'DISMISS_ERROR' }

  // WebSocket lifecycle
  | { type: 'WS_CONNECTED' }
  | { type: 'WS_ERROR'; error: string }
  | { type: 'WS_CLOSED'; code: number; reason: string; intentional: boolean }

  // Media lifecycle
  | { type: 'MEDIA_ACQUIRED'; stream: MediaStream; audioOnly: boolean }
  | { type: 'MEDIA_ERROR'; error: string }

  // Signaling messages
  | { type: 'JOINED_ROOM'; iceServers: IceServerConfig[]; iceTransportPolicy: IceTransportPolicy }
  | { type: 'PEER_JOINED' }
  | { type: 'PEER_LEFT' }
  | { type: 'RECEIVED_OFFER'; offer: RTCSessionDescriptionInit }
  | { type: 'RECEIVED_ANSWER'; answer: RTCSessionDescriptionInit }
  | { type: 'RECEIVED_ICE_CANDIDATE'; candidate: RTCIceCandidateInit }
  | { type: 'SERVER_ERROR'; error: string }

  // WebRTC lifecycle
  | { type: 'RTC_CONNECTED' }
  | { type: 'RTC_DISCONNECTED' }
  | { type: 'RTC_FAILED'; reason: string }
  | { type: 'RTC_TRACK_RECEIVED'; stream: MediaStream };

/**
 * Initial state — app starts directly in room phase (v1 compatibility).
 * Once Session 5 adds nickname/login UI, this will change to `{ phase: 'nickname' }`.
 */
export const initialState: AppState = {
  phase: 'room',
  screen: { type: 'pin-entry' },
  iceServers: null,
  iceTransportPolicy: 'all',
};
