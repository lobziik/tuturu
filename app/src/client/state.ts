/**
 * State machine for tuturu WebRTC client
 * Pure state management with no side effects
 *
 * @remarks
 * Architecture Pattern: Unidirectional Data Flow
 *
 * ```
 * User Action → dispatch(action) → reducer(state, action) → new state → render(state)
 *                                          ↓
 *                                   side effects (async)
 * ```
 *
 * Benefits:
 * - Predictable: All state transitions explicit in reducer
 * - Testable: Pure reducer function, easy to unit test
 * - Debuggable: Action log provides complete history
 * - Type-safe: TypeScript ensures exhaustive pattern matching
 *
 * State Machine Principles:
 * 1. Single source of truth (AppState)
 * 2. State is read-only (immutable updates)
 * 3. Changes made with pure functions (reducer)
 * 4. Side effects handled separately (effects.ts)
 *
 * @module state
 */

import type { IceServerConfig } from '../types';

/**
 * Screen types - discriminated union for type-safe state transitions
 *
 * @remarks
 * Discriminated Union Pattern:
 * - TypeScript uses `type` field to narrow types
 * - Enables exhaustive pattern matching in switch statements
 * - Compiler ensures all cases are handled
 *
 * Screen Transition Flow (Happy Path):
 * ```
 * pin-entry → connecting → acquiring-media → waiting-for-peer →
 * negotiating → call
 * ```
 *
 * Error States:
 * - Any screen can transition to `error`
 * - Error screen can return to `pin-entry` (if canRetry=true)
 *
 * Future Extensions:
 * - Add `reconnecting` screen for network recovery
 * - Add `quality-warning` for poor connection indication
 */
export type Screen =
  | { type: 'pin-entry' }
  | { type: 'connecting'; pin: string }
  | { type: 'acquiring-media'; pin: string }
  | { type: 'waiting-for-peer'; pin: string }
  | { type: 'negotiating'; pin: string; role: 'caller' | 'callee' }
  | { type: 'call'; pin: string; muted: boolean; videoOff: boolean }
  | { type: 'error'; message: string; canRetry: boolean; previousScreen?: Screen };

/**
 * Application state - single source of truth
 *
 * @remarks
 * State Organization:
 * - `screen`: Current UI state (what the user sees)
 * - Resources: External objects with their own lifecycle
 *
 * Why Resources are Separate:
 * - Screen changes don't always require resource changes
 * - Resources need explicit cleanup (WebSocket.close(), MediaStream.stop())
 * - Resources are mutable objects, screen is immutable data
 *
 * Resource Lifecycle:
 * - Created as side effects (effects.ts)
 * - Stored in state for access across modules
 * - Cleaned up on hangup or error
 *
 * Null Safety:
 * - All resources nullable (not always present)
 * - Type guards required before use
 * - Prevents null reference errors
 */
export interface AppState {
  /**
   * Current screen - determines what UI is shown
   * Discriminated union provides type-safe access to screen-specific data
   */
  screen: Screen;

  // ===== Resources (lifecycle managed separately from screen state) =====

  /**
   * WebSocket connection to signaling server
   * - Created on SUBMIT_PIN action
   * - Closed on HANGUP or terminal errors
   * - Used for: join-pin, offer/answer exchange, ICE candidates
   */
  ws: WebSocket | null;

  /**
   * RTCPeerConnection for WebRTC media exchange
   * - Created when peer joins or offer received
   * - Closed on HANGUP or connection failure
   * - Manages: media tracks, ICE negotiation, DTLS/SRTP
   */
  pc: RTCPeerConnection | null;

  /**
   * Local media stream (camera + microphone)
   * - Acquired via getUserMedia
   * - Stopped on HANGUP or page unload
   * - May be audio-only if camera unavailable
   */
  localStream: MediaStream | null;

  /**
   * Remote media stream (peer's camera + microphone)
   * - Received via RTCPeerConnection.ontrack
   * - Automatically cleaned up when peer connection closes
   * - Displayed in main video element
   */
  remoteStream: MediaStream | null;

  /**
   * ICE server configuration (STUN/TURN servers)
   * - Received from server on join-pin response
   * - Used to create RTCPeerConnection
   * - Required for NAT traversal and firewall bypass
   */
  iceServers: IceServerConfig[] | null;
}

