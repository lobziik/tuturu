/**
 * Pure reducer function for tuturu state machine.
 * Two-level dispatch: outer switch on phase, inner switch on action type.
 * No side effects, no I/O, no mutations — fully testable.
 *
 * @module state/reducer
 */

import type { AppState, Action, RoomState, Screen } from './types';

/**
 * Top-level reducer — routes to phase-specific sub-reducers.
 *
 * @remarks
 * - Same inputs always produce same output
 * - No side effects, no async, no DOM
 * - Invalid transitions return state unchanged
 */
export function reducer(state: AppState, action: Action): AppState {
  switch (state.phase) {
    case 'nickname':
      return nicknameReducer(state, action);
    case 'login':
      return loginReducer(state, action);
    case 'room':
      return roomReducer(state, action);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// ============================================================================
// Phase: nickname
// ============================================================================

function nicknameReducer(
  state: Extract<AppState, { phase: 'nickname' }>,
  action: Action,
): AppState {
  switch (action.type) {
    case 'SUBMIT_NICKNAME':
      return { phase: 'login', nickname: action.nickname };

    case 'NICKNAME_LOADED':
      return { phase: 'login', nickname: action.nickname };

    default:
      return state;
  }
}

// ============================================================================
// Phase: login
// ============================================================================

function loginReducer(state: Extract<AppState, { phase: 'login' }>, action: Action): AppState {
  if (action.type === 'SUBMIT_LOGIN') {
    // aesKey is captured into a ref by App.tsx dispatch wrapper (non-serializable)
    return {
      phase: 'room',
      roomId: action.roomId,
      deviceId: action.deviceId,
      nickname: state.nickname,
      view: 'chat',
      messages: [],
      screen: { type: 'pin-entry' },
      iceServers: null,
      iceTransportPolicy: 'all',
    };
  }
  return state;
}

// ============================================================================
// Phase: room — helpers
// ============================================================================

/** Screen types that support media controls (mute, video, PiP) */
type MediaControlScreen = Extract<Screen, { type: 'waiting-for-peer' | 'negotiating' | 'call' }>;

function isMediaControlScreen(screen: Screen): screen is MediaControlScreen {
  return (
    screen.type === 'waiting-for-peer' || screen.type === 'negotiating' || screen.type === 'call'
  );
}

/** Toggle a boolean media-control field, guarded by screen type */
function handleToggle(
  state: RoomState,
  field: keyof Pick<MediaControlScreen, 'muted' | 'videoOff' | 'pipHidden'>,
): AppState {
  if (!isMediaControlScreen(state.screen)) return state;
  return { ...state, screen: { ...state.screen, [field]: !state.screen[field] } };
}

/** Transition to error screen */
function toErrorScreen(
  state: RoomState,
  message: string,
  canRetry: boolean,
  previousScreen?: Screen,
): AppState {
  const screen: Screen = previousScreen
    ? { type: 'error', message, canRetry, previousScreen }
    : { type: 'error', message, canRetry };
  return { ...state, screen };
}

// ============================================================================
// Phase: room — video call sub-state machine
// ============================================================================

function roomReducer(state: RoomState, action: Action): AppState {
  switch (action.type) {
    // ===== VIEW SWITCHING =====
    case 'SWITCH_TO_CALL':
      return { ...state, view: 'call' };

    case 'SWITCH_TO_CHAT':
      return { ...state, view: 'chat' };

    // ===== CHAT (mock — TODO(session-8): replace with real chat actions) ===== // NOSONAR: placeholder for session-8 real chat actions
    case 'LOAD_MOCK_MESSAGES':
      return { ...state, messages: action.messages };

    case 'MOCK_SEND_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };

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

    case 'WS_ERROR':
      return toErrorScreen(state, action.error, true, state.screen);

    case 'WS_CLOSED': {
      if (action.intentional) {
        return {
          ...state,
          screen: { type: 'pin-entry' },
        };
      }

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
        screen: {
          type: 'waiting-for-peer',
          pin: state.screen.pin,
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };
    }

    case 'MEDIA_ERROR':
      return toErrorScreen(state, action.error, true, state.screen);

    // ===== SIGNALING =====
    case 'JOINED_ROOM': {
      return {
        ...state,
        iceServers: action.iceServers,
        iceTransportPolicy: action.iceTransportPolicy,
      };
    }

    case 'PEER_JOINED': {
      if (state.screen.type !== 'waiting-for-peer') return state;

      return {
        ...state,
        screen: {
          type: 'negotiating',
          pin: state.screen.pin,
          role: 'caller',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
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
          role: 'callee',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'RECEIVED_ANSWER':
      return state;

    case 'RECEIVED_ICE_CANDIDATE':
      return state;

    case 'PEER_LEFT':
      return toErrorScreen(state, 'The other person left the call', false);

    case 'SERVER_ERROR':
      return toErrorScreen(state, action.error, false);

    // ===== WEBRTC LIFECYCLE =====
    case 'RTC_TRACK_RECEIVED':
      // Stream stored in ref by dispatch wrapper, not in reducer state
      return state;

    case 'RTC_CONNECTED': {
      if (state.screen.type !== 'negotiating') return state;

      return {
        ...state,
        screen: {
          type: 'call',
          pin: state.screen.pin,
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'RTC_DISCONNECTED':
      return state;

    case 'RTC_FAILED':
      return toErrorScreen(state, action.reason, false);

    // ===== IN-CALL ACTIONS =====
    case 'TOGGLE_MUTE':
      return handleToggle(state, 'muted');

    case 'TOGGLE_VIDEO':
      return handleToggle(state, 'videoOff');

    case 'TOGGLE_PIP_VISIBILITY':
      return handleToggle(state, 'pipHidden');

    case 'FLIP_CAMERA': {
      if (state.screen.type !== 'call') return state;
      return state;
    }

    case 'HANGUP': {
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

    // Phase transition actions — not applicable in room phase
    case 'SUBMIT_NICKNAME':
    case 'NICKNAME_LOADED':
    case 'SUBMIT_LOGIN':
      return state;
  }
}

/** Get human-readable description for WebSocket close codes (RFC 6455) */
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
