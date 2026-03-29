/**
 * State machine types for tuturu WebRTC client
 *
 * @remarks
 * Screen types form a discriminated union on the `type` field.
 * TypeScript narrows types in switch statements, ensuring exhaustive handling.
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

/**
 * Application state - single source of truth
 *
 * @remarks
 * - `screen`: Current UI state (what the user sees)
 * - Resources (ws, pc, streams): Mutable objects with their own lifecycle
 * - ICE config: Received from server, used for RTCPeerConnection creation
 *
 * All resources are nullable — not always present.
 */
export interface AppState {
  /** Current screen - determines what UI is shown */
  screen: Screen;

  /** WebSocket connection to signaling server */
  ws: WebSocket | null;

  /** RTCPeerConnection for WebRTC media exchange */
  pc: RTCPeerConnection | null;

  /** Local media stream (camera + microphone) */
  localStream: MediaStream | null;

  /** Remote media stream (peer's camera + microphone) */
  remoteStream: MediaStream | null;

  /** ICE server configuration (STUN/TURN servers) */
  iceServers: IceServerConfig[] | null;

  /** ICE transport policy: 'all' (default) or 'relay' (force TURN) */
  iceTransportPolicy: IceTransportPolicy;
}

/**
 * Actions - all possible state transitions
 *
 * @remarks
 * Categories:
 * 1. User Interactions (SUBMIT_PIN, TOGGLE_MUTE, etc.)
 * 2. WebSocket Lifecycle (WS_CONNECTED, WS_CLOSED, etc.)
 * 3. Media Lifecycle (MEDIA_ACQUIRED, MEDIA_ERROR)
 * 4. Signaling Messages (PEER_JOINED, RECEIVED_OFFER, etc.)
 * 5. WebRTC Lifecycle (RTC_CONNECTED, RTC_FAILED, etc.)
 */
export type Action =
  // User interactions
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

/** Initial state - application starts at PIN entry with all resources null */
export const initialState: AppState = {
  screen: { type: 'pin-entry' },
  ws: null,
  pc: null,
  localStream: null,
  remoteStream: null,
  iceServers: null,
  iceTransportPolicy: 'all',
};
