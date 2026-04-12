/**
 * Unit tests for the SFU peer handler.
 *
 * Mocks SfuRoomManager and mediasoup objects to test signaling flows
 * without spawning real C++ worker processes.
 *
 * @module server/sfu/peer-handler.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { types as mediasoupTypes } from 'mediasoup';
import type { ServerClientData } from '../rooms';
import type { ServerToClientMessage } from '../../shared/schemas';
import type { SfuRoomManager, SfuRoomState, RouteToPeerFn } from './types';
import { createSfuPeerHandler } from './peer-handler';

// ============================================================================
// Mock factories
// ============================================================================

type EventListener = (...args: unknown[]) => void;

/** Minimal mock for ServerWebSocket. */
function createMockWs(): ServerWebSocket<ServerClientData> {
  return {
    data: { peerId: 'test-peer' },
    send: mock(() => 0),
  } as unknown as ServerWebSocket<ServerClientData>;
}

/** Create a mock mediasoup Producer. */
function createMockProducer(
  id: string,
  kind: mediasoupTypes.MediaKind,
): mediasoupTypes.Producer & {
  _listeners: Map<string, EventListener[]>;
  pause: ReturnType<typeof mock>;
  resume: ReturnType<typeof mock>;
} {
  const listeners = new Map<string, EventListener[]>();
  return {
    id,
    kind,
    on(event: string, fn: EventListener) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    pause: mock(async () => {}),
    resume: mock(async () => {}),
    _listeners: listeners,
  } as unknown as mediasoupTypes.Producer & {
    _listeners: Map<string, EventListener[]>;
    pause: ReturnType<typeof mock>;
    resume: ReturnType<typeof mock>;
  };
}

/** Create a mock mediasoup Consumer. */
function createMockConsumer(
  id: string,
  kind: mediasoupTypes.MediaKind,
  producerPaused = false,
): mediasoupTypes.Consumer & {
  _listeners: Map<string, EventListener[]>;
  resume: ReturnType<typeof mock>;
} {
  const listeners = new Map<string, EventListener[]>();
  return {
    id,
    kind,
    rtpParameters: { codecs: [], headerExtensions: [], encodings: [] },
    producerPaused,
    on(event: string, fn: EventListener) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    resume: mock(async () => {}),
    _listeners: listeners,
  } as unknown as mediasoupTypes.Consumer & {
    _listeners: Map<string, EventListener[]>;
    resume: ReturnType<typeof mock>;
  };
}

/** Create a mock WebRtcTransport. */
function createMockTransport(id: string): mediasoupTypes.WebRtcTransport & {
  connect: ReturnType<typeof mock>;
  produce: ReturnType<typeof mock>;
  consume: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return {
    id,
    iceParameters: { usernameFragment: 'uf', password: 'pw' },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [] },
    sctpParameters: undefined,
    connect: mock(async () => {}),
    produce: mock(async () => createMockProducer('prod-1', 'audio')),
    consume: mock(async () => createMockConsumer('cons-1', 'audio')),
    close: mock(() => {}),
  } as unknown as mediasoupTypes.WebRtcTransport & {
    connect: ReturnType<typeof mock>;
    produce: ReturnType<typeof mock>;
    consume: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
  };
}

/** Create a mock AudioLevelObserver. */
function createMockAudioLevelObserver(): mediasoupTypes.AudioLevelObserver & {
  addProducer: ReturnType<typeof mock>;
} {
  return {
    addProducer: mock(async () => {}),
    close: mock(() => {}),
    on: mock(() => {}),
  } as unknown as mediasoupTypes.AudioLevelObserver & {
    addProducer: ReturnType<typeof mock>;
  };
}

/** Create a mock Router. */
function createMockRouter(): mediasoupTypes.Router & {
  createWebRtcTransport: ReturnType<typeof mock>;
  canConsume: ReturnType<typeof mock>;
} {
  const rtpCapabilities: mediasoupTypes.RtpCapabilities = {
    codecs: [
      {
        mimeType: 'audio/opus',
        kind: 'audio',
        clockRate: 48000,
        channels: 2,
        preferredPayloadType: 111,
      },
    ],
    headerExtensions: [],
  };

  return {
    id: 'router-1',
    rtpCapabilities,
    createWebRtcTransport: mock(async () => createMockTransport('transport-new')),
    canConsume: mock(() => true),
    close: mock(() => {}),
  } as unknown as mediasoupTypes.Router & {
    createWebRtcTransport: ReturnType<typeof mock>;
    canConsume: ReturnType<typeof mock>;
  };
}

/** Create a test SfuRoomState. */
function createTestRoom(): SfuRoomState & {
  router: ReturnType<typeof createMockRouter>;
  audioLevelObserver: ReturnType<typeof createMockAudioLevelObserver>;
} {
  return {
    router: createMockRouter(),
    audioLevelObserver: createMockAudioLevelObserver(),
    peers: new Map(),
    producerOwners: new Map(),
  };
}

