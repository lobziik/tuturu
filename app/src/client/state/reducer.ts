/**
 * Pure reducer function for tuturu state machine.
 * Two-level dispatch: outer switch on phase, inner switch on action type.
 * No side effects, no I/O, no mutations — fully testable.
 *
 * @module state/reducer
 */

import type { AppState, Action, RoomState, Screen, PeerConnectionStatus } from './types';
import type { ChatMessage } from '../../shared/schemas';
import type { PeerState } from '../../shared/types';

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
      callPeers: [],
      peerConnectionStates: {},
      sfuMode: false,
      activeSpeakerPeerId: null,
      overlay: null,
    };
  }
  return state;
}

// ============================================================================
// Phase: room — helpers
// ============================================================================

/** Screen types that support media controls (mute, video, PiP) */
type MediaControlScreen = Extract<Screen, { type: 'waiting-for-peer' | 'call' }>;

function isMediaControlScreen(screen: Screen): screen is MediaControlScreen {
  return screen.type === 'waiting-for-peer' || screen.type === 'call';
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
      if (state.screen.type === 'waiting-for-peer' || state.screen.type === 'call') {
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
    case 'PEER_NICKNAME_RESOLVED':
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

    // Overlays
    case 'OPEN_OVERLAY':
      return { ...state, overlay: action.overlay };
    case 'CLOSE_OVERLAY':
      if (state.overlay === null) return state;
      return { ...state, overlay: null };

    // Settings
    case 'CHANGE_NICKNAME':
      return { ...state, nickname: action.nickname, overlay: null, wsStatus: 'connecting' };
    case 'CLEAR_HISTORY':
      return {
        ...state,
        messages: [],
        messageUuids: new Set(),
        historyCursor: null,
        historyHasMore: false,
        overlay: null,
      };
    case 'LEAVE_ROOM':
      return { phase: 'login', nickname: state.nickname };

    // SFU lifecycle
    case 'SFU_ACTIVE_SPEAKER':
      return { ...state, activeSpeakerPeerId: action.peerId };
    // SFU actions handled purely in effects — no state change (except SFU_NEW_CONSUMER)
    case 'SFU_ROUTER_CAPS_RECEIVED':
    case 'SFU_TRANSPORT_CREATED':
    case 'SFU_PRODUCER_CREATED':
      return state;
    // SFU_NEW_CONSUMER: transition waiting-for-peer → call, mark peer as 'connecting'.
    // The peer is promoted to 'connected' by RTC_CONNECTED dispatched from the SFU
    // effect AFTER the consumer is created and the stream is in refs — this ensures
    // the re-render that picks up the stream happens after it's actually ready.
    case 'SFU_NEW_CONSUMER': {
      if (state.screen.type === 'waiting-for-peer') {
        return {
          ...state,
          peerConnectionStates: {
            ...state.peerConnectionStates,
            [action.peerId]: 'connecting',
          },
          screen: {
            type: 'call',
            muted: state.screen.muted,
            videoOff: state.screen.videoOff,
            pipHidden: state.screen.pipHidden,
          },
        };
      }
      // In call: track peer as connecting (consumer creation is async)
      if (state.screen.type === 'call') {
        return {
          ...state,
          peerConnectionStates: {
            ...state.peerConnectionStates,
            [action.peerId]: 'connecting',
          },
        };
      }
      return state;
    }

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
      | 'PEER_LEFT_ROOM'
      | 'PEER_NICKNAME_RESOLVED';
  }
>;

function roomConnectionReducer(state: RoomState, action: ConnectionAction): AppState {
  switch (action.type) {
    case 'WS_ROOM_CONNECTED':
      return { ...state, wsStatus: 'connected', reconnectAttempt: 0, loadingHistory: false };

    case 'WS_ROOM_DISCONNECTED':
    case 'WS_RECONNECT_EXHAUSTED': {
      const inLocalCall = ['call', 'waiting-for-peer'].includes(state.screen.type);
      return {
        ...state,
        wsStatus: 'disconnected',
        reconnectAttempt: 0,
        callActive: false,
        callPeers: [],
        peerConnectionStates: {},
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
      const peers: Record<string, PeerState> = {};
      for (const p of action.peers) {
        peers[p.peerId] = { peerId: p.peerId, encryptedNickname: p.encryptedNickname };
      }
      return { ...state, selfPeerId: action.selfPeerId, peers };
    }

    case 'PEER_JOINED_ROOM':
      return {
        ...state,
        peers: {
          ...state.peers,
          [action.peerId]: {
            peerId: action.peerId,
            encryptedNickname: action.encryptedNickname,
          },
        },
      };

    case 'PEER_LEFT_ROOM': {
      const { [action.peerId]: _removed, ...remainingPeers } = state.peers;
      return { ...state, peers: remainingPeers };
    }

    case 'PEER_NICKNAME_RESOLVED': {
      const existing = state.peers[action.peerId];
      if (!existing) return state;
      return {
        ...state,
        peers: {
          ...state.peers,
          [action.peerId]: {
            ...existing,
            nickname: action.nickname,
            encryptedNickname: undefined,
          },
        },
      };
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

/**
 * Handle CALL_PEERS_RECEIVED: update callPeers, peerConnectionStates, and screen transitions.
 *
 * Mesh logic:
 * - waiting-for-peer + remote peers → call screen (per-peer negotiation handled in effects)
 * - call + all remote peers left → waiting-for-peer (stay in call, wait for others)
 * - call + peers changed → update callPeers and peerConnectionStates (add/remove entries)
 */
function handleCallPeersReceived(
  state: RoomState,
  action: Extract<CallAction, { type: 'CALL_PEERS_RECEIVED' }>,
): AppState {
  const remotePeers = action.callPeers.filter((id) => id !== state.selfPeerId);
  const callActive = action.callPeers.length > 0;

  // Build updated peerConnectionStates: keep existing states, add 'connecting' for new peers
  const updatedStates: Record<string, PeerConnectionStatus> = {};
  for (const peerId of remotePeers) {
    updatedStates[peerId] = state.peerConnectionStates[peerId] ?? 'connecting';
  }

  // Waiting for someone → remote peers arrived → transition to call screen
  if (state.screen.type === 'waiting-for-peer' && remotePeers.length > 0) {
    return {
      ...state,
      callActive,
      callPeers: action.callPeers,
      peerConnectionStates: updatedStates,
      screen: {
        type: 'call',
        muted: state.screen.muted,
        videoOff: state.screen.videoOff,
        pipHidden: state.screen.pipHidden,
      },
    };
  }

  // In call but all remote peers left → go back to waiting-for-peer (stay in call).
  // Intentional UX: keep camera active so the user can wait for peers to rejoin
  // without re-acquiring media. User can hang up manually to release the camera.
  if (state.screen.type === 'call' && remotePeers.length === 0) {
    return {
      ...state,
      callActive,
      callPeers: action.callPeers,
      peerConnectionStates: {},
      screen: {
        type: 'waiting-for-peer',
        muted: state.screen.muted,
        videoOff: state.screen.videoOff,
        pipHidden: state.screen.pipHidden,
      },
    };
  }

  // All other cases: update callPeers and peerConnectionStates
  return {
    ...state,
    callActive,
    callPeers: action.callPeers,
    peerConnectionStates: updatedStates,
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
        sfuMode: !!action.sfuEnabled,
      };

    // Signaling actions — no state transitions, handled purely in effects
    case 'RECEIVED_OFFER':
    case 'RECEIVED_ANSWER':
    case 'RECEIVED_ICE_CANDIDATE':
    case 'RTC_TRACK_RECEIVED':
      return state;

    case 'SERVER_ERROR':
      return toErrorScreen(state, action.error, false);

    // Per-peer RTC lifecycle — update peerConnectionStates.
    // Note: waiting-for-peer → call transition can happen via two paths:
    //   1. CALL_PEERS_RECEIVED (normal: server notifies us of remote peers)
    //   2. RTC_CONNECTED below (race: offer arrived before CALL_PEERS_RECEIVED,
    //      PC was created on-demand in effects, and connected before server update)
    case 'RTC_CONNECTED': {
      const newStates = { ...state.peerConnectionStates, [action.peerId]: 'connected' as const };
      if (state.screen.type === 'waiting-for-peer') {
        return {
          ...state,
          peerConnectionStates: newStates,
          screen: {
            type: 'call',
            muted: state.screen.muted,
            videoOff: state.screen.videoOff,
            pipHidden: state.screen.pipHidden,
          },
        };
      }
      return { ...state, peerConnectionStates: newStates };
    }

    case 'RTC_DISCONNECTED': {
      return {
        ...state,
        peerConnectionStates: {
          ...state.peerConnectionStates,
          [action.peerId]: 'disconnected',
        },
      };
    }

    case 'RTC_FAILED': {
      const activeCallScreens = ['acquiring-media', 'waiting-for-peer', 'call'];
      if (!activeCallScreens.includes(state.screen.type)) return state;

      const newStates = { ...state.peerConnectionStates, [action.peerId]: 'failed' as const };
      // Only show error if ALL peers have failed (or no peers tracked yet)
      const stateValues = Object.values(newStates);
      const allFailed = stateValues.length > 0 && stateValues.every((s) => s === 'failed');
      if (allFailed) {
        return toErrorScreen({ ...state, peerConnectionStates: newStates }, action.reason, false);
      }
      return { ...state, peerConnectionStates: newStates };
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
        callPeers: [],
        peerConnectionStates: {},
        activeSpeakerPeerId: null,
      };

    case 'DISMISS_ERROR': {
      if (state.screen.type !== 'error') return state;
      return {
        ...state,
        view: 'chat',
        screen: { type: 'idle' },
        callPeers: [],
        peerConnectionStates: {},
      };
    }
  }
}
