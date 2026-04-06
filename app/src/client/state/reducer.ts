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
  if (action.type === 'SUBMIT_NICKNAME' || action.type === 'NICKNAME_LOADED') {
    return { phase: 'login', nickname: action.nickname };
  }
  return state;
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
      messageUuids: new Set(),
      wsStatus: 'connecting',
      reconnectAttempt: 0,
      selfPeerId: null,
      peers: {},
      historyCursor: null,
      historyHasMore: false,
      loadingHistory: false,
      screen: { type: 'idle' },
      iceServers: null,
      iceTransportPolicy: 'all',
      callActive: false,
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
 * Returns null if the message is a duplicate, otherwise a new array (no mutation).
 */
function insertMessageSorted(
  messages: ChatMessage[],
  uuids: Set<string>,
  msg: ChatMessage,
): ChatMessage[] | null {
  if (uuids.has(msg.uuid)) return null;

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

/** Clone a Set and add new entries — avoids O(N) rebuild from array */
function extendSet(base: Set<string>, additions: string[]): Set<string> {
  const copy = new Set(base);
  for (const id of additions) copy.add(id);
  return copy;
}

/** Result of mergeHistory when new messages were added */
interface MergeResult {
  messages: ChatMessage[];
  addedUuids: string[];
}

/**
 * Merge history messages with existing messages.
 * Deduplicates by uuid using the Set index, sorts by timestamp ascending.
 * Returns null if no new messages were added.
 */
function mergeHistory(
  existing: ChatMessage[],
  uuids: Set<string>,
  incoming: ChatMessage[],
): MergeResult | null {
  const newMessages = incoming.filter((m) => !uuids.has(m.uuid));
  if (newMessages.length === 0) return null;

  return {
    messages: [...newMessages, ...existing].sort((a, b) => a.timestamp - b.timestamp),
    addedUuids: newMessages.map((m) => m.uuid),
  };
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
    case 'WS_RECONNECT_EXHAUSTED':
    case 'RECONNECT_REQUESTED':
    case 'WS_ERROR':
    case 'WS_CLOSED':
    case 'PEERS_LIST':
    case 'PEER_JOINED_ROOM':
    case 'PEER_LEFT_ROOM':
      return roomConnectionReducer(state, action);

    // Video call sub-machine
    case 'MEDIA_ACQUIRED':
    case 'MEDIA_ERROR':
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

    case 'CHAT_RECEIVED': {
      const inserted = insertMessageSorted(state.messages, state.messageUuids, action.message);
      if (!inserted) return state;
      return {
        ...state,
        messages: inserted,
        messageUuids: extendSet(state.messageUuids, [action.message.uuid]),
      };
    }

    case 'HISTORY_LOADED': {
      const merged = mergeHistory(state.messages, state.messageUuids, action.messages);
      if (action.fromCache) {
        if (!merged) return state;
        return {
          ...state,
          messages: merged.messages,
          messageUuids: extendSet(state.messageUuids, merged.addedUuids),
        };
      }
      return {
        ...state,
        messages: merged ? merged.messages : state.messages,
        messageUuids: merged
          ? extendSet(state.messageUuids, merged.addedUuids)
          : state.messageUuids,
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
      | 'WS_RECONNECT_EXHAUSTED'
      | 'RECONNECT_REQUESTED'
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
      return { ...state, wsStatus: 'connected', reconnectAttempt: 0, loadingHistory: false };

    case 'WS_ROOM_DISCONNECTED':
    case 'WS_RECONNECT_EXHAUSTED': {
      const inLocalCall = ['call', 'negotiating', 'waiting-for-peer'].includes(state.screen.type);
      return {
        ...state,
        wsStatus: 'disconnected',
        reconnectAttempt: 0,
        callActive: false,
        screen: inLocalCall
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
      return { ...state, wsStatus: 'reconnecting', reconnectAttempt: action.attempt };

    case 'RECONNECT_REQUESTED':
      return { ...state, wsStatus: 'reconnecting', reconnectAttempt: 0 };

    case 'WS_ERROR':
      // Don't overwrite 'reconnecting' — reconnect cycle already in progress
      if (state.wsStatus === 'reconnecting') return state;
      return { ...state, wsStatus: 'disconnected' };

    case 'WS_CLOSED':
      if (action.intentional) {
        return {
          ...state,
          wsStatus: 'disconnected',
          reconnectAttempt: 0,
          callActive: false,
          view: 'chat',
          screen: { type: 'idle' },
        };
      }
      // Don't overwrite 'reconnecting' — browser fires onclose after onerror,
      // but the reconnect cycle is already running from the WS_ERROR handler
      if (state.wsStatus === 'reconnecting') return state;
      return { ...state, wsStatus: 'disconnected', callActive: false };

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
      | 'DISMISS_ERROR';
  }
>;

/** Handle CALL_PEERS_RECEIVED: update callActive + screen transitions based on remote peer list */
function handleCallPeersReceived(
  state: RoomState,
  action: Extract<CallAction, { type: 'CALL_PEERS_RECEIVED' }>,
): AppState {
  const remotePeers = action.callPeers.filter((id) => id !== state.selfPeerId);
  const callActive = action.callPeers.length > 0;

  // Waiting for someone to negotiate with — deterministic role assignment
  // prevents glare: higher peerId creates the offer, lower waits for it.
  // Mirrors the polite/impolite split used in glare resolution as a fallback.
  if (state.screen.type === 'waiting-for-peer' && remotePeers.length > 0) {
    const shouldBecomeCaller =
      state.selfPeerId != null && remotePeers[0] != null && state.selfPeerId > remotePeers[0];
    if (shouldBecomeCaller) {
      return {
        ...state,
        callActive,
        screen: {
          type: 'negotiating',
          role: 'caller',
          muted: state.screen.muted,
          videoOff: state.screen.videoOff,
          pipHidden: state.screen.pipHidden,
        },
      };
    }
    // Lower peerId: stay on waiting-for-peer, remote peer will send the offer
    return { ...state, callActive };
  }

  // Remote peer left during active call or negotiation — call is over.
  // Force callActive=false because cleanup will send leave-call, but
  // the server broadcasts call-peers:[] to everyone EXCEPT us.
  if (
    (state.screen.type === 'call' || state.screen.type === 'negotiating') &&
    remotePeers.length === 0
  ) {
    return {
      ...state,
      callActive: false,
      view: 'chat',
      screen: { type: 'idle' },
    };
  }

  // All other cases: just update callActive
  return { ...state, callActive };
}

/** Handle RECEIVED_OFFER: only transition to callee negotiation from waiting-for-peer */
function handleReceivedOffer(state: RoomState): AppState {
  // Only waiting-for-peer transitions to callee negotiation
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

    case 'CALL_PEERS_RECEIVED':
      return handleCallPeersReceived(state, action);

    case 'JOINED_ROOM':
      return {
        ...state,
        iceServers: action.iceServers,
        iceTransportPolicy: action.iceTransportPolicy,
      };

    case 'RECEIVED_OFFER':
      return handleReceivedOffer(state);

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
      return {
        ...state,
        view: 'chat',
        screen: { type: 'idle' },
        callActive: false,
      };

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