/**
 * Actions - all possible state transitions
 *
 * @remarks
 * Action Pattern:
 * - Describes WHAT happened (not HOW to handle it)
 * - Past tense naming (SUBMITTED, RECEIVED, CONNECTED)
 * - Payload data included for context
 *
 * Action Categories:
 * 1. User Interactions (SUBMIT_PIN, TOGGLE_MUTE, etc.)
 * 2. WebSocket Lifecycle (WS_CONNECTED, WS_CLOSED, etc.)
 * 3. Media Lifecycle (MEDIA_ACQUIRED, MEDIA_ERROR)
 * 4. Signaling Messages (PEER_JOINED, RECEIVED_OFFER, etc.)
 * 5. WebRTC Lifecycle (RTC_CONNECTED, RTC_FAILED, etc.)
 *
 * Naming Convention:
 * - RESOURCE_EVENT format (e.g., WS_CONNECTED, RTC_FAILED)
 * - RECEIVED_MESSAGE for incoming messages
 * - TOGGLE/SUBMIT for user actions
 *
 * Type Safety:
 * - Discriminated union on `type` field
 * - TypeScript ensures exhaustive handling in reducer
 * - Compiler error if action case is missed
 */
export type Action =
  // User interactions
  | { type: 'SUBMIT_PIN'; pin: string }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'TOGGLE_VIDEO' }
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
  | { type: 'JOINED_ROOM'; iceServers: IceServerConfig[] }
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
 * Initial state - application starts at PIN entry
 *
 * @remarks
 * Clean Slate:
 * - All resources null (nothing acquired yet)
 * - PIN entry screen shown
 * - Ready for user to enter PIN and connect
 *
 * Idempotent Initialization:
 * - Can reset to this state after hangup
 * - Cleanup sets state back to initial
 * - No lingering resources or state
 */
export const initialState: AppState = {
  screen: { type: 'pin-entry' },
  ws: null,
  pc: null,
  localStream: null,
  remoteStream: null,
  iceServers: null,
};

/**
 * Pure reducer function - given current state and action, return new state
 * No side effects, no I/O, no mutations - fully testable
 *
 * @param state - Current application state
 * @param action - Action describing what happened
 * @returns New state after applying action
 *
 * @remarks
 * Reducer Principles:
 * 1. **Pure Function**: Same inputs always produce same output
 * 2. **No Side Effects**: No API calls, no DOM manipulation, no timers
 * 3. **Immutable Updates**: Always return new state object
 * 4. **Synchronous**: No async/await, no promises
 *
 * State Transition Guards:
 * - Many actions only valid in specific screens
 * - Guards check `state.screen.type` before transitioning
 * - Invalid transitions return state unchanged (idempotent)
 *
 * Example:
 * ```typescript
 * // TOGGLE_MUTE only works in 'call' screen
 * if (state.screen.type !== 'call') return state;
 * ```
 *
 * Testing Strategy:
 * - Test each action type independently
 * - Test guard conditions (e.g., TOGGLE_MUTE in pin-entry → no change)
 * - Test state preservation (return same reference if no change)
 * - Test exhaustiveness (compiler ensures all actions handled)
 *
 * Error Handling Philosophy:
 * - **FAIL FAST**: Transition to error state with clear message
 * - **FAIL LOUD**: Error messages are actionable (tell user what to do)
 * - **No Silent Failures**: Never ignore errors or return null/default
 *
 * Future Extensions:
 * - Add reconnection logic (RECONNECT_ATTEMPT, RECONNECT_SUCCESS)
 * - Add quality indicators (RTC_QUALITY_DEGRADED)
 * - Add multiple peer support (extend state to track peer array)
 */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    // ===== PIN ENTRY =====
    case 'SUBMIT_PIN': {
      if (state.screen.type !== 'pin-entry') return state;

      return {
        ...state,
        screen: { type: 'connecting', pin: action.pin },
      };
    }

    // ===== WEBSOCKET LIFECYCLE =====
    case 'WS_CONNECTED': {
      if (state.screen.type !== 'connecting') return state;

      return {
        ...state,
        screen: { type: 'acquiring-media', pin: state.screen.pin },
      };
    }

    case 'WS_ERROR': {
      return {
        ...state,
        screen: {
          type: 'error',
          message: action.error,
          canRetry: true,
          previousScreen: state.screen,
        },
      };
    }

    case 'WS_CLOSED': {
      // Intentional close (hangup) - go to pin-entry
      if (action.intentional) {
        return {
          ...state,
          screen: { type: 'pin-entry' },
        };
      }

      // Unexpected close - show error
      const errorMessage = action.reason || getCloseCodeDescription(action.code);
      return {
        ...state,
        screen: {
          type: 'error',
          message: `Connection closed: ${errorMessage}`,
          canRetry: true,
          previousScreen: state.screen,
        },
      };
    }

    // ===== MEDIA LIFECYCLE =====
    case 'MEDIA_ACQUIRED': {
      if (state.screen.type !== 'acquiring-media') return state;

      return {
        ...state,
        localStream: action.stream,
        screen: { type: 'waiting-for-peer', pin: state.screen.pin },
      };
    }

    case 'MEDIA_ERROR': {
      return {
        ...state,
        screen: {
          type: 'error',
          message: action.error,
          canRetry: true,
          previousScreen: state.screen,
        },
      };
    }

    // ===== SIGNALING =====
    case 'JOINED_ROOM': {
      // Store ICE servers (needed for later PeerConnection creation)
      return {
        ...state,
        iceServers: action.iceServers,
      };
    }

    case 'PEER_JOINED': {
      if (state.screen.type !== 'waiting-for-peer') return state;

      return {
        ...state,
        screen: {
          type: 'negotiating',
          pin: state.screen.pin,
          role: 'caller', // We're the first peer, we create offer
        },
      };
    }

    case 'RECEIVED_OFFER': {
      if (state.screen.type !== 'waiting-for-peer') return state;

      return {
        ...state,
        screen: {
          type: 'negotiating',
          pin: state.screen.pin,
          role: 'callee', // We received offer, we create answer
        },
      };
    }

    case 'RECEIVED_ANSWER': {
      // Answer received, stay in negotiating until RTC_CONNECTED
      return state;
    }

    case 'RECEIVED_ICE_CANDIDATE': {
      // ICE candidates are handled as side effects, no state change
      return state;
    }

    case 'PEER_LEFT': {
      return {
        ...state,
        screen: {
          type: 'error',
          message: 'The other person left the call',
          canRetry: false,
        },
      };
    }

    case 'SERVER_ERROR': {
      return {
        ...state,
        screen: {
          type: 'error',
          message: action.error,
          canRetry: false,
        },
      };
    }

    // ===== WEBRTC LIFECYCLE =====
    case 'RTC_TRACK_RECEIVED': {
      return {
        ...state,
        remoteStream: action.stream,
      };
    }

    case 'RTC_CONNECTED': {
      if (state.screen.type !== 'negotiating') return state;

      return {
        ...state,
        screen: {
          type: 'call',
          pin: state.screen.pin,
          muted: false,
          videoOff: false,
        },
      };
    }

    case 'RTC_DISCONNECTED': {
      // Stay in current state, show warning but don't error yet
      // (connection might recover)
      return state;
    }

    case 'RTC_FAILED': {
      return {
        ...state,
        screen: {
          type: 'error',
          message: action.reason,
          canRetry: false,
        },
      };
    }

    // ===== IN-CALL ACTIONS =====
    case 'TOGGLE_MUTE': {
      if (state.screen.type !== 'call') return state;

      return {
        ...state,
        screen: {
          ...state.screen,
          muted: !state.screen.muted,
        },
      };
    }

    case 'TOGGLE_VIDEO': {
      if (state.screen.type !== 'call') return state;

      return {
        ...state,
        screen: {
          ...state.screen,
          videoOff: !state.screen.videoOff,
        },
      };
    }

    case 'HANGUP': {
      // Cleanup happens in side effects, state goes to pin-entry
      return {
        ...state,
        screen: { type: 'pin-entry' },
      };
    }

    // ===== ERROR HANDLING =====
    case 'DISMISS_ERROR': {
      if (state.screen.type !== 'error') return state;

      return {
        ...state,
        screen: { type: 'pin-entry' },
      };
    }

    default: {
      // Exhaustiveness check - TypeScript will error if we miss a case
      const _exhaustive: never = action;
      return state;
    }
  }
}

