/**
 * Unit tests for state machine reducer
 * Tests all state transitions without requiring WebRTC/WebSocket mocks
 *
 * @module state/reducer.test
 */

import { describe, test, expect } from 'bun:test';
import { reducer } from './reducer';
import type { Action, AppState, RoomState, Screen } from './types';
import type { ChatMessage } from '../../shared/schemas';

// ============================================================================
// Test helpers
// ============================================================================

/** Build a room-phase state with a given screen */
function roomState(
  screen: Screen,
  overrides?: Partial<Omit<RoomState, 'phase' | 'screen'>>,
): RoomState {
  const base: RoomState = {
    phase: 'room',
    roomId: 'test-room-id',
    deviceId: 'test-device-id',
    nickname: 'TestUser',
    view: 'chat',
    messages: [],
    messageUuids: new Set<string>(),
    wsStatus: 'connected',
    reconnectAttempt: 0,
    selfPeerId: null,
    peers: {},
    historyCursor: null,
    historyHasMore: false,
    loadingHistory: false,
    screen,
    iceServers: null,
    iceTransportPolicy: 'all',
    callActive: false,
    callPeers: [],
    peerConnectionStates: {},
    overlay: null,
    ...overrides,
  };
  // Keep messageUuids in sync with messages unless explicitly overridden
  if (overrides?.messages && !overrides.messageUuids) {
    base.messageUuids = new Set(base.messages.map((m) => m.uuid));
  }
  return base;
}

/** Assert state is in room phase and return narrowed type */
function expectRoom(state: AppState): RoomState {
  expect(state.phase).toBe('room');
  if (state.phase !== 'room') throw new Error('Expected room phase');
  return state;
}

