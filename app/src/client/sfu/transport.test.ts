/**
 * Unit tests for SFU transport creation and event wiring.
 *
 * Mocks mediasoup-client Device and WebSocket sendMessage to verify
 * that connect/produce events send the correct signaling messages.
 *
 * @module client/sfu/transport.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Device, types as msTypes } from 'mediasoup-client';

// ============================================================================
// Mock setup
// ============================================================================

/** Captured calls to sendMessage (module mock). */
const mockSendMessage = mock((_ws: WebSocket | null, _msg: Record<string, unknown>) => {});

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is sync in bun:test
mock.module('../services/websocket', () => ({
  sendMessage: mockSendMessage,
}));

const { createSfuSendTransport, createSfuRecvTransport, PRODUCE_TIMEOUT_MS } =
  await import('./transport');

type EventHandler = (...args: unknown[]) => void;

/** Mock transport that captures `.on()` handlers for manual invocation. */
function createMockTransportFactory() {
  const handlers = new Map<string, EventHandler>();
  const transport = {
    id: 'transport-mock',
    on(event: string, fn: EventHandler) {
      handlers.set(event, fn);
      return transport;
    },
  } as unknown as msTypes.Transport;

  return { transport, handlers };
}

function createMockDevice(): Device {
  const sendFactory = createMockTransportFactory();
  const recvFactory = createMockTransportFactory();

  return {
    createSendTransport: mock(() => sendFactory.transport),
    createRecvTransport: mock(() => recvFactory.transport),
    _sendHandlers: sendFactory.handlers,
    _recvHandlers: recvFactory.handlers,
  } as unknown as Device & {
    _sendHandlers: Map<string, EventHandler>;
    _recvHandlers: Map<string, EventHandler>;
  };
}

const FAKE_PARAMS = {
  id: 'transport-1',
  iceParameters: {} as msTypes.IceParameters,
  iceCandidates: [] as msTypes.IceCandidate[],
  dtlsParameters: {} as msTypes.DtlsParameters,
};

const FAKE_ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.example.com:3478' }],
  iceTransportPolicy: 'all' as const,
};

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockSendMessage.mockClear();
});

describe('createSfuSendTransport', () => {
  test('creates transport via device.createSendTransport', () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };

    const transport = createSfuSendTransport(
      device,
      null,
      FAKE_PARAMS,
      callbacks,
      FAKE_ICE_CONFIG,
      false,
    );

    expect(transport).toBeDefined();
    expect((device.createSendTransport as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test('connect event sends sfu-connect-transport message', () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    createSfuSendTransport(device, null, FAKE_PARAMS, callbacks, FAKE_ICE_CONFIG, false);

    const handlers = (device as unknown as { _sendHandlers: Map<string, EventHandler> })
      ._sendHandlers;
    const connectHandler = handlers.get('connect');
    expect(connectHandler).toBeDefined();

    const callbackFn = mock(() => {});
    const errbackFn = mock(() => {});
    connectHandler!({ dtlsParameters: { role: 'auto' } }, callbackFn, errbackFn);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockSendMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentMsg.type).toBe('sfu-connect-transport');
    expect(sentMsg.transportId).toBe('transport-mock');
    expect(callbackFn).toHaveBeenCalledTimes(1);
    expect(errbackFn).toHaveBeenCalledTimes(0);
  });

  test('produce event pushes callback and sends sfu-produce message', () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    createSfuSendTransport(device, null, FAKE_PARAMS, callbacks, FAKE_ICE_CONFIG, false);

    const handlers = (device as unknown as { _sendHandlers: Map<string, EventHandler> })
      ._sendHandlers;
    const produceHandler = handlers.get('produce');
    expect(produceHandler).toBeDefined();

    const callbackFn = mock((_result: { id: string }) => {});
    const errbackFn = mock((_error: Error) => {});
    produceHandler!({ kind: 'audio', rtpParameters: { codecs: [] } }, callbackFn, errbackFn);

    // Callback should be queued
    expect(callbacks.current).toHaveLength(1);

    // Message should be sent
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockSendMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentMsg.type).toBe('sfu-produce');
    expect(sentMsg.kind).toBe('audio');

    // Resolve the callback
    callbacks.current[0]!('producer-123');
    expect(callbackFn).toHaveBeenCalledWith({ id: 'producer-123' });
    expect(errbackFn).toHaveBeenCalledTimes(0);
  });

  test('produce timeout calls errback and removes callback from queue', async () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    const SHORT_TIMEOUT = 50;
    createSfuSendTransport(
      device,
      null,
      FAKE_PARAMS,
      callbacks,
      FAKE_ICE_CONFIG,
      false,
      SHORT_TIMEOUT,
    );

    const handlers = (device as unknown as { _sendHandlers: Map<string, EventHandler> })
      ._sendHandlers;
    const produceHandler = handlers.get('produce');
    expect(produceHandler).toBeDefined();

    const callbackFn = mock((_result: { id: string }) => {});
    const errbackFn = mock((_error: Error) => {});
    produceHandler!({ kind: 'video', rtpParameters: { codecs: [] } }, callbackFn, errbackFn);

    // Callback should be queued
    expect(callbacks.current).toHaveLength(1);

    // Wait for timeout to fire
    await Bun.sleep(SHORT_TIMEOUT + 20);

    // errback should have been called with timeout error
    expect(errbackFn).toHaveBeenCalledTimes(1);
    const error = errbackFn.mock.calls[0]![0] as Error;
    expect(error.message).toContain('sfu-produce timed out');
    expect(error.message).toContain('video');

    // Callback should have been removed from queue
    expect(callbacks.current).toHaveLength(0);

    // Original callback should NOT have been called
    expect(callbackFn).toHaveBeenCalledTimes(0);
  });

  test('resolving callback before timeout cancels the timer', async () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    const SHORT_TIMEOUT = 50;
    createSfuSendTransport(
      device,
      null,
      FAKE_PARAMS,
      callbacks,
      FAKE_ICE_CONFIG,
      false,
      SHORT_TIMEOUT,
    );

    const handlers = (device as unknown as { _sendHandlers: Map<string, EventHandler> })
      ._sendHandlers;
    const produceHandler = handlers.get('produce');

    const callbackFn = mock((_result: { id: string }) => {});
    const errbackFn = mock((_error: Error) => {});
    produceHandler!({ kind: 'audio', rtpParameters: { codecs: [] } }, callbackFn, errbackFn);

    // Resolve immediately
    callbacks.current[0]!('producer-456');
    expect(callbackFn).toHaveBeenCalledWith({ id: 'producer-456' });

    // Wait past timeout — errback should NOT fire
    await Bun.sleep(SHORT_TIMEOUT + 20);
    expect(errbackFn).toHaveBeenCalledTimes(0);
  });

  test('PRODUCE_TIMEOUT_MS is 10 seconds', () => {
    expect(PRODUCE_TIMEOUT_MS).toBe(10_000);
  });
});