/**
 * Get human-readable description for WebSocket close codes
 *
 * @param code - WebSocket close code (1000-1011 standard range)
 * @returns User-friendly description of why connection closed
 *
 * @remarks
 * Standard WebSocket Close Codes (RFC 6455):
 * - 1000: Normal closure (clean disconnect)
 * - 1001: Going away (server shutting down, user navigating away)
 * - 1002: Protocol error (invalid WebSocket frame)
 * - 1006: Abnormal closure (no close frame received, likely network issue)
 * - 1008: Policy violation (e.g., message validation failed)
 *
 * Application-Specific Handling:
 * - Code 1000 + reason "User ended call" → Intentional disconnect (HANGUP)
 * - Code 1006 → Network issue, should show retry option
 * - Other codes → Server or protocol errors
 *
 * Error Message Philosophy:
 * - Technical accuracy (explain what happened)
 * - User-friendly language (avoid jargon)
 * - Include code for debugging (in parentheses)
 *
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4
 */
function getCloseCodeDescription(code: number): string {
  switch (code) {
    case 1000:
      return 'Normal closure';
    case 1001:
      return 'Server going away';
    case 1002:
      return 'Protocol error';
    case 1003:
      return 'Unsupported data type';
    case 1006:
      return 'Connection lost (no close frame)';
    case 1007:
      return 'Invalid message data';
    case 1008:
      return 'Policy violation';
    case 1009:
      return 'Message too large';
    case 1011:
      return 'Server error';
    default:
      return `Unexpected error (code ${code})`;
  }
}
