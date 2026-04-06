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
 * idle -> (SWITCH_TO_CALL) -> acquiring-media -> waiting-for-peer ->
 * negotiating -> call -> (HANGUP) -> idle
 * ```
 *
 * Error States:
 * - Any screen can transition to `error`
 * - Error screen dismisses back to idle + chat view
 *
 * @module state/types
 */

import type { IceServerConfig, IceTransportPolicy, PeerState } from '../../shared/types';
import type { ChatMessage } from '../../shared/schemas';

// ============================================================================
// Screen types — video call sub-state machine (within room phase)
// ============================================================================

/** Screen types - discriminated union for type-safe state transitions */
export type Screen =
  | { type: 'idle' }
  | { type: 'acquiring-media' }
  | { type: 'waiting-for-peer'; muted: boolean; videoOff: boolean; pipHidden: boolean }
  | {
      type: 'negotiating';
      role: 'caller' | 'callee';
      muted: boolean;
      videoOff: boolean;
      pipHidden: boolean;
    }
  | { type: 'call'; muted: boolean; videoOff: boolean; pipHidden: boolean }
  | { type: 'error'; message: string; canRetry: boolean; previousScreen?: Screen };

// ============================================================================
// WebSocket status
// ============================================================================

/** Room-level WebSocket connection status */
export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

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
      /** Hex-encoded room identifier derived from passphrase+PIN */
      roomId: string;
      /** Persistent device identifier (UUID v4, stored in IndexedDB) */
      deviceId: string;
      /** User display name */
      nickname: string;
      /** Which view is currently visible: chat home or video call */
      view: 'chat' | 'call';
      /** Chat messages (sorted by timestamp ascending) */
      messages: ChatMessage[];
      /** Room-level WebSocket connection status */
      wsStatus: WsStatus;
      /** Server-assigned peer ID for this connection */
      selfPeerId: string | null;
      /** Connected peers in the room (peerId → PeerState) */
      peers: Record<string, PeerState>;
      /** Oldest server-assigned message ID from last history batch (pagination cursor) */
      historyCursor: number | null;
      /** Whether server indicated more history is available */
      historyHasMore: boolean;
      /** Whether a history request is currently in flight */
      loadingHistory: boolean;
      /** Video call sub-state machine */
      screen: Screen;
      /** ICE server configuration (STUN/TURN servers) */
      iceServers: IceServerConfig[] | null;
      /** ICE transport policy: 'all' (default) or 'relay' (force TURN) */
      iceTransportPolicy: IceTransportPolicy;
      /** Whether a call is currently active in the room (from server call-peers broadcast) */
      callActive: boolean;
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
 * 2. User Interactions — chat (SWITCH_TO_CALL, SEND_MESSAGE, etc.)
 * 3. User Interactions — video call (TOGGLE_MUTE, HANGUP, etc.)
 * 4. Room-level WebSocket (WS_ROOM_CONNECTED, WS_ROOM_DISCONNECTED, etc.)
 * 5. WebSocket close/error (WS_ERROR, WS_CLOSED)
 * 6. Server responses — peers (PEERS_LIST, PEER_JOINED_ROOM, PEER_LEFT_ROOM)
 * 7. Server responses — chat (CHAT_RECEIVED, CHAT_ACK, HISTORY_LOADED)
 * 8. Server responses — signaling (JOINED_ROOM, RECEIVED_OFFER, etc.)
 * 9. Heartbeat (PING_RECEIVED)
 * 10. Media Lifecycle (MEDIA_ACQUIRED, MEDIA_ERROR)
 * 11. WebRTC Lifecycle (RTC_CONNECTED, RTC_FAILED, etc.)
 */
export type Action =
  // Phase transitions
  | { type: 'SUBMIT_NICKNAME'; nickname: string }
  | { type: 'NICKNAME_LOADED'; nickname: string }
  | { type: 'SUBMIT_LOGIN'; roomId: string; aesKey: CryptoKey; deviceId: string }

  // User interactions (room phase — chat)
  | { type: 'SWITCH_TO_CALL' }
  | { type: 'SWITCH_TO_CHAT' }
  | { type: 'SEND_MESSAGE'; text: string }
  | { type: 'REQUEST_HISTORY' }

  // User interactions (room phase — video call)
  | { type: 'TOGGLE_MUTE' }
  | { type: 'TOGGLE_VIDEO' }
  | { type: 'TOGGLE_PIP_VISIBILITY' }
  | { type: 'FLIP_CAMERA' }
  | { type: 'HANGUP' }
  | { type: 'DISMISS_ERROR' }

  // Room-level WebSocket lifecycle
  | { type: 'WS_ROOM_CONNECTED' }
  | { type: 'WS_ROOM_DISCONNECTED' }
  | { type: 'WS_ROOM_RECONNECTING'; attempt: number }

  // WebSocket close/error (from browser callbacks)
  | { type: 'WS_ERROR'; error: string }
  | { type: 'WS_CLOSED'; code: number; reason: string; intentional: boolean }

  // Server responses — peers
  | {
      type: 'PEERS_LIST';
      peers: Array<{ peerId: string; encryptedNickname: string }>;
      selfPeerId: string;
    }
  | { type: 'PEER_JOINED_ROOM'; peerId: string; encryptedNickname: string; count: number }
  | { type: 'PEER_LEFT_ROOM'; peerId: string; count: number }

  // Server responses — chat
  | { type: 'CHAT_RECEIVED'; message: ChatMessage }
  | { type: 'CHAT_ACK'; uuid: string }
  | {
      type: 'HISTORY_LOADED';
      messages: ChatMessage[];
      cursor: number | null;
      hasMore: boolean;
      /** When true, this is a local IDB cache load — do not overwrite server pagination state */
      fromCache?: boolean;
    }

  // Server responses — call signaling
  | { type: 'CALL_PEERS_RECEIVED'; callPeers: string[] }

  // Server responses — signaling / ICE
  | { type: 'JOINED_ROOM'; iceServers: IceServerConfig[]; iceTransportPolicy: IceTransportPolicy }
  | { type: 'RECEIVED_OFFER'; offer: RTCSessionDescriptionInit; fromPeerId?: string }
  | { type: 'RECEIVED_ANSWER'; answer: RTCSessionDescriptionInit }
  | { type: 'RECEIVED_ICE_CANDIDATE'; candidate: RTCIceCandidateInit }
  | { type: 'SERVER_ERROR'; error: string }

  // Heartbeat
  | { type: 'PING_RECEIVED' }

  // Media lifecycle
  | { type: 'MEDIA_ACQUIRED'; stream: MediaStream; audioOnly: boolean }
  | { type: 'MEDIA_ERROR'; error: string }

  // WebRTC lifecycle
  | { type: 'RTC_CONNECTED' }
  | { type: 'RTC_DISCONNECTED' }
  | { type: 'RTC_FAILED'; reason: string }
  | { type: 'RTC_TRACK_RECEIVED'; stream: MediaStream };

/**
 * Initial state — app starts on nickname screen.
 * On mount, App.tsx checks IndexedDB for a saved nickname and dispatches
 * NICKNAME_LOADED to skip to login phase if found.
 */
export const initialState: AppState = { phase: 'nickname' };
