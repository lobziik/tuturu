/**
 * Unit tests for state machine reducer
 * Tests all state transitions without requiring WebRTC/WebSocket mocks
 *
 * @module state/reducer.test
 */

import { describe, test, expect } from 'bun:test';
import { reducer } from './reducer';
import { initialState } from './types';
import type { Action, AppState } from './types';

describe('reducer', () => {
  describe('PIN submission flow', () => {
    test('SUBMIT_PIN transitions from pin-entry to connecting', () => {
      const action: Action = { type: 'SUBMIT_PIN', pin: '123456' };
      const newState = reducer(initialState, action);

      expect(newState.screen.type).toBe('connecting');
      if (newState.screen.type === 'connecting') {
        expect(newState.screen.pin).toBe('123456');
      }
    });

    test('SUBMIT_PIN is ignored in non-pin-entry states', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '111111', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'SUBMIT_PIN', pin: '999999' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  describe('WebSocket lifecycle', () => {
    test('WS_CONNECTED transitions connecting to acquiring-media', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'connecting', pin: '123456' },
      };

      const action: Action = { type: 'WS_CONNECTED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('acquiring-media');
      if (newState.screen.type === 'acquiring-media') {
        expect(newState.screen.pin).toBe('123456');
      }
    });

    test('WS_CLOSED with intentional flag returns to pin-entry', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = {
        type: 'WS_CLOSED',
        code: 1000,
        reason: 'User ended call',
        intentional: true,
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('pin-entry');
    });

    test('WS_CLOSED without intentional flag shows error', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = {
        type: 'WS_CLOSED',
        code: 1006,
        reason: '',
        intentional: false,
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toContain('Connection lost');
        expect(newState.screen.canRetry).toBe(true);
      }
    });

    test('WS_ERROR transitions to error state', () => {
      const action: Action = {
        type: 'WS_ERROR',
        error: 'WebSocket connection failed',
      };
      const newState = reducer(initialState, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toBe('WebSocket connection failed');
        expect(newState.screen.canRetry).toBe(true);
      }
    });
  });

  describe('Media lifecycle', () => {
    test('MEDIA_ACQUIRED transitions to waiting-for-peer', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'acquiring-media', pin: '123456' },
      };

      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'MEDIA_ACQUIRED',
        stream: mockStream,
        audioOnly: false,
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('waiting-for-peer');
      expect(newState.localStream).toBe(mockStream);
      if (newState.screen.type === 'waiting-for-peer') {
        expect(newState.screen.pin).toBe('123456');
        expect(newState.screen.muted).toBe(false);
        expect(newState.screen.videoOff).toBe(false);
        expect(newState.screen.pipHidden).toBe(false);
      }
    });

    test('MEDIA_ACQUIRED with audioOnly flag sets stream correctly', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'acquiring-media', pin: '123456' },
      };

      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'MEDIA_ACQUIRED',
        stream: mockStream,
        audioOnly: true,
      };
      const newState = reducer(state, action);

      expect(newState.localStream).toBe(mockStream);
    });

    test('MEDIA_ERROR transitions to error state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'acquiring-media', pin: '123456' },
      };

      const action: Action = {
        type: 'MEDIA_ERROR',
        error: 'Microphone permission denied',
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toBe('Microphone permission denied');
        expect(newState.screen.canRetry).toBe(true);
      }
    });
  });

  describe('Signaling messages', () => {
    test('JOINED_ROOM stores ICE servers and transport policy', () => {
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const action: Action = {
        type: 'JOINED_ROOM',
        iceServers: mockIceServers,
        iceTransportPolicy: 'all',
      };
      const newState = reducer(initialState, action);

      expect(newState.iceServers).toBe(mockIceServers);
      expect(newState.iceTransportPolicy).toBe('all');
    });

    test('JOINED_ROOM stores relay transport policy', () => {
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const action: Action = {
        type: 'JOINED_ROOM',
        iceServers: mockIceServers,
        iceTransportPolicy: 'relay',
      };
      const newState = reducer(initialState, action);

      expect(newState.iceServers).toBe(mockIceServers);
      expect(newState.iceTransportPolicy).toBe('relay');
    });

    test('PEER_JOINED transitions to negotiating as caller', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'PEER_JOINED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.role).toBe('caller');
        expect(newState.screen.pin).toBe('123456');
        expect(newState.screen.muted).toBe(false);
        expect(newState.screen.videoOff).toBe(false);
        expect(newState.screen.pipHidden).toBe(false);
      }
    });

    test('PEER_JOINED preserves muted/videoOff state from waiting-for-peer', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: true,
          videoOff: true,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'PEER_JOINED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.muted).toBe(true);
        expect(newState.screen.videoOff).toBe(true);
      }
    });

    test('RECEIVED_OFFER transitions to negotiating as callee', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const mockOffer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: 'mock sdp',
      };
      const action: Action = {
        type: 'RECEIVED_OFFER',
        offer: mockOffer,
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.role).toBe('callee');
        expect(newState.screen.pin).toBe('123456');
        expect(newState.screen.muted).toBe(false);
        expect(newState.screen.videoOff).toBe(false);
        expect(newState.screen.pipHidden).toBe(false);
      }
    });

    test('RECEIVED_OFFER preserves muted/videoOff state from waiting-for-peer', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: true,
          videoOff: true,
          pipHidden: false,
        },
      };

      const mockOffer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: 'mock sdp',
      };
      const action: Action = {
        type: 'RECEIVED_OFFER',
        offer: mockOffer,
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.muted).toBe(true);
        expect(newState.screen.videoOff).toBe(true);
      }
    });

    test('PEER_LEFT shows non-retryable error', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'PEER_LEFT' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toContain('other person left');
        expect(newState.screen.canRetry).toBe(false);
      }
    });

    test('SERVER_ERROR shows non-retryable error', () => {
      const action: Action = {
        type: 'SERVER_ERROR',
        error: 'Room is full',
      };
      const newState = reducer(initialState, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toBe('Room is full');
        expect(newState.screen.canRetry).toBe(false);
      }
    });
  });

  describe('WebRTC lifecycle', () => {
    test('RTC_TRACK_RECEIVED stores remote stream', () => {
      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'RTC_TRACK_RECEIVED',
        stream: mockStream,
      };
      const newState = reducer(initialState, action);

      expect(newState.remoteStream).toBe(mockStream);
    });

    test('RTC_CONNECTED transitions negotiating to call', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'negotiating',
          pin: '123456',
          role: 'caller',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'RTC_CONNECTED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.pin).toBe('123456');
        expect(newState.screen.muted).toBe(false);
        expect(newState.screen.videoOff).toBe(false);
        expect(newState.screen.pipHidden).toBe(false);
      }
    });

    test('RTC_CONNECTED preserves muted/videoOff/pipHidden state from negotiating', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'negotiating',
          pin: '123456',
          role: 'caller',
          muted: true,
          videoOff: true,
          pipHidden: true,
        },
      };

      const action: Action = { type: 'RTC_CONNECTED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.muted).toBe(true);
        expect(newState.screen.videoOff).toBe(true);
        expect(newState.screen.pipHidden).toBe(true);
      }
    });

    test('RTC_FAILED shows error', () => {
      const action: Action = {
        type: 'RTC_FAILED',
        reason: 'ICE connection failed',
      };
      const newState = reducer(initialState, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.message).toBe('ICE connection failed');
        expect(newState.screen.canRetry).toBe(false);
      }
    });

    test('RTC_DISCONNECTED keeps current state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'RTC_DISCONNECTED' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  describe('In-call actions', () => {
    test('TOGGLE_MUTE flips muted flag in call state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.muted).toBe(true);
      }

      const newState2 = reducer(newState, action);
      if (newState2.screen.type === 'call') {
        expect(newState2.screen.muted).toBe(false);
      }
    });

    test('TOGGLE_VIDEO flips videoOff flag in call state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.videoOff).toBe(true);
      }

      const newState2 = reducer(newState, action);
      if (newState2.screen.type === 'call') {
        expect(newState2.screen.videoOff).toBe(false);
      }
    });

    test('TOGGLE_MUTE works in waiting-for-peer state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('waiting-for-peer');
      if (newState.screen.type === 'waiting-for-peer') {
        expect(newState.screen.muted).toBe(true);
      }
    });

    test('TOGGLE_VIDEO works in waiting-for-peer state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('waiting-for-peer');
      if (newState.screen.type === 'waiting-for-peer') {
        expect(newState.screen.videoOff).toBe(true);
      }
    });

    test('TOGGLE_MUTE works in negotiating state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'negotiating',
          pin: '123456',
          role: 'caller',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.muted).toBe(true);
      }
    });

    test('TOGGLE_VIDEO works in negotiating state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'negotiating',
          pin: '123456',
          role: 'caller',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.videoOff).toBe(true);
      }
    });

    test('TOGGLE_MUTE is ignored in pin-entry state', () => {
      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(initialState, action);

      expect(newState).toBe(initialState);
    });

    test('TOGGLE_VIDEO is ignored in pin-entry state', () => {
      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(initialState, action);

      expect(newState).toBe(initialState);
    });

    test('TOGGLE_PIP_VISIBILITY flips pipHidden flag in call state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.pipHidden).toBe(true);
      }

      const newState2 = reducer(newState, action);
      if (newState2.screen.type === 'call') {
        expect(newState2.screen.pipHidden).toBe(false);
      }
    });

    test('TOGGLE_PIP_VISIBILITY works in waiting-for-peer state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('waiting-for-peer');
      if (newState.screen.type === 'waiting-for-peer') {
        expect(newState.screen.pipHidden).toBe(true);
      }
    });

    test('TOGGLE_PIP_VISIBILITY works in negotiating state', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'negotiating',
          pin: '123456',
          role: 'caller',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.pipHidden).toBe(true);
      }
    });

    test('TOGGLE_PIP_VISIBILITY is ignored in pin-entry state', () => {
      const action: Action = { type: 'TOGGLE_PIP_VISIBILITY' };
      const newState = reducer(initialState, action);

      expect(newState).toBe(initialState);
    });

    test('FLIP_CAMERA returns same state in call screen', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
        localStream: {} as MediaStream,
      };

      const action: Action = { type: 'FLIP_CAMERA' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('FLIP_CAMERA is ignored in non-call states', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'waiting-for-peer',
          pin: '123456',
          muted: false,
          videoOff: false,
          pipHidden: false,
        },
      };

      const action: Action = { type: 'FLIP_CAMERA' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('HANGUP returns to pin-entry', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false, pipHidden: false },
      };

      const action: Action = { type: 'HANGUP' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('pin-entry');
    });
  });

  describe('Error handling', () => {
    test('DISMISS_ERROR returns to pin-entry', () => {
      const state: AppState = {
        ...initialState,
        screen: {
          type: 'error',
          message: 'Something went wrong',
          canRetry: true,
        },
      };

      const action: Action = { type: 'DISMISS_ERROR' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('pin-entry');
    });

    test('Error state preserves previous screen for context', () => {
      const previousScreen = {
        type: 'call' as const,
        pin: '123456',
        muted: false,
        videoOff: false,
        pipHidden: false,
      };
      const state: AppState = {
        ...initialState,
        screen: previousScreen,
      };

      const action: Action = {
        type: 'WS_ERROR',
        error: 'Connection failed',
      };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('error');
      if (newState.screen.type === 'error') {
        expect(newState.screen.previousScreen).toEqual(previousScreen);
      }
    });
  });
});
