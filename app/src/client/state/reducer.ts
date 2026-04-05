/**
 * Pure reducer function for tuturu state machine.
 * Two-level dispatch: outer switch on phase, inner switch on action type.
 * No side effects, no I/O, no mutations — fully testable.
 *
 * @module state/reducer
 */

import type { AppState, Action, RoomState, Screen } from './types';
import type { ChatMessage } from '../../shared/schemas';

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
      wsStatus: 'connecting',
      selfPeerId: null,
      peers: {},
      historyCursor: null,
      historyHasMore: false,
      loadingHistory: false,
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

/**
 * Insert a message into a sorted array by timestamp, deduplicating by uuid.
 * Returns a new array (no mutation).
 */
function insertMessageSorted(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  // Dedup check — skip if uuid already exists
  if (messages.some((m) => m.uuid === msg.uuid)) {
    return messages;
  }

  // Binary search for insertion point (sorted ascending by timestamp)
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid]!.timestamp <= msg.timestamp) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const result = messages.slice();
  result.splice(lo, 0, msg);
  return result;
}

/**
 * Merge history messages with existing messages.
 * Deduplicates by uuid, sorts by timestamp ascending.
 */
function mergeHistory(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const existingUuids = new Set(existing.map((m) => m.uuid));
  const newMessages = incoming.filter((m) => !existingUuids.has(m.uuid));
  if (newMessages.length === 0) return existing;

  return [...newMessages, ...existing].sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================================
// Phase: room — main reducer
// ============================================================================

function roomReducer(state: RoomState, action: Action): AppState {
  switch (action.type) {
    // ===== VIEW SWITCHING =====
    case 'SWITCH_TO_CALL':
      return { ...state, view: 'call' };

    case 'SWITCH_TO_CHAT':
      return { ...state, view: 'chat' };

    // ===== CHAT =====
    case 'SEND_MESSAGE':
      // No state change — effect handles encryption + sending + optimistic dispatch
      return state;

    case 'REQUEST_HISTORY':
      if (!state.historyHasMore || state.loadingHistory) return state;
      return { ...state, loadingHistory: true };

    case 'CHAT_RECEIVED':
      return {
        ...state,
        messages: insertMessageSorted(state.messages, action.message),
      };

    case 'CHAT_ACK':
      // Future: mark message as delivered in UI
      return state;

    case 'HISTORY_LOADED':
      return {
        ...state,
        messages: mergeHistory(state.messages, action.messages),
        historyCursor:
          action.cursor !== null
            ? state.historyCursor === null
              ? action.cursor
              : Math.min(state.historyCursor, action.cursor)
            : state.historyCursor,
        historyHasMore: action.hasMore,
        loadingHistory: false,
      };

    // ===== ROOM-LEVEL WEBSOCKET =====
    case 'WS_ROOM_CONNECTED': {
      // If video call was waiting for WS, advance it
      const newScreen =
        state.screen.type === 'connecting'
          ? ({ type: 'acquiring-media', pin: state.screen.pin } as const)
          : state.screen;
      return { ...state, wsStatus: 'connected', screen: newScreen };
    }

    case 'WS_ROOM_DISCONNECTED': {
      // If in active video call, transition to error
      const callActive = ['call', 'negotiating', 'waiting-for-peer'].includes(state.screen.type);
      return {
        ...state,
        wsStatus: 'disconnected',
        screen: callActive
          ? {
              type: 'error',
              message: 'Connection lost',
              canRetry: true,
              previousScreen: state.screen,
            }
          : state.screen,
      };
    }

    case 'WS_ROOM_RECONNECTING':
      return { ...state, wsStatus: 'reconnecting' };

    // ===== WEBSOCKET CLOSE/ERROR (browser callbacks) =====
    case 'WS_ERROR':
      return { ...state, wsStatus: 'disconnected' };

    case 'WS_CLOSED': {
      if (action.intentional) {
        return {
          ...state,
          wsStatus: 'disconnected',
          screen: { type: 'pin-entry' },
        };
      }
      // Unintentional close — effects will handle reconnect
      return { ...state, wsStatus: 'disconnected' };
    }

    // ===== SERVER RESPONSES — PEERS =====
    case 'PEERS_LIST': {
      const peers: Record<string, { peerId: string }> = {};
      for (const p of action.peers) {
        peers[p.peerId] = { peerId: p.peerId };
      }
      return { ...state, selfPeerId: action.selfPeerId, peers };
    }

    case 'PEER_JOINED_ROOM':
      return {
        ...state,
        peers: {
          ...state.peers,
          [action.peerId]: { peerId: action.peerId },
        },
      };

    case 'PEER_LEFT_ROOM': {
      const { [action.peerId]: _removed, ...remainingPeers } = state.peers;
      return { ...state, peers: remainingPeers };
    }

    // ===== HEARTBEAT =====
    case 'PING_RECEIVED':
      // No state change — effects handle pong response + dead timer reset
      return state;

    // ===== PIN ENTRY (simplified — WS is already connected at room level) =====
    case 'SUBMIT_PIN': {
      if (state.screen.type !== 'pin-entry') return state;

      // If WS is connected, skip connecting screen → go straight to acquiring-media
      if (state.wsStatus === 'connected') {
        return {
          ...state,
          screen: { type: 'acquiring-media', pin: action.pin },
        };
      }
      // WS not ready — wait in connecting (WS_ROOM_CONNECTED will advance it)
      return {
        ...state,
        screen: { type: 'connecting', pin: action.pin },
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
    case 'JOINED_ROOM':
      return {
        ...state,
        iceServers: action.iceServers,
        iceTransportPolicy: action.iceTransportPolicy,
      };

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

    case 'HANGUP':
      return {
        ...state,
        view: 'chat',
        screen: { type: 'pin-entry' },
      };

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
export function getCloseCodeDescription(code: number): string {
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