/** Create a mock SfuRoomManager. */
function createMockRoomManager(room: SfuRoomState): SfuRoomManager {
  return {
    getOrCreateRoom: mock(async () => room),
    getRoom: mock((roomId: string) => (roomId === 'room-1' ? room : undefined)),
    removeRoom: mock(() => {}),
    get roomCount() {
      return 1;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

let room: ReturnType<typeof createTestRoom>;
let roomManager: ReturnType<typeof createMockRoomManager>;
let sentMessages: ServerToClientMessage[];
let routedMessages: Array<{
  roomId: string;
  peerId: string;
  message: ServerToClientMessage;
}>;
let routeToPeer: RouteToPeerFn;

beforeEach(() => {
  room = createTestRoom();
  roomManager = createMockRoomManager(room);

  sentMessages = [];
  routedMessages = [];

  routeToPeer = (roomId, peerId, message) => {
    routedMessages.push({ roomId, peerId, message });
    return true;
  };
});

function createHandler() {
  return createSfuPeerHandler({
    sfuRoomManager: roomManager,
    send: (_ws, message) => {
      sentMessages.push(message);
    },
    routeToPeer,
    listenIp: '0.0.0.0',
    announcedIp: '1.2.3.4',
  });
}

describe('handleSfuJoin', () => {
  test('stores peer state and responds with router capabilities', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    // Peer state should be stored
    const peer = room.peers.get('peer-1');
    expect(peer).toBeDefined();
    expect(peer!.peerId).toBe('peer-1');
    expect(peer!.roomId).toBe('room-1');
    expect(peer!.rtpCapabilities).toEqual({ codecs: [], headerExtensions: [] });

    // Should respond with router caps
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.type).toBe('sfu-router-caps');
  });
});

describe('handleCreateTransport', () => {
  test('creates a send transport and responds with transport params', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    // First join
    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    sentMessages.length = 0;

    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');

    expect(room.router.createWebRtcTransport).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.type).toBe('sfu-transport-created');
    if (msg.type === 'sfu-transport-created') {
      expect(msg.direction).toBe('send');
      expect(msg.id).toBe('transport-new');
    }

    // Peer state should reference the transport
    const peer = room.peers.get('peer-1')!;
    expect(peer.sendTransport).not.toBeNull();
  });

  test('creates a recv transport', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    sentMessages.length = 0;

    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'recv');

    const peer = room.peers.get('peer-1')!;
    expect(peer.recvTransport).not.toBeNull();
  });

  test('throws when peer is not in room', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await expect(
      handler.handleCreateTransport(ws, 'unknown-peer', 'room-1', 'send'),
    ).rejects.toThrow('Peer unknown-peer not found');
  });
});

describe('handleConnectTransport', () => {
  test('connects the send transport with DTLS parameters', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');

    const peer = room.peers.get('peer-1')!;
    const transport = peer.sendTransport as unknown as ReturnType<typeof createMockTransport>;

    await handler.handleConnectTransport(ws, 'peer-1', 'room-1', transport.id, {
      fingerprints: [],
    } as unknown as mediasoupTypes.DtlsParameters);

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledWith({
      dtlsParameters: { fingerprints: [] },
    });
  });

  test('throws for unknown transport ID', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    await expect(
      handler.handleConnectTransport(ws, 'peer-1', 'room-1', 'nonexistent-transport', {
        fingerprints: [],
      } as unknown as mediasoupTypes.DtlsParameters),
    ).rejects.toThrow('Transport nonexistent-transport not found');
  });
});

describe('handleProduce', () => {
  test('creates a producer and responds with producer-created', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');

    const peer = room.peers.get('peer-1')!;
    const transport = peer.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    sentMessages.length = 0;

    await handler.handleProduce(
      ws,
      'peer-1',
      'room-1',
      transport.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    expect(transport.produce).toHaveBeenCalledTimes(1);

    // Should send sfu-producer-created
    const producerMsg = sentMessages.find((m) => m.type === 'sfu-producer-created');
    expect(producerMsg).toBeDefined();

    // Should add to AudioLevelObserver for audio
    expect(room.audioLevelObserver.addProducer).toHaveBeenCalledTimes(1);

    // Should record producer owner
    expect(room.producerOwners.size).toBe(1);
  });

  test('does not add video producer to AudioLevelObserver', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');

    const peer = room.peers.get('peer-1')!;
    const transport = peer.sendTransport as unknown as ReturnType<typeof createMockTransport>;

    // Make produce return a video producer
    transport.produce.mockImplementation(async () => createMockProducer('prod-video', 'video'));
    sentMessages.length = 0;

    await handler.handleProduce(
      ws,
      'peer-1',
      'room-1',
      transport.id,
      'video',
      {} as mediasoupTypes.RtpParameters,
    );

    expect(room.audioLevelObserver.addProducer).not.toHaveBeenCalled();
  });

  test('creates consumers for other peers when a new producer appears', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    // Peer 1 joins and creates send transport
    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    // Peer 2 joins and creates recv transport
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    routedMessages.length = 0;

    // Peer 1 produces — should trigger consumer creation on peer 2's recv transport
    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    // Peer 2 should receive sfu-new-consumer via routeToPeer
    const consumerMsg = routedMessages.find(
      (r) => r.peerId === 'peer-2' && r.message.type === 'sfu-new-consumer',
    );
    expect(consumerMsg).toBeDefined();

    // Peer 2 should have a consumer in their state
    const peer2 = room.peers.get('peer-2')!;
    expect(peer2.consumers.size).toBe(1);
  });
});

