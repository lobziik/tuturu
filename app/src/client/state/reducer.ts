/**
 * Pure reducer function for tuturu state machine
 * No side effects, no I/O, no mutations - fully testable
 *
 * @module state/reducer
 */

import type { AppState, Action } from './types';

/**
 * Pure reducer - given current state and action, returns new state.
 *
 * @remarks
 * - Same inputs always produce same output
 * - No side effects, no async, no DOM
 * - State transition guards check `state.screen.type` before transitioning
 * - Invalid transitions return state unchanged
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

    case 'RECEIVED_ANSWER': {
      return state;
    }

    case 'RECEIVED_ICE_CANDIDATE': {
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
      // Stream stored in ref by dispatch wrapper, not in reducer state
      return state;
    }

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

    case 'RTC_DISCONNECTED': {
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
      if (
        state.screen.type !== 'waiting-for-peer' &&
        state.screen.type !== 'negotiating' &&
        state.screen.type !== 'call'
      ) {
        return state;
      }

      return {
        ...state,
        screen: {
          ...state.screen,
          muted: !state.screen.muted,
        },
      };
    }

    case 'TOGGLE_VIDEO': {
      if (
        state.screen.type !== 'waiting-for-peer' &&
        state.screen.type !== 'negotiating' &&
        state.screen.type !== 'call'
      ) {
        return state;
      }

      return {
        ...state,
        screen: {
          ...state.screen,
          videoOff: !state.screen.videoOff,
        },
      };
    }

    case 'TOGGLE_PIP_VISIBILITY': {
      if (
        state.screen.type !== 'waiting-for-peer' &&
        state.screen.type !== 'negotiating' &&
        state.screen.type !== 'call'
      ) {
        return state;
      }

      return {
        ...state,
        screen: {
          ...state.screen,
          pipHidden: !state.screen.pipHidden,
        },
      };
    }

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

    default: {
      const _exhaustive: never = action;
      return state;
    }
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
