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
  return {
    phase: 'room',
    roomId: 'test-room-id',
    deviceId: 'test-device-id',
    nickname: 'TestUser',
    view: 'chat',
    messages: [],
    wsStatus: 'connected',
    selfPeerId: null,
    peers: {},
    historyCursor: null,
    historyHasMore: false,
    loadingHistory: false,
    screen,
    iceServers: null,
    iceTransportPolicy: 'all',
    incomingOffer: null,
    ...overrides,
  };
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
      expect(room.selfPeerId).toBeNull();
      expect(room.peers).toEqual({});
      expect(room.historyCursor).toBeNull();
      expect(room.historyHasMore).toBe(false);
      expect(room.loadingHistory).toBe(false);
      expect(room.screen.type).toBe('idle');
      expect(room.iceServers).toBeNull();
      expect(room.iceTransportPolicy).toBe('all');
      expect(room.incomingOffer).toBeNull();
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
        { wsStatus: 'connected' },
      );
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_DISCONNECTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.screen.type).toBe('error');
    });

    test('WS_ROOM_DISCONNECTED does not affect chat view screen', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'connected' });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_DISCONNECTED' }));
      expect(room.wsStatus).toBe('disconnected');
      expect(room.screen.type).toBe('idle');
    });

    test('WS_ROOM_RECONNECTING sets wsStatus', () => {
      const state = roomState({ type: 'idle' }, { wsStatus: 'disconnected' });
      const room = expectRoom(reducer(state, { type: 'WS_ROOM_RECONNECTING', attempt: 1 }));
      expect(room.wsStatus).toBe('reconnecting');
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
  });

  // ========================================================================
  // Peer tracking
  // ========================================================================

  describe('Peer tracking', () => {
    test('PEERS_LIST populates peers and selfPeerId', () => {
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
      expect(room.peers['p1']).toEqual({ peerId: 'p1' });
      expect(room.peers['p2']).toEqual({ peerId: 'p2' });
    });

    test('PEER_JOINED_ROOM adds peer', () => {
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
      expect(room.peers['p2']).toEqual({ peerId: 'p2' });
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

  describe('Signaling messages', () => {
    test('PEER_JOINED_CALL transitions waiting-for-peer to negotiating as caller', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        muted: true,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'PEER_JOINED_CALL', peerId: 'p2' }));
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.role).toBe('caller');
        expect(room.screen.muted).toBe(true);
      }
    });

    test('PEER_JOINED_CALL is ignored in non-waiting-for-peer states', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'PEER_JOINED_CALL', peerId: 'p2' })).toBe(state);
    });

    test('PEER_LEFT_CALL during call returns to chat and idle', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'PEER_LEFT_CALL', peerId: 'p2' }));
      expect(room.screen.type).toBe('idle');
      expect(room.view).toBe('chat');
    });

    test('PEER_LEFT_CALL during error returns to chat and idle', () => {
      const state = roomState({
        type: 'error',
        message: 'Connection failed',
        canRetry: false,
      });
      const room = expectRoom(reducer(state, { type: 'PEER_LEFT_CALL', peerId: 'p2' }));
      expect(room.screen.type).toBe('idle');
      expect(room.view).toBe('chat');
    });

    test('PEER_LEFT_CALL is ignored in idle state', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'PEER_LEFT_CALL', peerId: 'p2' })).toBe(state);
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

    test('RECEIVED_OFFER transitions to negotiating as callee', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(
        reducer(state, {
          type: 'RECEIVED_OFFER',
          offer: { type: 'offer', sdp: 'mock sdp' },
        }),
      );
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.role).toBe('callee');
      }
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
  // WebRTC lifecycle
  // ========================================================================

  describe('WebRTC lifecycle', () => {
    test('RTC_CONNECTED transitions negotiating to call', () => {
      const state = roomState({
        type: 'negotiating',
        role: 'caller',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(reducer(state, { type: 'RTC_CONNECTED' }));
      expect(room.screen.type).toBe('call');
    });

    test('RTC_FAILED shows error during active call', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const room = expectRoom(
        reducer(state, { type: 'RTC_FAILED', reason: 'ICE connection failed' }),
      );
      expect(room.screen.type).toBe('error');
    });

    test('RTC_FAILED is ignored in idle state', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'RTC_FAILED', reason: 'stale failure' })).toBe(state);
    });

    test('RTC_TRACK_RECEIVED returns state unchanged (stream in ref)', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'RTC_TRACK_RECEIVED', stream: {} as MediaStream })).toBe(state);
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

  // ========================================================================
  // CALL_PEERS_RECEIVED
  // ========================================================================

  describe('CALL_PEERS_RECEIVED', () => {
    test('transitions waiting-for-peer to negotiating(caller) when peers exist', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        muted: false,
        videoOff: true,
        pipHidden: false,
      });
      const room = expectRoom(
        reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['peer-1'] }),
      );
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.role).toBe('caller');
        expect(room.screen.videoOff).toBe(true);
      }
    });

    test('no-op when callPeers is empty', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      expect(reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: [] })).toBe(state);
    });

    test('ignored when not in waiting-for-peer', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'CALL_PEERS_RECEIVED', callPeers: ['p1'] })).toBe(state);
    });
  });

  // ========================================================================
  // Incoming call (RECEIVED_OFFER on idle, ACCEPT_CALL, DECLINE_CALL)
  // ========================================================================

  describe('Incoming call', () => {
    test('RECEIVED_OFFER on idle screen saves incomingOffer', () => {
      const state = roomState({ type: 'idle' });
      const offer = { type: 'offer' as const, sdp: 'mock sdp' };
      const room = expectRoom(
        reducer(state, { type: 'RECEIVED_OFFER', offer, fromPeerId: 'caller-1' }),
      );
      expect(room.screen.type).toBe('idle');
      expect(room.incomingOffer).toEqual({ fromPeerId: 'caller-1', offer });
    });

    test('RECEIVED_OFFER on idle is ignored if incomingOffer already set', () => {
      const existingOffer = {
        fromPeerId: 'caller-1',
        offer: { type: 'offer' as const, sdp: 'first' },
      };
      const state = roomState({ type: 'idle' }, { incomingOffer: existingOffer });
      const newOffer = { type: 'offer' as const, sdp: 'second' };
      expect(
        reducer(state, { type: 'RECEIVED_OFFER', offer: newOffer, fromPeerId: 'caller-2' }),
      ).toBe(state);
    });

    test('RECEIVED_OFFER on call screen is ignored', () => {
      const state = roomState({
        type: 'call',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });
      const offer = { type: 'offer' as const, sdp: 'mock' };
      expect(reducer(state, { type: 'RECEIVED_OFFER', offer })).toBe(state);
    });

    test('ACCEPT_CALL transitions to acquiring-media and clears incomingOffer', () => {
      const incomingOffer = {
        fromPeerId: 'caller-1',
        offer: { type: 'offer' as const, sdp: 'mock' },
      };
      const state = roomState({ type: 'idle' }, { incomingOffer });
      const room = expectRoom(reducer(state, { type: 'ACCEPT_CALL' }));
      expect(room.view).toBe('call');
      expect(room.screen.type).toBe('acquiring-media');
      expect(room.incomingOffer).toBeNull();
    });

    test('ACCEPT_CALL is no-op when incomingOffer is null', () => {
      const state = roomState({ type: 'idle' });
      expect(reducer(state, { type: 'ACCEPT_CALL' })).toBe(state);
    });

    test('DECLINE_CALL clears incomingOffer without screen change', () => {
      const incomingOffer = {
        fromPeerId: 'caller-1',
        offer: { type: 'offer' as const, sdp: 'mock' },
      };
      const state = roomState({ type: 'idle' }, { incomingOffer });
      const room = expectRoom(reducer(state, { type: 'DECLINE_CALL' }));
      expect(room.screen.type).toBe('idle');
      expect(room.incomingOffer).toBeNull();
    });

    test('HANGUP clears incomingOffer', () => {
      const incomingOffer = {
        fromPeerId: 'caller-1',
        offer: { type: 'offer' as const, sdp: 'mock' },
      };
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { incomingOffer },
      );
      const room = expectRoom(reducer(state, { type: 'HANGUP' }));
      expect(room.incomingOffer).toBeNull();
    });

    test('PEER_LEFT_CALL clears incomingOffer', () => {
      const incomingOffer = {
        fromPeerId: 'caller-1',
        offer: { type: 'offer' as const, sdp: 'mock' },
      };
      const state = roomState(
        { type: 'call', muted: false, videoOff: false, pipHidden: false },
        { incomingOffer },
      );
      const room = expectRoom(reducer(state, { type: 'PEER_LEFT_CALL', peerId: 'caller-1' }));
      expect(room.incomingOffer).toBeNull();
    });
  });
});