describe('handleConsumeResume', () => {
  test('resumes a consumer', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    // Manually add a mock consumer to peer state
    const peer = room.peers.get('peer-1')!;
    const consumer = createMockConsumer('cons-1', 'audio');
    peer.consumers.set('cons-1', consumer);

    await handler.handleConsumeResume(ws, 'peer-1', 'room-1', 'cons-1');

    expect(consumer.resume).toHaveBeenCalledTimes(1);
  });

  test('throws for unknown consumer', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    await expect(
      handler.handleConsumeResume(ws, 'peer-1', 'room-1', 'unknown-consumer'),
    ).rejects.toThrow('Consumer unknown-consumer not found');
  });
});

describe('handleProducerPause / handleProducerResume', () => {
  test('pauses a producer', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    const peer = room.peers.get('peer-1')!;
    const producer = createMockProducer('prod-1', 'audio');
    peer.producers.set('prod-1', producer);

    await handler.handleProducerPause(ws, 'peer-1', 'room-1', 'prod-1');

    expect(producer.pause).toHaveBeenCalledTimes(1);
  });

  test('resumes a producer', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    const peer = room.peers.get('peer-1')!;
    const producer = createMockProducer('prod-1', 'audio');
    peer.producers.set('prod-1', producer);

    await handler.handleProducerResume(ws, 'peer-1', 'room-1', 'prod-1');

    expect(producer.resume).toHaveBeenCalledTimes(1);
  });

  test('throws for unknown producer', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    await expect(
      handler.handleProducerPause(ws, 'peer-1', 'room-1', 'unknown-producer'),
    ).rejects.toThrow('Producer unknown-producer not found');
  });
});

describe('handlePeerLeave', () => {
  test('closes transports and removes peer from room', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'recv');

    const peer = room.peers.get('peer-1')!;
    const sendClose = (peer.sendTransport as unknown as ReturnType<typeof createMockTransport>)
      .close;
    const recvClose = (peer.recvTransport as unknown as ReturnType<typeof createMockTransport>)
      .close;

    handler.handlePeerLeave('peer-1', 'room-1');

    expect(sendClose).toHaveBeenCalledTimes(1);
    expect(recvClose).toHaveBeenCalledTimes(1);
    expect(room.peers.has('peer-1')).toBe(false);
  });

  test('removes room when last peer leaves', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    handler.handlePeerLeave('peer-1', 'room-1');

    expect(roomManager.removeRoom).toHaveBeenCalledWith('room-1');
  });

  test('does not remove room when other peers remain', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    handler.handlePeerLeave('peer-1', 'room-1');

    expect(roomManager.removeRoom).not.toHaveBeenCalled();
    expect(room.peers.has('peer-2')).toBe(true);
  });

  test('cleans up producer owner mappings', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    // Manually add a producer to simulate state
    const peer = room.peers.get('peer-1')!;
    const producer = createMockProducer('prod-1', 'audio');
    peer.producers.set('prod-1', producer);
    room.producerOwners.set('prod-1', 'peer-1');

    handler.handlePeerLeave('peer-1', 'room-1');

    expect(room.producerOwners.has('prod-1')).toBe(false);
  });

  test('no-op when room does not exist', () => {
    const handler = createHandler();

    // Should not throw
    handler.handlePeerLeave('peer-1', 'nonexistent-room');
  });

  test('no-op when peer not in room', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });

    // Should not throw
    handler.handlePeerLeave('unknown-peer', 'room-1');

    // Room should still have peer-1
    expect(room.peers.has('peer-1')).toBe(true);
  });
});

// ============================================================================
// Edge cases: consumer creation, error handling
// ============================================================================

