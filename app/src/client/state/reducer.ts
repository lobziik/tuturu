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
      screen: { type: 'idle' },
      iceServers: null,
      iceTransportPolicy: 'all',
      incomingOffer: null,
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
 *
 * TODO: dedup check is O(N) linear scan — consider Set<uuid> cache when message
 * counts exceed ~1000 (batch history loads make this O(N×M)).
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
 * Resolve new history cursor: take the minimum of existing and incoming.
 * Returns existing cursor if incoming is null (no cursor from server).
 */
function resolveHistoryCursor(existing: number | null, incoming: number | null): number | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;
  return Math.min(existing, incoming);
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
// Phase: room — main reducer (delegates to domain sub-reducers)
// ============================================================================

function roomReducer(state: RoomState, action: Action): AppState {
  switch (action.type) {
    // View switching
    case 'SWITCH_TO_CALL': {
      // If a call is already in progress, just switch the view back — don't restart
      if (
        state.screen.type === 'waiting-for-peer' ||
        state.screen.type === 'negotiating' ||
        state.screen.type === 'call'
      ) {
        return { ...state, view: 'call' };
      }
      if (state.wsStatus !== 'connected') {
        return {
          ...state,
          view: 'call',
          screen: { type: 'error', message: 'Not connected to server', canRetry: false },
        };
      }
      return { ...state, view: 'call', screen: { type: 'acquiring-media' } };
    }
    case 'SWITCH_TO_CHAT':
      return { ...state, view: 'chat' };

    // Chat
    case 'SEND_MESSAGE':
    case 'CHAT_ACK':
    case 'PING_RECEIVED':
      return state;
    case 'REQUEST_HISTORY':
    case 'CHAT_RECEIVED':
    case 'HISTORY_LOADED':
      return roomChatReducer(state, action);

    // Room-level WebSocket + peers
    case 'WS_ROOM_CONNECTED':
    case 'WS_ROOM_DISCONNECTED':
    case 'WS_ROOM_RECONNECTING':
    case 'WS_ERROR':
    case 'WS_CLOSED':
    case 'PEERS_LIST':
    case 'PEER_JOINED_ROOM':
    case 'PEER_LEFT_ROOM':
      return roomConnectionReducer(state, action);

    // Video call sub-machine
    case 'MEDIA_ACQUIRED':
    case 'MEDIA_ERROR':
    case 'PEER_JOINED_CALL':
    case 'PEER_LEFT_CALL':
    case 'CALL_PEERS_RECEIVED':
    case 'JOINED_ROOM':
    case 'RECEIVED_OFFER':
    case 'RECEIVED_ANSWER':
    case 'RECEIVED_ICE_CANDIDATE':
    case 'SERVER_ERROR':
    case 'RTC_TRACK_RECEIVED':
    case 'RTC_CONNECTED':
    case 'RTC_DISCONNECTED':
    case 'RTC_FAILED':
    case 'TOGGLE_MUTE':
    case 'TOGGLE_VIDEO':
    case 'TOGGLE_PIP_VISIBILITY':
    case 'FLIP_CAMERA':
    case 'HANGUP':
    case 'ACCEPT_CALL':
    case 'DECLINE_CALL':
    case 'DISMISS_ERROR':
      return roomCallReducer(state, action);

    // Phase transition actions — not applicable in room phase
    case 'SUBMIT_NICKNAME':
    case 'NICKNAME_LOADED':
    case 'SUBMIT_LOGIN':
      return state;
  }
}

// ============================================================================
// Room sub-reducer: chat
// ============================================================================

type ChatAction = Extract<Action, { type: 'REQUEST_HISTORY' | 'CHAT_RECEIVED' | 'HISTORY_LOADED' }>;

function roomChatReducer(state: RoomState, action: ChatAction): AppState {
  switch (action.type) {
    case 'REQUEST_HISTORY':
      if (!state.historyHasMore || state.loadingHistory) return state;
      return { ...state, loadingHistory: true };

    case 'CHAT_RECEIVED':
      return {
        ...state,
        messages: insertMessageSorted(state.messages, action.message),
      };

    case 'HISTORY_LOADED': {
      if (action.fromCache) {
        return {
          ...state,
          messages: mergeHistory(state.messages, action.messages),
        };
      }
      return {
        ...state,
        messages: mergeHistory(state.messages, action.messages),
        historyCursor: resolveHistoryCursor(state.historyCursor, action.cursor),
        historyHasMore: action.hasMore,
        loadingHistory: false,
      };
    }
  }
}

// ============================================================================
// Room sub-reducer: connection + peers
// ============================================================================

type ConnectionAction = Extract<
  Action,
  {
    type:
      | 'WS_ROOM_CONNECTED'
      | 'WS_ROOM_DISCONNECTED'
      | 'WS_ROOM_RECONNECTING'
      | 'WS_ERROR'
      | 'WS_CLOSED'
      | 'PEERS_LIST'
      | 'PEER_JOINED_ROOM'
      | 'PEER_LEFT_ROOM';
  }
>;

