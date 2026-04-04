/**
 * Unit tests for state machine reducer
 * Tests all state transitions without requiring WebRTC/WebSocket mocks
 *
 * @module state/reducer.test
 */

import { describe, test, expect } from 'bun:test';
import { reducer } from './reducer';
import type { Action, AppState, RoomState, Screen } from './types';

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
    screen,
    iceServers: null,
    iceTransportPolicy: 'all',
    ...overrides,
  };
}

/** Assert state is in room phase and return narrowed type */
function expectRoom(state: AppState): RoomState {
  expect(state.phase).toBe('room');
  if (state.phase !== 'room') throw new Error('Expected room phase');
  return state;
}

describe('reducer', () => {
  // ========================================================================
  // Phase transitions
  // ========================================================================

  describe('Phase transitions', () => {
    test('SUBMIT_NICKNAME transitions from nickname to login', () => {
      const state: AppState = { phase: 'nickname' };
      const action: Action = { type: 'SUBMIT_NICKNAME', nickname: 'Мама' };
      const newState = reducer(state, action);

      expect(newState.phase).toBe('login');
      if (newState.phase === 'login') {
        expect(newState.nickname).toBe('Мама');
      }
    });

    test('NICKNAME_LOADED transitions from nickname to login', () => {
      const state: AppState = { phase: 'nickname' };
      const action: Action = { type: 'NICKNAME_LOADED', nickname: 'Папа' };
      const newState = reducer(state, action);

      expect(newState.phase).toBe('login');
      if (newState.phase === 'login') {
        expect(newState.nickname).toBe('Папа');
      }
    });

    test('SUBMIT_LOGIN transitions from login to room with derived data', () => {
      const state: AppState = { phase: 'login', nickname: 'Мама' };
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
      expect(room.nickname).toBe('Мама');
      expect(room.screen.type).toBe('pin-entry');
      expect(room.iceServers).toBeNull();
      expect(room.iceTransportPolicy).toBe('all');
    });

    test('SUBMIT_NICKNAME is ignored in room phase', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'SUBMIT_NICKNAME', nickname: 'test' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('SUBMIT_LOGIN is ignored in room phase', () => {
      const state = roomState({ type: 'pin-entry' });
      const mockAesKey = {} as CryptoKey;
      const action: Action = {
        type: 'SUBMIT_LOGIN',
        roomId: 'abc123',
        aesKey: mockAesKey,
        deviceId: 'device-1',
      };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('v1 actions are ignored in nickname phase', () => {
      const state: AppState = { phase: 'nickname' };
      const action: Action = { type: 'SUBMIT_PIN', pin: '123456' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('v1 actions are ignored in login phase', () => {
      const state: AppState = { phase: 'login', nickname: 'test' };
      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('NICKNAME_LOADED is ignored in room phase', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'NICKNAME_LOADED', nickname: 'Ignored' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('SUBMIT_NICKNAME is ignored in login phase', () => {
      const state: AppState = { phase: 'login', nickname: 'Existing' };
      const action: Action = { type: 'SUBMIT_NICKNAME', nickname: 'New' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('SUBMIT_LOGIN is ignored in nickname phase', () => {
      const state: AppState = { phase: 'nickname' };
      const mockAesKey = {} as CryptoKey;
      const action: Action = {
        type: 'SUBMIT_LOGIN',
        roomId: 'abc123',
        aesKey: mockAesKey,
        deviceId: 'device-1',
      };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  // ========================================================================
  // PIN submission flow (room phase)
  // ========================================================================

  describe('PIN submission flow', () => {
    test('SUBMIT_PIN transitions from pin-entry to connecting', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'SUBMIT_PIN', pin: '123456' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('connecting');
      if (room.screen.type === 'connecting') {
        expect(room.screen.pin).toBe('123456');
      }
    });

    test('SUBMIT_PIN is ignored in non-pin-entry states', () => {
      const state = roomState({
        type: 'call',
        pin: '111111',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'SUBMIT_PIN', pin: '999999' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  // ========================================================================
  // WebSocket lifecycle
  // ========================================================================

  describe('WebSocket lifecycle', () => {
    test('WS_CONNECTED transitions connecting to acquiring-media', () => {
      const state = roomState({ type: 'connecting', pin: '123456' });

      const action: Action = { type: 'WS_CONNECTED' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('acquiring-media');
      if (room.screen.type === 'acquiring-media') {
        expect(room.screen.pin).toBe('123456');
      }
    });

    test('WS_CLOSED with intentional flag returns to pin-entry', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = {
        type: 'WS_CLOSED',
        code: 1000,
        reason: 'User ended call',
        intentional: true,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('pin-entry');
    });

    test('WS_CLOSED without intentional flag shows error', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = {
        type: 'WS_CLOSED',
        code: 1006,
        reason: '',
        intentional: false,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toContain('Connection lost');
        expect(room.screen.canRetry).toBe(true);
      }
    });

    test('WS_ERROR transitions to error state', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = {
        type: 'WS_ERROR',
        error: 'WebSocket connection failed',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toBe('WebSocket connection failed');
        expect(room.screen.canRetry).toBe(true);
      }
    });
  });

  // ========================================================================
  // Media lifecycle
  // ========================================================================

  describe('Media lifecycle', () => {
    test('MEDIA_ACQUIRED transitions to waiting-for-peer', () => {
      const state = roomState({ type: 'acquiring-media', pin: '123456' });

      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'MEDIA_ACQUIRED',
        stream: mockStream,
        audioOnly: false,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('waiting-for-peer');
      if (room.screen.type === 'waiting-for-peer') {
        expect(room.screen.pin).toBe('123456');
        expect(room.screen.muted).toBe(false);
        expect(room.screen.videoOff).toBe(false);
        expect(room.screen.pipHidden).toBe(false);
      }
    });

    test('MEDIA_ACQUIRED with audioOnly flag sets stream correctly', () => {
      const state = roomState({ type: 'acquiring-media', pin: '123456' });

      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'MEDIA_ACQUIRED',
        stream: mockStream,
        audioOnly: true,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('waiting-for-peer');
    });

    test('MEDIA_ERROR transitions to error state', () => {
      const state = roomState({ type: 'acquiring-media', pin: '123456' });

      const action: Action = {
        type: 'MEDIA_ERROR',
        error: 'Microphone permission denied',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
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
    test('JOINED_ROOM stores ICE servers and transport policy', () => {
      const state = roomState({ type: 'pin-entry' });
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const action: Action = {
        type: 'JOINED_ROOM',
        iceServers: mockIceServers,
        iceTransportPolicy: 'all',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.iceServers).toBe(mockIceServers);
      expect(room.iceTransportPolicy).toBe('all');
    });

    test('JOINED_ROOM stores relay transport policy', () => {
      const state = roomState({ type: 'pin-entry' });
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const action: Action = {
        type: 'JOINED_ROOM',
        iceServers: mockIceServers,
        iceTransportPolicy: 'relay',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.iceServers).toBe(mockIceServers);
      expect(room.iceTransportPolicy).toBe('relay');
    });

    test('PEER_JOINED transitions to negotiating as caller', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'PEER_JOINED' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.role).toBe('caller');
        expect(room.screen.pin).toBe('123456');
        expect(room.screen.muted).toBe(false);
        expect(room.screen.videoOff).toBe(false);
        expect(room.screen.pipHidden).toBe(false);
      }
    });

    test('PEER_JOINED preserves muted/videoOff state from waiting-for-peer', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: true,
        videoOff: true,
        pipHidden: false,
      });

      const action: Action = { type: 'PEER_JOINED' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.muted).toBe(true);
        expect(room.screen.videoOff).toBe(true);
      }
    });

    test('RECEIVED_OFFER transitions to negotiating as callee', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const mockOffer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: 'mock sdp',
      };
      const action: Action = {
        type: 'RECEIVED_OFFER',
        offer: mockOffer,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.role).toBe('callee');
        expect(room.screen.pin).toBe('123456');
        expect(room.screen.muted).toBe(false);
        expect(room.screen.videoOff).toBe(false);
        expect(room.screen.pipHidden).toBe(false);
      }
    });

    test('RECEIVED_OFFER preserves muted/videoOff state from waiting-for-peer', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: true,
        videoOff: true,
        pipHidden: false,
      });

      const mockOffer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: 'mock sdp',
      };
      const action: Action = {
        type: 'RECEIVED_OFFER',
        offer: mockOffer,
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.muted).toBe(true);
        expect(room.screen.videoOff).toBe(true);
      }
    });

    test('PEER_LEFT shows non-retryable error', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'PEER_LEFT' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toContain('other person left');
        expect(room.screen.canRetry).toBe(false);
      }
    });

    test('SERVER_ERROR shows non-retryable error', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = {
        type: 'SERVER_ERROR',
        error: 'Room is full',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
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
    test('RTC_TRACK_RECEIVED returns state unchanged (stream in ref)', () => {
      const state = roomState({ type: 'pin-entry' });
      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'RTC_TRACK_RECEIVED',
        stream: mockStream,
      };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('RTC_CONNECTED transitions negotiating to call', () => {
      const state = roomState({
        type: 'negotiating',
        pin: '123456',
        role: 'caller',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'RTC_CONNECTED' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.pin).toBe('123456');
        expect(room.screen.muted).toBe(false);
        expect(room.screen.videoOff).toBe(false);
        expect(room.screen.pipHidden).toBe(false);
      }
    });

    test('RTC_CONNECTED preserves muted/videoOff/pipHidden state from negotiating', () => {
      const state = roomState({
        type: 'negotiating',
        pin: '123456',
        role: 'caller',
        muted: true,
        videoOff: true,
        pipHidden: true,
      });

      const action: Action = { type: 'RTC_CONNECTED' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.muted).toBe(true);
        expect(room.screen.videoOff).toBe(true);
        expect(room.screen.pipHidden).toBe(true);
      }
    });

    test('RTC_FAILED shows error', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = {
        type: 'RTC_FAILED',
        reason: 'ICE connection failed',
      };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.message).toBe('ICE connection failed');
        expect(room.screen.canRetry).toBe(false);
      }
    });

    test('RTC_DISCONNECTED keeps current state', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'RTC_DISCONNECTED' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  // ========================================================================
  // In-call actions
  // ========================================================================

  describe('In-call actions', () => {
    test('TOGGLE_MUTE flips muted flag in call state', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.muted).toBe(true);
      }

      const room2 = expectRoom(reducer(newState, action));
      if (room2.screen.type === 'call') {
        expect(room2.screen.muted).toBe(false);
      }
    });

    test('TOGGLE_VIDEO flips videoOff flag in call state', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      const room = expectRoom(newState);
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.videoOff).toBe(true);
      }

      const room2 = expectRoom(reducer(newState, action));
      if (room2.screen.type === 'call') {
        expect(room2.screen.videoOff).toBe(false);
      }
    });

    test('TOGGLE_MUTE works in waiting-for-peer state', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_MUTE' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('waiting-for-peer');
      if (room.screen.type === 'waiting-for-peer') {
        expect(room.screen.muted).toBe(true);
      }
    });

    test('TOGGLE_VIDEO works in waiting-for-peer state', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('waiting-for-peer');
      if (room.screen.type === 'waiting-for-peer') {
        expect(room.screen.videoOff).toBe(true);
      }
    });

    test('TOGGLE_MUTE works in negotiating state', () => {
      const state = roomState({
        type: 'negotiating',
        pin: '123456',
        role: 'caller',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_MUTE' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.muted).toBe(true);
      }
    });

    test('TOGGLE_VIDEO works in negotiating state', () => {
      const state = roomState({
        type: 'negotiating',
        pin: '123456',
        role: 'caller',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.videoOff).toBe(true);
      }
    });

    test('TOGGLE_MUTE is ignored in pin-entry state', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('TOGGLE_VIDEO is ignored in pin-entry state', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('TOGGLE_PIP_VISIBILITY flips pipHidden flag in call state', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('call');
      if (room.screen.type === 'call') {
        expect(room.screen.pipHidden).toBe(true);
      }

      const room2 = expectRoom(reducer(room, action));
      if (room2.screen.type === 'call') {
        expect(room2.screen.pipHidden).toBe(false);
      }
    });

    test('TOGGLE_PIP_VISIBILITY works in waiting-for-peer state', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('waiting-for-peer');
      if (room.screen.type === 'waiting-for-peer') {
        expect(room.screen.pipHidden).toBe(true);
      }
    });

    test('TOGGLE_PIP_VISIBILITY works in negotiating state', () => {
      const state = roomState({
        type: 'negotiating',
        pin: '123456',
        role: 'caller',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('negotiating');
      if (room.screen.type === 'negotiating') {
        expect(room.screen.pipHidden).toBe(true);
      }
    });

    test('TOGGLE_PIP_VISIBILITY is ignored in pin-entry state', () => {
      const state = roomState({ type: 'pin-entry' });
      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('FLIP_CAMERA returns same state in call screen', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'FLIP_CAMERA' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('FLIP_CAMERA is ignored in non-call states', () => {
      const state = roomState({
        type: 'waiting-for-peer',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'FLIP_CAMERA' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('HANGUP returns to pin-entry', () => {
      const state = roomState({
        type: 'call',
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      });

      const action: Action = { type: 'HANGUP' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('pin-entry');
    });
  });

  // ========================================================================
  // Error handling
  // ========================================================================

  describe('Error handling', () => {
    test('DISMISS_ERROR returns to pin-entry', () => {
      const state = roomState({
        type: 'error',
        message: 'Something went wrong',
        canRetry: true,
      });

      const action: Action = { type: 'DISMISS_ERROR' };
      const room = expectRoom(reducer(state, action));
      expect(room.screen.type).toBe('pin-entry');
    });

    test('Error state preserves previous screen for context', () => {
      const previousScreen = {
        type: 'call' as const,
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      };
      const state = roomState(previousScreen);

      const action: Action = {
        type: 'WS_ERROR',
        error: 'Connection failed',
      };
      const room = expectRoom(reducer(state, action));

      expect(room.screen.type).toBe('error');
      if (room.screen.type === 'error') {
        expect(room.screen.previousScreen).toEqual(previousScreen);
      }
    });
  });
});