describe('createSfuRecvTransport', () => {
  test('creates transport via device.createRecvTransport', () => {
    const device = createMockDevice();

    const transport = createSfuRecvTransport(device, null, FAKE_PARAMS, FAKE_ICE_CONFIG, false);

    expect(transport).toBeDefined();
    expect((device.createRecvTransport as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test('connect event sends sfu-connect-transport message', () => {
    const device = createMockDevice();
    createSfuRecvTransport(device, null, FAKE_PARAMS, FAKE_ICE_CONFIG, false);

    const handlers = (device as unknown as { _recvHandlers: Map<string, EventHandler> })
      ._recvHandlers;
    const connectHandler = handlers.get('connect');
    expect(connectHandler).toBeDefined();

    const callbackFn = mock(() => {});
    const errbackFn = mock(() => {});
    connectHandler!({ dtlsParameters: { role: 'auto' } }, callbackFn, errbackFn);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockSendMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentMsg.type).toBe('sfu-connect-transport');
    expect(callbackFn).toHaveBeenCalledTimes(1);
  });
});

describe('encoded-insertable-streams gating', () => {
  // Chrome silently drops media if encodedInsertableStreams is set without an
  // attached RTCRtpScriptTransform — these tests pin the behavior of both
  // factories so the regression that broke E2EE-off calls cannot recur.

  test('createSfuSendTransport omits additionalSettings when e2eeEnabled=false', () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    createSfuSendTransport(device, null, FAKE_PARAMS, callbacks, FAKE_ICE_CONFIG, false);
    const opts = (device.createSendTransport as ReturnType<typeof mock>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('additionalSettings');
  });

  test('createSfuSendTransport sets additionalSettings.encodedInsertableStreams when e2eeEnabled=true', () => {
    const device = createMockDevice();
    const callbacks = { current: [] as ((id: string) => void)[] };
    createSfuSendTransport(device, null, FAKE_PARAMS, callbacks, FAKE_ICE_CONFIG, true);
    const opts = (device.createSendTransport as ReturnType<typeof mock>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts.additionalSettings).toEqual({ encodedInsertableStreams: true });
  });

  test('createSfuRecvTransport omits additionalSettings when e2eeEnabled=false', () => {
    const device = createMockDevice();
    createSfuRecvTransport(device, null, FAKE_PARAMS, FAKE_ICE_CONFIG, false);
    const opts = (device.createRecvTransport as ReturnType<typeof mock>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('additionalSettings');
  });

  test('createSfuRecvTransport sets additionalSettings.encodedInsertableStreams when e2eeEnabled=true', () => {
    const device = createMockDevice();
    createSfuRecvTransport(device, null, FAKE_PARAMS, FAKE_ICE_CONFIG, true);
    const opts = (device.createRecvTransport as ReturnType<typeof mock>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts.additionalSettings).toEqual({ encodedInsertableStreams: true });
  });
});