function roomConnectionReducer(state: RoomState, action: ConnectionAction): AppState {
  switch (action.type) {
    case 'WS_ROOM_CONNECTED':
      return { ...state, wsStatus: 'connected' };

    case 'WS_ROOM_DISCONNECTED': {
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

    case 'WS_ERROR':
      return { ...state, wsStatus: 'disconnected' };

    case 'WS_CLOSED':
      if (action.intentional) {
        return { ...state, wsStatus: 'disconnected', view: 'chat', screen: { type: 'idle' } };
      }
      return { ...state, wsStatus: 'disconnected' };

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
        peers: { ...state.peers, [action.peerId]: { peerId: action.peerId } },
      };

    case 'PEER_LEFT_ROOM': {
      const { [action.peerId]: _removed, ...remainingPeers } = state.peers;
      return { ...state, peers: remainingPeers };
    }
  }
}

// ============================================================================
// Room sub-reducer: video call
// ============================================================================

type CallAction = Extract<
  Action,
  {
    type:
      | 'MEDIA_ACQUIRED'
      | 'MEDIA_ERROR'
      | 'PEER_JOINED_CALL'
      | 'PEER_LEFT_CALL'
      | 'CALL_PEERS_RECEIVED'
      | 'JOINED_ROOM'
      | 'RECEIVED_OFFER'
      | 'RECEIVED_ANSWER'
      | 'RECEIVED_ICE_CANDIDATE'
      | 'SERVER_ERROR'
      | 'RTC_TRACK_RECEIVED'
      | 'RTC_CONNECTED'
      | 'RTC_DISCONNECTED'
      | 'RTC_FAILED'
      | 'TOGGLE_MUTE'
      | 'TOGGLE_VIDEO'
      | 'TOGGLE_PIP_VISIBILITY'
      | 'FLIP_CAMERA'
      | 'HANGUP'
      | 'ACCEPT_CALL'
      | 'DECLINE_CALL'
      | 'DISMISS_ERROR';
  }
>;

function roomCallReducer(state: RoomState, action: CallAction): AppState {
  switch (action.type) {
    case 'MEDIA_ACQUIRED': {
      if (state.screen.type !== 'acquiring-media') return state;
      return {
        ...state,
        screen: { type: 'waiting-for-peer', muted: false, videoOff: false, pipHidden: false },
      };
    }

    case 'MEDIA_ERROR': {
      if (state.screen.type !== 'acquiring-media') return state;
      return toErrorScreen(state, action.error, true, state.screen);
    }

    case 'PEER_JOINED_CALL': {
      if (state.screen.type !== 'waiting-for-peer') return state;
      return {
        ...state,
        screen: {
          type: 'negotiating',
          role: 'caller',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'CALL_PEERS_RECEIVED': {
      if (state.screen.type !== 'waiting-for-peer') return state;
      if (action.callPeers.length === 0) return state;
      return {
        ...state,
        screen: {
          type: 'negotiating',
          role: 'caller',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'PEER_LEFT_CALL': {
      if (state.screen.type === 'idle') return state;
      return { ...state, view: 'chat', screen: { type: 'idle' }, incomingOffer: null };
    }

    case 'JOINED_ROOM':
      return {
        ...state,
        iceServers: action.iceServers,
        iceTransportPolicy: action.iceTransportPolicy,
      };

    case 'RECEIVED_OFFER': {
      // Idle: stash as incoming call for user to accept/decline
      if (state.screen.type === 'idle') {
        if (state.incomingOffer !== null) return state; // already have an incoming offer
        return {
          ...state,
          incomingOffer: {
            fromPeerId: action.fromPeerId ?? 'unknown',
            offer: action.offer,
          },
        };
      }
      // Already connected: ignore
      if (state.screen.type === 'call') return state;
      // Waiting-for-peer: callee negotiation flow
      if (state.screen.type !== 'waiting-for-peer') return state;
      return {
        ...state,
        screen: {
          type: 'negotiating',
          role: 'callee',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'RECEIVED_ANSWER':
    case 'RECEIVED_ICE_CANDIDATE':
    case 'RTC_TRACK_RECEIVED':
    case 'RTC_DISCONNECTED':
      return state;

    case 'SERVER_ERROR':
      return toErrorScreen(state, action.error, false);

    case 'RTC_CONNECTED': {
      if (state.screen.type !== 'negotiating') return state;
      return {
        ...state,
        screen: {
          type: 'call',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }

    case 'RTC_FAILED': {
      const activeCallScreens = ['acquiring-media', 'waiting-for-peer', 'negotiating', 'call'];
      if (!activeCallScreens.includes(state.screen.type)) return state;
      return toErrorScreen(state, action.reason, false);
    }

    case 'TOGGLE_MUTE':
      return handleToggle(state, 'muted');
    case 'TOGGLE_VIDEO':
      return handleToggle(state, 'videoOff');
    case 'TOGGLE_PIP_VISIBILITY':
      return handleToggle(state, 'pipHidden');

    case 'FLIP_CAMERA':
      return state;

    case 'HANGUP':
      return { ...state, view: 'chat', screen: { type: 'idle' }, incomingOffer: null };

    case 'ACCEPT_CALL': {
      if (!state.incomingOffer) return state;
      return {
        ...state,
        view: 'call',
        screen: { type: 'acquiring-media' },
        incomingOffer: null,
      };
    }

    case 'DECLINE_CALL':
      return { ...state, incomingOffer: null };

    case 'DISMISS_ERROR': {
      if (state.screen.type !== 'error') return state;
      return { ...state, view: 'chat', screen: { type: 'idle' } };
    }
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