/** Build a minimal ChatMessage for testing */
function chatMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    v: 1,
    deviceId: 'other-device',
    seq: 1,
    uuid: `msg-${crypto.randomUUID()}`,
    sender: 'Other',
    timestamp: Date.now(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

describe('reducer', () => {
  // ========================================================================
  // Phase transitions
  // ========================================================================

  describe('Phase transitions', () => {
    test('SUBMIT_NICKNAME transitions from nickname to login', () => {
      const state: AppState = { phase: 'nickname' };
      const action: Action = { type: 'SUBMIT_NICKNAME', nickname: 'Mama' };
      const newState = reducer(state, action);

      expect(newState.phase).toBe('login');
      if (newState.phase === 'login') {
        expect(newState.nickname).toBe('Mama');
      }
    });

    test('NICKNAME_LOADED transitions from nickname to login', () => {
      const state: AppState = { phase: 'nickname' };
      const action: Action = { type: 'NICKNAME_LOADED', nickname: 'Papa' };
      const newState = reducer(state, action);

      expect(newState.phase).toBe('login');
      if (newState.phase === 'login') {
        expect(newState.nickname).toBe('Papa');
      }
    });

    test('SUBMIT_LOGIN transitions from login to room with correct initial state', () => {
      const state: AppState = { phase: 'login', nickname: 'Mama' };
      const mockAesKey = {} as CryptoKey;
      const action: Action = {
        type: 'SUBMIT_LOGIN',
        roomId: 'abc123',
        aesKey: mockAesKey,
        deviceId: 'device-1',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.roomId).toBe('abc123');
      expect(room.deviceId).toBe('device-1');
      expect(room.nickname).toBe('Mama');
      expect(room.view).toBe('chat');
      expect(room.messages).toEqual([]);
      expect(room.wsStatus).toBe('connecting');
      expect(room.reconnectAttempt).toBe(0);
      expect(room.selfPeerId).toBeNull();
      expect(room.peers).toEqual({});
      expect(room.historyCursor).toBeNull();
      expect(room.historyHasMore).toBe(false);
      expect(room.loadingHistory).toBe(false);
      expect(room.screen.type).toBe('idle');
      expect(room.iceServers).toBeNull();
      expect(room.iceTransportPolicy).toBe('all');
      expect(room.callActive).toBe(false);
      expect(room.overlay).toBeNull();
    });

    test('SUBMIT_NICKNAME is ignored in room phase', () => {
      const state = roomState({ type: 'idle' });
      const action: Action = { type: 'SUBMIT_NICKNAME', nickname: 'test' };
      expect(reducer(state, action)).toBe(state);
    });

    test('SUBMIT_LOGIN is ignored in room phase', () => {
      const state = roomState({ type: 'idle' });
      const mockAesKey = {} as CryptoKey;
      const action: Action = {
        type: 'SUBMIT_LOGIN',
        roomId: 'abc123',
        aesKey: mockAesKey,
        deviceId: 'device-1',
      };
      expect(reducer(state, action)).toBe(state);
    });
  });

  // ========================================================================
  // Room-level WebSocket lifecycle
  // ========================================================================

  describe('Room-level WebSocket lifecycle', () => {
    test('WS_ROOM_CONNECTED sets wsStatus to connected', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'connecting' });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_CONNECTED' }));
      expect(room.wsStatus).toBe('connected');
    });

    test('WS_ROOM_DISCONNECTED sets wsStatus and errors active call', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        {
          wsStatus: 'connected',
          callPeers: ['peer-a', 'peer-b'],
          peerConnectionStates: { 'peer-a': 'connected', 'peer-b': 'connecting' },
        },
      );
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_DISCONNECTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.screen.type).toBe('error');
      expect(room.callActive).toBe(false);
      expect(room.callPeers).toEqual([]);
      expect(room.peerConnectionStates).toEqual({});
    });

    test('WS_ROOM_DISCONNECTED does not affect chat view screen', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_DISCONNECTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.screen.type).toBe('idle');
    });

    test('WS_ROOM_RECONNECTING sets wsStatus and stores attempt number', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'disconnected' });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_RECONNECTING', attempt: 5 }));
      expect(room.wsStatus).toBe('reconnecting');
      expect(room.reconnectAttempt).toBe(5);
    });

    test('WS_ROOM_CONNECTED resets reconnectAttempt', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'reconnecting', reconnectAttempt: 10 });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_CONNECTED' }));
      expect(room.wsStatus).toBe('connected');
      expect(room.reconnectAttempt).toBe(0);
    });

    test('WS_RECONNECT_EXHAUSTED sets wsStatus and errors active call', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { wsStatus: 'reconnecting', reconnectAttempt: 20 },
      );
      const room = expectRoom(reducer(state, { type: 'WS_RECONNECT_EXHAUSTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.reconnectAttempt).toBe(0);
      expect(room.screen.type).toBe('error');
    });

    test('WS_RECONNECT_EXHAUSTED does not affect chat view screen', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'reconnecting', reconnectAttempt: 20 });
      const room = expectRoom(reducer(state, { type: 'WS_RECONNECT_EXHAUSTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.screen.type).toBe('idle');
    });

    test('RECONNECT_REQUESTED sets wsStatus to reconnecting and resets attempt', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'disconnected' });
      const room = expectRoom(reducer(state, { type: 'RECONNECT_REQUESTED' }));
      expect(room.wsStatus).toBe('reconnecting');
      expect(room.reconnectAttempt).toBe(0);
    });

    test('WS_CLOSED intentional goes to idle and chat view', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(
        reducer(state, {
          type: 'WS_CLOSED',
          code: 1000,
          reason: 'Leaving room',
          intentional: true,
        }),
      );
      expect(room.screen.type).toBe('idle');
      expect(room.view).toBe('chat');
      expect(room.wsStatus).toBe('disconnected');
    });

    test('WS_CLOSED unintentional sets wsStatus to disconnected', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(
        reducer(state, { type: 'WS_CLOSED', code: 1006, reason: '', intentional: false }),
      );
      expect(room.wsStatus).toBe('disconnected');
    });

    test('WS_ERROR sets wsStatus to disconnected', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(reducer(state, { type: 'WS_ERROR', error: 'Connection failed' }));
      expect(room.wsStatus).toBe('disconnected');
    });

    test('WS_ERROR does not overwrite reconnecting status', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'reconnecting', reconnectAttempt: 3 });
      const result = reducer(state, { type: 'WS_ERROR', error: 'Connection failed' });
      expect(result).toBe(state);
    });

    test('WS_CLOSED unintentional does not overwrite reconnecting status', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'reconnecting', reconnectAttempt: 5 });
      const result = reducer(state, {
        type: 'WS_CLOSED',
        code: 1006,
        reason: '',
        intentional: false,
      });
      expect(result).toBe(state);
    });
  });

  // ========================================================================
  // Peer tracking
  // ========================================================================

  describe('Peer tracking', () => {
    test('PEERS_LIST populates peers with encryptedNickname and selfPeerId', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(
        reducer(state, {
          type: 'PEERS_LIST',
          peers: [
            { peerId: 'p1', encryptedNickname: 'enc1' },
            { peerId: 'p2', encryptedNickname: 'enc2' },
          ],
          selfPeerId: 'self-1',
        }),
      );
      expect(room.selfPeerId).toBe('self-1');
      expect(Object.keys(room.peers)).toHaveLength(2);
      expect(room.peers['p1']).toEqual({ peerId: 'p1', encryptedNickname: 'enc1' });
      expect(room.peers['p2']).toEqual({ peerId: 'p2', encryptedNickname: 'enc2' });
    });

    test('PEER_JOINED_ROOM adds peer with encryptedNickname', () => {
      const state = roomState({ type: 'idle' }, { peers: { p1: { peerId: 'p1' } } });
      const room = expectRoom(
        reducer(state, {
          type: 'PEER_JOINED_ROOM',
          peerId: 'p2',
          encryptedNickname: 'enc',
          count: 2,
        }),
      );
      expect(Object.keys(room.peers)).toHaveLength(2);
      expect(room.peers['p2']).toEqual({ peerId: 'p2', encryptedNickname: 'enc' });
    });

    test('PEER_LEFT_ROOM removes peer', () => {
      const state = roomState(
        { type: 'idle' },
        { peers: { p1: { peerId: 'p1' }, p2: { peerId: 'p2' } } },
      );
      const room = expectRoom(reducer(state, { type: 'PEER_LEFT_ROOM', peerId: 'p1', count: 1 }));
      expect(Object.keys(room.peers)).toHaveLength(1);
      expect(room.peers['p1']).toBeUndefined();
      expect(room.peers['p2']).toEqual({ peerId: 'p2' });
    });

    test('PEER_NICKNAME_RESOLVED patches nickname and clears encryptedNickname', () => {
      const state = roomState(
        { type: 'idle' },
        { peers: { p1: { peerId: 'p1', encryptedNickname: 'enc1' } } },
      );
      const room = expectRoom(
        reducer(state, { type: 'PEER_NICKNAME_RESOLVED', peerId: 'p1', nickname: 'Alice' }),
      );
      expect(room.peers['p1']!.peerId).toBe('p1');
      expect(room.peers['p1']!.nickname).toBe('Alice');
      expect(room.peers['p1']!.encryptedNickname).toBeUndefined();
    });

    test('PEER_NICKNAME_RESOLVED is no-op for absent peer', () => {
      const state = roomState({ type: 'idle' }, { peers: { p1: { peerId: 'p1' } } });
      const result = reducer(state, {
        type: 'PEER_NICKNAME_RESOLVED',
        peerId: 'gone',
        nickname: 'Ghost',
      });
      expect(result).toBe(state);
    });
  });

  // ========================================================================
  // Chat messages
  // ========================================================================

  describe('Chat messages', () => {
    test('CHAT_RECEIVED inserts message sorted by timestamp', () => {
      const msg1 = chatMessage({ timestamp: 100, uuid: 'a' });
      const msg3 = chatMessage({ timestamp: 300, uuid: 'c' });
      const state = roomState({ type: 'idle' }, { messages: [msg1, msg3] });

      const msg2 = chatMessage({ timestamp: 200, uuid: 'b' });
      const room = expectRoom(reducer(state, { type: 'CHAT_RECEIVED', message: msg2 }));
      expect(room.messages).toHaveLength(3);
      expect(room.messages[0]!.uuid).toBe('a');
      expect(room.messages[1]!.uuid).toBe('b');
      expect(room.messages[2]!.uuid).toBe('c');
    });

    test('CHAT_RECEIVED keeps messageUuids in sync', () => {
      const msg1 = chatMessage({ uuid: 'x' });
      const state = roomState({ type: 'idle' }, { messages: [msg1] });

      const msg2 = chatMessage({ uuid: 'y' });
      const room = expectRoom(reducer(state, { type: 'CHAT_RECEIVED', message: msg2 }));
      expect(room.messageUuids).toEqual(new Set(['x', 'y']));
    });

    test('CHAT_RECEIVED deduplicates by uuid', () => {
      const msg = chatMessage({ uuid: 'dup' });
      const state = roomState({ type: 'idle' }, { messages: [msg] });
      const room = expectRoom(reducer(state, { type: 'CHAT_RECEIVED', message: msg }));
      expect(room.messages).toHaveLength(1);
    });

    test('HISTORY_LOADED merges and deduplicates messages', () => {
      const existing = chatMessage({ timestamp: 300, uuid: 'c' });
      const state = roomState(
        { type: 'idle' },
        { messages: [existing], historyHasMore: false, historyCursor: null },
      );

      const incoming = [
        chatMessage({ timestamp: 100, uuid: 'a' }),
        chatMessage({ timestamp: 200, uuid: 'b' }),
        chatMessage({ timestamp: 300, uuid: 'c' }), // duplicate
      ];

      const room = expectRoom(
        reducer(state, { type: 'HISTORY_LOADED', messages: incoming, cursor: 5, hasMore: true }),
      );
      expect(room.messages).toHaveLength(3);
      expect(room.messages[0]!.uuid).toBe('a');
      expect(room.messages[1]!.uuid).toBe('b');
      expect(room.messages[2]!.uuid).toBe('c');
      expect(room.historyCursor).toBe(5);
      expect(room.historyHasMore).toBe(true);
    });

    test('HISTORY_LOADED keeps messageUuids in sync after merge', () => {
      const existing = chatMessage({ timestamp: 200, uuid: 'b' });
      const state = roomState(
        { type: 'idle' },
        { messages: [existing], historyHasMore: true, historyCursor: 10 },
      );

      const incoming = [
        chatMessage({ timestamp: 100, uuid: 'a' }),
        chatMessage({ timestamp: 200, uuid: 'b' }), // duplicate
        chatMessage({ timestamp: 300, uuid: 'c' }),
      ];

      const room = expectRoom(
        reducer(state, { type: 'HISTORY_LOADED', messages: incoming, cursor: 5, hasMore: false }),
      );
      expect(room.messageUuids).toEqual(new Set(['a', 'b', 'c']));
    });

    test('HISTORY_LOADED replayed batch is fully deduplicated', () => {
      const batch = [
        chatMessage({ timestamp: 100, uuid: 'r1' }),
        chatMessage({ timestamp: 200, uuid: 'r2' }),
      ];
      const state = roomState(
        { type: 'idle' },
        { messages: [...batch], historyCursor: 5, historyHasMore: true },
      );

      // Replay the exact same batch — nothing should change
      const room = expectRoom(
        reducer(state, { type: 'HISTORY_LOADED', messages: batch, cursor: 5, hasMore: true }),
      );
      expect(room.messages).toHaveLength(2);
      expect(room.messages).toBe(state.phase === 'room' ? state.messages : room.messages);
    });

    test('HISTORY_LOADED takes minimum cursor', () => {
      const state = roomState({ type: 'idle' }, { historyCursor: 10, historyHasMore: true });
      const room = expectRoom(
        reducer(state, { type: 'HISTORY_LOADED', messages: [], cursor: 5, hasMore: true }),
      );
      expect(room.historyCursor).toBe(5);
    });

    test('REQUEST_HISTORY sets loadingHistory', () => {
      const state = roomState({ type: 'idle' }, { historyHasMore: true, loadingHistory: false });
      const room = expectRoom(reducer(state, { type: 'REQUEST_HISTORY' }));
      expect(room.loadingHistory).toBe(true);
    });

    test('REQUEST_HISTORY is ignored when no more history', () => {
      const state = roomState({ type: 'idle' }, { historyHasMore: false, loadingHistory: false });
      expect(reducer(state, { type: 'REQUEST_HISTORY' })).toBe(state);
    });

    test('SEND_MESSAGE returns state unchanged (effects handle it)', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'SEND_MESSAGE', text: 'hello' })).toBe(state);
    });

    test('CHAT_ACK returns state unchanged', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'CHAT_ACK', uuid: 'test' })).toBe(state);
    });

    test('PING_RECEIVED returns state unchanged', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'PING_RECEIVED' })).toBe(state);
    });

    test('HISTORY_LOADED with fromCache only merges messages, does not touch pagination', () => {
      const state = roomState(
        { type: 'idle' },
        { historyCursor: 10, historyHasMore: false, loadingHistory: true },
      );

      const cached = [chatMessage({ timestamp: 100, uuid: 'x' })];
      const room = expectRoom(
        reducer(state, {
          type: 'HISTORY_LOADED',
          messages: cached,
          cursor: null,
          hasMore: true,
          fromCache: true,
        }),
      );
      expect(room.messages).toHaveLength(1);
      // Pagination state untouched
      expect(room.historyCursor).toBe(10);
      expect(room.historyHasMore).toBe(false);
      expect(room.loadingHistory).toBe(true);
    });
  });

  // ========================================================================
  // Media lifecycle
  // ========================================================================

  describe('Media lifecycle', () => {
    test('MEDIA_ACQUIRED transitions to waiting-for-peer', () => {
      const state = roomState({ type: 'acquiring-media' });
      const mockStream = {} as MediaStream;
      const room = expectRoom(
        reducer(state, { type: 'MEDIA_ACQUIRED', stream: mockStream, audioOnly: false }),
      );
      expect(room.screen.type).toBe('waiting-for-peer');
      if (room.screen.type === 'waiting-for-peer') {
        expect(room.screen.muted).toBe(false);
        expect(room.screen.videoOff).toBe(false);
      }
    });

    test('MEDIA_ERROR transitions to error state', () => {
      const state = roomState({ type: 'acquiring-media' });
      const room = expectRoom(
        reducer(state, { type: 'MEDIA_ERROR', error: 'Microphone permission denied' }),
      );
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toBe('Microphone permission denied');
        expect(room.screen.canRetry).toBe(true);
      }
    });
  });

  // ========================================================================
  // Signaling messages
  // ========================================================================

  describe('Signaling messages (mesh)', () => {
    test('CALL_PEERS_RECEIVED with remote peer transitions waiting-for-peer to call', () => {
      const state = roomState(
        {
          type: 'waiting-for-peer',
          muted: true,
          videoOff: false,
          pipHidden: false,
        },
        { selfPeerId: 'z-peer' },
      );
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['z-peer', 'a-peer'] }),
      );
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.muted).toBe(true);
      }
      expect(room.callActive).toBe(true);
      expect(room.callPeers).toEqual(['z-peer', 'a-peer']);
      expect(room.peerConnectionStates['a-peer']).toBe('connecting');
    });

    test('CALL_PEERS_RECEIVED with multiple remote peers creates states for all', () => {
      const state = roomState(
        {
          type: 'waiting-for-peer',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
        { selfPeerId: 'self' },
      );
      const room = expectRoom(
        reducer(state, {
          type: 'CALL_PEERS_RECEIVED',
          callPeers: ['self', 'peer-a', 'peer-b', 'peer-c'],
        }),
      );
      expect(room.screen.type).toBe('call');
      expect(Object.keys(room.peerConnectionStates)).toHaveLength(3);
      expect(room.peerConnectionStates['peer-a']).toBe('connecting');
      expect(room.peerConnectionStates['peer-b']).toBe('connecting');
      expect(room.peerConnectionStates['peer-c']).toBe('connecting');
    });

    test('CALL_PEERS_RECEIVED with only self does not transition waiting-for-peer', () => {
      const state = roomState(
        {
          type: 'waiting-for-peer',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
        { selfPeerId: 'self-peer' },
      );
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['self-peer'] }),
      );
      expect(room.screen.type).toBe('waiting-for-peer');
      expect(room.callActive).toBe(true);
    });

    test('CALL_PEERS_RECEIVED with empty list during call returns to waiting-for-peer', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: [] }));
      expect(room.screen.type).toBe('waiting-for-peer');
      expect(room.callActive).toBe(false);
      expect(room.peerConnectionStates).toEqual({});
    });

    test('CALL_PEERS_RECEIVED with only self during call returns to waiting-for-peer', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { selfPeerId: 'self-peer', peerConnectionStates: { 'other-peer': 'connected' } },
      );
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['self-peer'] }),
      );
      expect(room.screen.type).toBe('waiting-for-peer');
    });

    test('CALL_PEERS_RECEIVED preserves existing connection states for remaining peers', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        {
          selfPeerId: 'self',
          callPeers: ['self', 'p1', 'p2'],
          peerConnectionStates: { p1: 'connected', p2: 'connecting' },
        },
      );
      // p2 leaves, p3 joins
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['self', 'p1', 'p3'] }),
      );
      expect(room.peerConnectionStates['p1']).toBe('connected');
      expect(room.peerConnectionStates['p3']).toBe('connecting');
      expect(room.peerConnectionStates['p2']).toBeUndefined();
    });

    test('CALL_PEERS_RECEIVED updates callActive for non-participant', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['p1', 'p2'] }),
      );
      expect(room.screen.type).toBe('idle');
      expect(room.callActive).toBe(true);
    });

    test('CALL_PEERS_RECEIVED clears callActive when call ends', () => {
      const state = roomState({ type: 'idle' }, { callActive: true });
      const room = expectRoom(reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: [] }));
      expect(room.callActive).toBe(false);
    });

    test('JOINED_ROOM stores ICE servers and transport policy', () => {
      const state = roomState({ type: 'idle' });
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const room = expectRoom(
        reducer(state, {
          type: 'JOINED_ROOM',
          iceServers: mockIceServers,
          iceTransportPolicy: 'relay',
        }),
      );
      expect(room.iceServers).toBe(mockIceServers);
      expect(room.iceTransportPolicy).toBe('relay');
    });

    test('RECEIVED_OFFER returns state unchanged (handled in effects)', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      expect(
        reducer(state, {
          type: 'RECEIVED_OFFER',
          offer: { type: 'offer', sdp: 'mock sdp' },
          fromPeerId: 'peer-a',
        }),
      ).toBe(state);
    });

    test('RECEIVED_OFFER on idle screen is ignored', () => {
      const state = roomState({ type: 'idle' });
      expect(
        reducer(state, {
          type: 'RECEIVED_OFFER',
          offer: { type: 'offer', sdp: 'mock' },
          fromPeerId: 'peer-a',
        }),
      ).toBe(state);
    });

    test('SERVER_ERROR shows non-retryable error', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(reducer(state, { type: 'SERVER_ERROR', error: 'Room is full' }));
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toBe('Room is full');
        expect(room.screen.canRetry).toBe(false);
      }
    });
  });

  // ========================================================================
  // WebRTC lifecycle (mesh — per-peer)
  // ========================================================================

  describe('WebRTC lifecycle (mesh)', () => {
    test('RTC_CONNECTED updates peerConnectionStates to connected', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { peerConnectionStates: { 'peer-a': 'connecting' } },
      );
      const room = expectRoom(reducer(state, { type: 'RTC_CONNECTED', peerId: 'peer-a' }));
      expect(room.peerConnectionStates['peer-a']).toBe('connected');
      expect(room.screen.type).toBe('call');
    });

    test('RTC_CONNECTED transitions waiting-for-peer to call', () => {
      const state = roomState(
        {
          type: 'waiting-for-peer',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
        { peerConnectionStates: { 'peer-a': 'connecting' } },
      );
      const room = expectRoom(reducer(state, { type: 'RTC_CONNECTED', peerId: 'peer-a' }));
      expect(room.screen.type).toBe('call');
      expect(room.peerConnectionStates['peer-a']).toBe('connected');
    });

    test('RTC_FAILED with all peers failed shows error', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { peerConnectionStates: { 'peer-a': 'failed', 'peer-b': 'connecting' } },
      );
      const room = expectRoom(
        reducer(state, { type: 'RTC_FAILED', reason: 'ICE failed', peerId: 'peer-b' }),
      );
      expect(room.screen.type).toBe('error');
    });

    test('RTC_FAILED with some peers still connecting stays in call', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { peerConnectionStates: { 'peer-a': 'connecting', 'peer-b': 'connected' } },
      );
      const room = expectRoom(
        reducer(state, { type: 'RTC_FAILED', reason: 'ICE failed', peerId: 'peer-a' }),
      );
      expect(room.screen.type).toBe('call');
      expect(room.peerConnectionStates['peer-a']).toBe('failed');
      expect(room.peerConnectionStates['peer-b']).toBe('connected');
    });

    test('RTC_FAILED is ignored in idle state', () => {
      const state = roomState({ type: 'idle' });
      expect(
        reducer(state, { type: 'RTC_FAILED', reason: 'stale failure', peerId: 'peer-a' }),
      ).toBe(state);
    });

    test('RTC_DISCONNECTED updates peerConnectionStates', () => {
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { peerConnectionStates: { 'peer-a': 'connected' } },
      );
      const room = expectRoom(reducer(state, { type: 'RTC_DISCONNECTED', peerId: 'peer-a' }));
      expect(room.peerConnectionStates['peer-a']).toBe('disconnected');
    });

    test('RTC_TRACK_RECEIVED returns state unchanged (stream in ref)', () => {
      const state = roomState({ type: 'idle' });
      expect(
        reducer(state, {
          type: 'RTC_TRACK_RECEIVED',
          stream: {} as MediaStream,
          peerId: 'peer-a',
        }),
      ).toBe(state);
    });
  });

  // ========================================================================
  // In-call actions
  // ========================================================================

  describe('In-call actions', () => {
    test('TOGGLE_MUTE flips muted flag in call state', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'TOGGLE_MUTE' }));
      if (room.screen.type === 'call') {
        expect(room.screen.muted).toBe(true);
      }
    });

    test('TOGGLE_MUTE is ignored in idle state', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'TOGGLE_MUTE' })).toBe(state);
    });

    test('HANGUP returns to chat view and idle screen', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'HANGUP' }));
      expect(room.screen.type).toBe('idle');
      expect(room.view).toBe('chat');
    });
  });

  // ========================================================================
  // Error handling
  // ========================================================================

  describe('Error handling', () => {
    test('DISMISS_ERROR returns to idle and chat view', () => {
      const state = roomState({
        type: 'error',
        message: 'Something went wrong',
        canRetry: true,
      });
      const room = expectRoom(reducer(state, { type: 'DISMISS_ERROR' }));
      expect(room.screen.type).toBe('idle');
      expect(room.view).toBe('chat');
    });
  });

  // ========================================================================
  // Overlay management
  // ========================================================================

  describe('Overlay management', () => {
    test('OPEN_OVERLAY sets overlay to peers', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(reducer(state, { type: 'OPEN_OVERLAY', overlay: 'peers' }));
      expect(room.overlay).toBe('peers');
    });

    test('OPEN_OVERLAY sets overlay to settings', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(reducer(state, { type: 'OPEN_OVERLAY', overlay: 'settings' }));
      expect(room.overlay).toBe('settings');
    });

    test('CLOSE_OVERLAY clears overlay', () => {
      const state = roomState({ type: 'idle' }, { overlay: 'peers' });
      const room = expectRoom(reducer(state, { type: 'CLOSE_OVERLAY' }));
      expect(room.overlay).toBeNull();
    });

    test('CLOSE_OVERLAY is no-op when already null', () => {
      const state = roomState({ type: 'idle' });
      const room = expectRoom(reducer(state, { type: 'CLOSE_OVERLAY' }));
      expect(room.overlay).toBeNull();
    });
  });

  // ========================================================================
  // Settings actions
  // ========================================================================

  describe('Settings actions', () => {
    test('CHANGE_NICKNAME updates nickname, closes overlay, sets wsStatus to connecting', () => {
      const state = roomState({ type: 'idle' }, { overlay: 'settings', wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'CHANGE_NICKNAME', nickname: 'NewName' }));
      expect(room.nickname).toBe('NewName');
      expect(room.overlay).toBeNull();
      expect(room.wsStatus).toBe('connecting');
    });

    test('CLEAR_HISTORY wipes messages and closes overlay', () => {
      const msg = chatMessage({ uuid: 'x' });
      const state = roomState(
        { type: 'idle' },
        {
          messages: [msg],
          historyCursor: 42,
          historyHasMore: true,
          overlay: 'settings',
        },
      );
      const room = expectRoom(reducer(state, { type: 'CLEAR_HISTORY' }));
      expect(room.messages).toEqual([]);
      expect(room.messageUuids.size).toBe(0);
      expect(room.historyCursor).toBeNull();
      expect(room.historyHasMore).toBe(false);
      expect(room.overlay).toBeNull();
    });

    test('LEAVE_ROOM transitions to login phase preserving nickname', () => {
      const state = roomState({ type: 'idle' }, { nickname: 'Mama' });
      const newState = reducer(state, { type: 'LEAVE_ROOM' });
      expect(newState.phase).toBe('login');
      if (newState.phase === 'login') {
        expect(newState.nickname).toBe('Mama');
      }
    });
  });

  // ========================================================================
  // View switching
  // ========================================================================

  describe('View switching', () => {
    test('SWITCH_TO_CALL transitions to acquiring-media when connected', () => {
      const state = roomState({ type: 'idle' }, { view: 'chat', wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'SWITCH_TO_CALL' }));
      expect(room.view).toBe('call');
      expect(room.screen.type).toBe('acquiring-media');
    });

    test('SWITCH_TO_CALL just switches view when call already in progress', () => {
      const callScreen = {
        type: 'call' as const,
        muted: false,
        videoOff: false,
        pipHidden: false,
      };
      const state = roomState(callScreen, { view: 'chat', wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'SWITCH_TO_CALL' }));
      expect(room.view).toBe('call');
      expect(room.screen).toEqual(callScreen);
    });

    test('SWITCH_TO_CALL just switches view when waiting-for-peer', () => {
      const screen = {
        type: 'waiting-for-peer' as const,
        muted: false,
        videoOff: false,
        pipHidden: false,
      };
      const state = roomState(screen, { view: 'chat', wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'SWITCH_TO_CALL' }));
      expect(room.view).toBe('call');
      expect(room.screen).toEqual(screen);
    });

    test('SWITCH_TO_CALL shows error when not connected', () => {
      const state = roomState({ type: 'idle' }, { view: 'chat', wsStatus: 'disconnected' });
      const room = expectRoom(reducer(state, { type: 'SWITCH_TO_CALL' }));
      expect(room.view).toBe('call');
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.canRetry).toBe(false);
      }
    });

    test('SWITCH_TO_CHAT changes view', () => {
      const state = roomState({ type: 'idle' }, { view: 'call' });
      const room = expectRoom(reducer(state, { type: 'SWITCH_TO_CHAT' }));
      expect(room.view).toBe('chat');
    });
  });
});
