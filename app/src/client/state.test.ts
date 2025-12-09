/**
 * Unit tests for state machine reducer
 * Tests all state transitions without requiring WebRTC/WebSocket mocks
 *
 * @remarks
 * Testing Strategy:
 * - Pure function testing (no mocks needed)
 * - Test each action type independently
 * - Test transition guards (invalid state → no change)
 * - Test state preservation (same reference if unchanged)
 * - Test data flow (ensure screen data propagates correctly)
 *
 * Coverage Goals:
 * - All action types tested
 * - All screen transitions tested
 * - All guard conditions tested
 * - Edge cases covered (error states, cleanup, etc.)
 *
 * Why No Mocks?
 * - Reducer is pure function (no external dependencies)
 * - Only operates on TypeScript types
 * - MediaStream, WebSocket, etc. are just type references
 * - Tests verify logic, not integration
 *
 * Test Organization:
 * - Grouped by feature area (PIN submission, WebSocket lifecycle, etc.)
 * - Descriptive test names explain expected behavior
 * - Assertions check both state transitions and data preservation
 *
 * @module state.test
 */

import { describe, test, expect } from 'bun:test';
import { reducer, initialState, type Action, type AppState } from './state';

/**
 * State machine reducer test suite
 *
 * Tests verify:
 * 1. Happy path transitions (pin-entry → connecting → ... → call)
 * 2. Error handling (all error states reachable)
 * 3. Guard conditions (invalid transitions ignored)
 * 4. Data preservation (screen data carries through transitions)
 * 5. Idempotence (no change when guards prevent transition)
 */