describe('consumer creation edge cases', () => {
  test('canConsume returning false skips consumer creation', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    // Peer 1 joins and creates send transport
    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    // Peer 2 joins and creates recv transport
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    // Make canConsume return false
    room.router.canConsume.mockReturnValue(false);
    routedMessages.length = 0;

    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;

    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    // Peer 2 should NOT receive sfu-new-consumer
    const consumerMsgs = routedMessages.filter(
      (r) => r.peerId === 'peer-2' && r.message.type === 'sfu-new-consumer',
    );
    expect(consumerMsgs).toHaveLength(0);

    // Peer 2 should have no consumers
    const peer2 = room.peers.get('peer-2')!;
    expect(peer2.consumers.size).toBe(0);
  });

  test('consumer creation failure is caught and logged', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    // Peer 1 joins and creates send transport
    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    // Peer 2 joins and creates recv transport
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    // Make peer 2's recv transport fail on consume
    const peer2 = room.peers.get('peer-2')!;
    const recvTransport = peer2.recvTransport as unknown as ReturnType<typeof createMockTransport>;
    recvTransport.consume.mockRejectedValue(new Error('consume failed'));

    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;

    // Should not throw — error is caught internally
    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    // Producer was still created successfully
    expect(sentMessages.some((m) => m.type === 'sfu-producer-created')).toBe(true);

    // Peer 2 has no consumers (creation failed)
    expect(peer2.consumers.size).toBe(0);
  });

  test('createConsumersForNewPeer creates consumers for existing producers on recv transport creation', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    // Peer 1 joins, creates send transport, and produces audio
    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    // Clear messages so we can check what peer 2 gets
    routedMessages.length = 0;

    // Peer 2 joins and creates recv transport — should get consumer for peer 1's producer
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    // Peer 2 should receive sfu-new-consumer for peer 1's audio producer
    const consumerMsg = routedMessages.find(
      (r) => r.peerId === 'peer-2' && r.message.type === 'sfu-new-consumer',
    );
    expect(consumerMsg).toBeDefined();
    if (consumerMsg && consumerMsg.message.type === 'sfu-new-consumer') {
      expect(consumerMsg.message.peerId).toBe('peer-1');
    }
  });

  test('consumer transportclose event removes consumer from peer state', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    // Peer 1 joins and creates send transport
    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    // Peer 2 joins and creates recv transport
    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    // Peer 1 produces — creates consumer on peer 2
    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    const peer2 = room.peers.get('peer-2')!;
    expect(peer2.consumers.size).toBe(1);

    // Get the consumer and trigger transportclose
    const [consumerId, consumer] = [...peer2.consumers.entries()][0]!;
    const listeners = (consumer as unknown as { _listeners: Map<string, EventListener[]> })
      ._listeners;
    const transportCloseHandlers = listeners.get('transportclose') ?? [];
    expect(transportCloseHandlers.length).toBe(1);

    transportCloseHandlers[0]!();
    expect(peer2.consumers.has(consumerId)).toBe(false);
  });

  test('consumer producerclose event removes consumer from peer state', async () => {
    const handler = createHandler();
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    await handler.handleSfuJoin(ws1, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws1, 'peer-1', 'room-1', 'send');

    await handler.handleSfuJoin(ws2, 'peer-2', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws2, 'peer-2', 'room-1', 'recv');

    const peer1 = room.peers.get('peer-1')!;
    const transport1 = peer1.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    await handler.handleProduce(
      ws1,
      'peer-1',
      'room-1',
      transport1.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    const peer2 = room.peers.get('peer-2')!;
    expect(peer2.consumers.size).toBe(1);

    const [consumerId, consumer] = [...peer2.consumers.entries()][0]!;
    const listeners = (consumer as unknown as { _listeners: Map<string, EventListener[]> })
      ._listeners;
    const producerCloseHandlers = listeners.get('producerclose') ?? [];
    expect(producerCloseHandlers.length).toBe(1);

    producerCloseHandlers[0]!();
    expect(peer2.consumers.has(consumerId)).toBe(false);
  });

  test('AudioLevelObserver addProducer failure is caught', async () => {
    const handler = createHandler();
    const ws = createMockWs();

    await handler.handleSfuJoin(ws, 'peer-1', 'room-1', {
      codecs: [],
      headerExtensions: [],
    });
    await handler.handleCreateTransport(ws, 'peer-1', 'room-1', 'send');

    // Make addProducer reject
    room.audioLevelObserver.addProducer.mockRejectedValue(new Error('observer failed'));

    const peer = room.peers.get('peer-1')!;
    const transport = peer.sendTransport as unknown as ReturnType<typeof createMockTransport>;
    sentMessages.length = 0;

    // Should not throw — the catch in handleProduce handles the error
    await handler.handleProduce(
      ws,
      'peer-1',
      'room-1',
      transport.id,
      'audio',
      {} as mediasoupTypes.RtpParameters,
    );

    // Producer was still created
    expect(sentMessages.some((m) => m.type === 'sfu-producer-created')).toBe(true);
    expect(peer.producers.size).toBe(1);
  });
});