describe('reducer', () => {
  /**
   * PIN Submission Flow
   *
   * Tests the initial user action of entering a PIN and connecting.
   * This is the entry point to the connection flow.
   *
   * Coverage:
   * - Valid transition: pin-entry → connecting
   * - Guard condition: SUBMIT_PIN ignored in non-pin-entry states
   * - Data preservation: PIN carried to connecting state
   */
  describe('PIN submission flow', () => {
    /**
     * Happy path: User enters PIN at initial screen
     *
     * Expected: pin-entry → connecting, with PIN stored
     */
    test('SUBMIT_PIN transitions from pin-entry to connecting', () => {
      const action: Action = { type: 'SUBMIT_PIN', pin: '123456' };
      const newState = reducer(initialState, action);

      expect(newState.screen.type).toBe('connecting');
      if (newState.screen.type === 'connecting') {
        expect(newState.screen.pin).toBe('123456');
      }
    });

    /**
     * Guard test: SUBMIT_PIN should not work during active call
     *
     * Expected: State unchanged (prevents accidental reconnection)
     */
    test('SUBMIT_PIN is ignored in non-pin-entry states', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '111111', muted: false, videoOff: false },
      };

      const action: Action = { type: 'SUBMIT_PIN', pin: '999999' };
      const newState = reducer(state, action);

      expect(newState).toBe(state); // State unchanged
    });
  });

  /**
   * WebSocket Lifecycle
   *
   * Tests WebSocket connection events and state transitions.
   * WebSocket is the signaling channel for offer/answer/ICE exchange.
   *
   * Coverage:
   * - Connection success: connecting → acquiring-media
   * - Connection errors: any state → error
   * - Intentional close: call → pin-entry
   * - Unexpected close: call → error
   */
  describe('WebSocket lifecycle', () => {
    /**
     * WebSocket connection established successfully
     *
     * Expected: Move to acquiring-media (get camera/mic)
     */
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

    /**
     * Intentional disconnect (user clicked hangup)
     *
     * Expected: Clean return to pin-entry (no error)
     */
    test('WS_CLOSED with intentional flag returns to pin-entry', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
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

    /**
     * Unexpected disconnect (network issue, server crash)
     *
     * Expected: Error state with retryable flag and descriptive message
     */
    test('WS_CLOSED without intentional flag shows error', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
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

  /**
   * Media Lifecycle
   *
   * Tests getUserMedia flow and media stream management.
   * Media must be acquired before WebRTC connection can be established.
   *
   * Coverage:
   * - Successful acquisition: acquiring-media → waiting-for-peer
   * - Audio-only fallback: MEDIA_ACQUIRED with audioOnly flag
   * - Permission denied: acquiring-media → error
   */
  describe('Media lifecycle', () => {
    /**
     * Camera and microphone acquired successfully
     *
     * Expected: Store stream, transition to waiting-for-peer
     */
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
      }
    });

    /**
     * Audio-only mode (camera unavailable or denied)
     *
     * Expected: Stream stored, UI will disable video toggle
     */
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

  /**
   * Signaling Messages
   *
   * Tests WebRTC signaling protocol (offer/answer/ICE candidate exchange).
   * Follows RFC 8834 JSEP (JavaScript Session Establishment Protocol).
   *
   * Coverage:
   * - ICE server configuration received
   * - Peer joined (we become caller)
   * - Offer received (we become callee)
   * - Peer left (show error)
   * - Server errors (room full, invalid PIN, etc.)
   *
   * Glare Prevention:
   * - First peer receives PEER_JOINED → creates offer (caller)
   * - Second peer receives RECEIVED_OFFER → creates answer (callee)
   * - Prevents both peers from creating offers simultaneously
   */
  describe('Signaling messages', () => {
    /**
     * Server sends ICE server configuration (STUN/TURN)
     *
     * Expected: Store for later RTCPeerConnection creation
     */
    test('JOINED_ROOM stores ICE servers', () => {
      const mockIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      const action: Action = {
        type: 'JOINED_ROOM',
        iceServers: mockIceServers,
      };
      const newState = reducer(initialState, action);

      expect(newState.iceServers).toBe(mockIceServers);
    });

    /**
     * First peer (we joined first, peer joined second)
     *
     * Expected: Become caller, create offer in side effects
     */
    test('PEER_JOINED transitions to negotiating as caller', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'waiting-for-peer', pin: '123456' },
      };

      const action: Action = { type: 'PEER_JOINED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('negotiating');
      if (newState.screen.type === 'negotiating') {
        expect(newState.screen.role).toBe('caller');
        expect(newState.screen.pin).toBe('123456');
      }
    });

    /**
     * Second peer (we joined second, received offer from first peer)
     *
     * Expected: Become callee, create answer in side effects
     */
    test('RECEIVED_OFFER transitions to negotiating as callee', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'waiting-for-peer', pin: '123456' },
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
      }
    });

    test('PEER_LEFT shows non-retryable error', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
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

  /**
   * WebRTC Lifecycle
   *
   * Tests RTCPeerConnection state transitions and media exchange.
   * Connection goes through: new → connecting → connected → closed/failed.
   *
   * Coverage:
   * - Track received (remote video/audio)
   * - Connection successful: negotiating → call
   * - Connection failed: any state → error
   * - Disconnected (temporary, may recover)
   */
  describe('WebRTC lifecycle', () => {
    /**
     * Remote peer's video/audio track received
     *
     * Expected: Store remote stream for rendering
     */
    test('RTC_TRACK_RECEIVED stores remote stream', () => {
      const mockStream = {} as MediaStream;
      const action: Action = {
        type: 'RTC_TRACK_RECEIVED',
        stream: mockStream,
      };
      const newState = reducer(initialState, action);

      expect(newState.remoteStream).toBe(mockStream);
    });

    /**
     * ICE connection established, media flowing
     *
     * Expected: negotiating → call, initialize mute/video flags
     */
    test('RTC_CONNECTED transitions negotiating to call', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'negotiating', pin: '123456', role: 'caller' },
      };

      const action: Action = { type: 'RTC_CONNECTED' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.pin).toBe('123456');
        expect(newState.screen.muted).toBe(false);
        expect(newState.screen.videoOff).toBe(false);
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
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
      };

      const action: Action = { type: 'RTC_DISCONNECTED' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });
  });

  /**
   * In-Call Actions
   *
   * Tests user controls during active call (mute, video, hangup).
   * These actions only work in 'call' state (guards prevent misuse).
   *
   * Coverage:
   * - Mute toggle (updates flag, side effects disable track)
   * - Video toggle (updates flag, side effects disable track)
   * - Hangup (returns to pin-entry, side effects cleanup)
   * - Guards (toggles ignored in non-call states)
   */
  describe('In-call actions', () => {
    /**
     * User clicks mute button during call
     *
     * Expected: Toggle muted flag, side effects disable audio track
     */
    test('TOGGLE_MUTE flips muted flag in call state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
      };

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.muted).toBe(true);
      }

      // Toggle again
      const newState2 = reducer(newState, action);
      if (newState2.screen.type === 'call') {
        expect(newState2.screen.muted).toBe(false);
      }
    });

    /**
     * User clicks video toggle button during call
     *
     * Expected: Toggle videoOff flag, side effects disable video track
     */
    test('TOGGLE_VIDEO flips videoOff flag in call state', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
      };

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('call');
      if (newState.screen.type === 'call') {
        expect(newState.screen.videoOff).toBe(true);
      }

      // Toggle again
      const newState2 = reducer(newState, action);
      if (newState2.screen.type === 'call') {
        expect(newState2.screen.videoOff).toBe(false);
      }
    });

    /**
     * Guard test: Mute toggle should not work while waiting for peer
     *
     * Expected: State unchanged (no mute flag to toggle)
     */
    test('TOGGLE_MUTE is ignored in non-call states', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'waiting-for-peer', pin: '123456' },
      };

      const action: Action = { type: 'TOGGLE_MUTE' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('TOGGLE_VIDEO is ignored in non-call states', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'waiting-for-peer', pin: '123456' },
      };

      const action: Action = { type: 'TOGGLE_VIDEO' };
      const newState = reducer(state, action);

      expect(newState).toBe(state);
    });

    test('HANGUP returns to pin-entry', () => {
      const state: AppState = {
        ...initialState,
        screen: { type: 'call', pin: '123456', muted: false, videoOff: false },
      };

      const action: Action = { type: 'HANGUP' };
      const newState = reducer(state, action);

      expect(newState.screen.type).toBe('pin-entry');
    });
  });

  /**
   * Error Handling
   *
   * Tests error state transitions and recovery.
   * Errors can be retryable (permission denied) or terminal (room full).
   *
   * Coverage:
   * - Error dismissal (auto-timeout or user click)
   * - Error state preserves previous screen for context
   * - Retryable vs terminal errors
   */
  describe('Error handling', () => {
    /**
     * Error auto-dismissed after 5 seconds or user clicks
     *
     * Expected: Return to pin-entry for retry
     */
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

    /**
     * Error preserves previous screen (useful for retry logic)
     *
     * Expected: previousScreen field populated with state before error
     */
    test('Error state preserves previous screen for context', () => {
      const previousScreen = {
        type: 'call' as const,
        pin: '123456',
        muted: false,
        videoOff: false,
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
