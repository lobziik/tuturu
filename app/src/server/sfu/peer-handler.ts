/**
 * SFU peer handler — per-peer transport, producer, and consumer management.
 *
 * Each handler method corresponds to one SFU signaling message type.
 * The peer handler bridges between WebSocket signaling and mediasoup objects.
 *
 * @module server/sfu/peer-handler
 */

import type { ServerWebSocket } from 'bun';
import type { types as mediasoupTypes } from 'mediasoup';
import type { ServerClientData } from '../rooms';
import type {
  SfuPeerState,
  SfuRoomState,
  SfuPeerHandlerDeps,
  SfuPeerHandler,
  SfuRoomManager,
  RouteToPeerFn,
} from './types';

/**
 * Create an SFU peer handler.
 *
 * @param deps.sfuRoomManager - Manages Router lifecycle per room.
 * @param deps.send - Callback for sending messages to a specific WebSocket.
 * @param deps.routeToPeer - Route a message to a peer via the existing RoomManager.
 * @param deps.listenIp - IP for new WebRtcTransports to bind on.
 * @param deps.announcedIp - External IP announced in ICE candidates.
 */
export function createSfuPeerHandler(deps: SfuPeerHandlerDeps): SfuPeerHandler {
  const { sfuRoomManager, send, routeToPeer, listenIp, announcedIp } = deps;

  async function handleSfuJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ): Promise<void> {
    const room = await sfuRoomManager.getOrCreateRoom(roomId);

    const existingPeer = room.peers.get(peerId);
    let peer: SfuPeerState;

    if (existingPeer) {
      // Second sfu-join (real caps) — update capabilities only, preserve transports/producers
      existingPeer.rtpCapabilities = rtpCapabilities;
      peer = existingPeer;
      console.log(`[SFU:PeerHandler] Peer ${peerId} re-joined SFU room ${roomId} (updated caps)`);
    } else {
      // First sfu-join — create fresh peer state
      peer = {
        peerId,
        roomId,
        rtpCapabilities,
        sendTransport: null,
        recvTransport: null,
        producers: new Map(),
        consumers: new Map(),
      };
      room.peers.set(peerId, peer);
      console.log(`[SFU:PeerHandler] Peer ${peerId} joined SFU room ${roomId}`);
    }

    // Send router RTP capabilities back to the client
    send(ws, {
      type: 'sfu-router-caps',
      v: 1,
      rtpCapabilities: room.router.rtpCapabilities,
    });

    // Create consumers for any existing producers from other peers
    await createConsumersForNewPeer(room, peer, roomId, routeToPeer);
  }

  async function handleCreateTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    direction: 'send' | 'recv',
  ): Promise<void> {
    const { room, peer } = lookupRoomAndPeer(sfuRoomManager, roomId, peerId);

    const transport = await room.router.createWebRtcTransport({
      listenInfos: [
        {
          protocol: 'udp' as const,
          ip: listenIp,
          ...(announcedIp ? { announcedAddress: announcedIp } : {}),
        },
        {
          protocol: 'tcp' as const,
          ip: listenIp,
          ...(announcedIp ? { announcedAddress: announcedIp } : {}),
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    if (direction === 'send') {
      peer.sendTransport = transport;
    } else {
      peer.recvTransport = transport;
    }

    send(ws, {
      type: 'sfu-transport-created',
      v: 1,
      direction,
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters ?? undefined,
    });

    console.log(
      `[SFU:PeerHandler] Created ${direction} transport ${transport.id} for peer ${peerId}`,
    );

    // When recv transport is created and peer has capabilities, create consumers
    // for all existing producers from other peers. This handles the case where
    // the peer joined before having a recv transport (two-step join flow).
    if (direction === 'recv' && peer.rtpCapabilities) {
      await createConsumersForNewPeer(room, peer, roomId, routeToPeer);
    }
  }

  async function handleConnectTransport(
    _ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    transportId: string,
    dtlsParameters: mediasoupTypes.DtlsParameters,
  ): Promise<void> {
    const transport = findTransport(sfuRoomManager, roomId, peerId, transportId);
    await transport.connect({ dtlsParameters });

    console.log(`[SFU:PeerHandler] Transport ${transportId} connected for peer ${peerId}`);
  }

  async function handleProduce(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: mediasoupTypes.RtpParameters,
  ): Promise<void> {
    const { room, peer } = lookupRoomAndPeer(sfuRoomManager, roomId, peerId);

    const transport = findTransport(sfuRoomManager, roomId, peerId, transportId);
    const producer = await transport.produce({ kind, rtpParameters });

    peer.producers.set(producer.id, producer);
    room.producerOwners.set(producer.id, peerId);

    // Clean up on producer close
    producer.on('transportclose', () => {
      peer.producers.delete(producer.id);
      room.producerOwners.delete(producer.id);
    });

    // Confirm producer creation to the producing peer
    send(ws, {
      type: 'sfu-producer-created',
      v: 1,
      id: producer.id,
      kind,
    });

    console.log(`[SFU:PeerHandler] Peer ${peerId} producing ${kind} (producer ${producer.id})`);

    // Add audio producers to the AudioLevelObserver
    if (kind === 'audio') {
      room.audioLevelObserver.addProducer({ producerId: producer.id }).catch((err: Error) => {
        console.warn(
          `[SFU:PeerHandler] Failed to add producer ${producer.id} to AudioLevelObserver: ${err.message}`,
        );
      });
    }

    // Create consumers on all other peers' recv transports for this new producer
    await createConsumersForProducer(room, producer, peerId, roomId, routeToPeer);
  }

  async function handleConsumeResume(
    _ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    consumerId: string,
  ): Promise<void> {
    const { peer } = lookupRoomAndPeer(sfuRoomManager, roomId, peerId);

    const consumer = peer.consumers.get(consumerId);
    if (!consumer) {
      throw new Error(`[SFU:PeerHandler] Consumer ${consumerId} not found for peer ${peerId}`);
    }

    await consumer.resume();
    console.log(`[SFU:PeerHandler] Consumer ${consumerId} resumed for peer ${peerId}`);
  }

  async function handleProducerPause(
    _ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    producerId: string,
  ): Promise<void> {
    const producer = findProducer(sfuRoomManager, roomId, peerId, producerId);
    await producer.pause();
    console.log(`[SFU:PeerHandler] Producer ${producerId} paused for peer ${peerId}`);
  }

  async function handleProducerResume(
    _ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    producerId: string,
  ): Promise<void> {
    const producer = findProducer(sfuRoomManager, roomId, peerId, producerId);
    await producer.resume();
    console.log(`[SFU:PeerHandler] Producer ${producerId} resumed for peer ${peerId}`);
  }

  function handlePeerLeave(peerId: string, roomId: string): void {
    const room = sfuRoomManager.getRoom(roomId);
    if (!room) return;

    const peer = room.peers.get(peerId);
    if (!peer) return;

    // Close transports — this auto-closes all associated producers and consumers
    if (peer.sendTransport) {
      peer.sendTransport.close();
    }
    if (peer.recvTransport) {
      peer.recvTransport.close();
    }

    // Clean up producer owner reverse lookup
    for (const producerId of peer.producers.keys()) {
      room.producerOwners.delete(producerId);
    }

    room.peers.delete(peerId);
    console.log(`[SFU:PeerHandler] Peer ${peerId} left SFU room ${roomId}`);

    // Remove the SFU room if no peers remain
    if (room.peers.size === 0) {
      sfuRoomManager.removeRoom(roomId);
    }
  }

  return {
    handleSfuJoin,
    handleCreateTransport,
    handleConnectTransport,
    handleProduce,
    handleConsumeResume,
    handleProducerPause,
    handleProducerResume,
    handlePeerLeave,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Look up room and peer state, throwing if either is missing. */
function lookupRoomAndPeer(
  sfuRoomManager: SfuRoomManager,
  roomId: string,
  peerId: string,
): { room: SfuRoomState; peer: SfuPeerState } {
  const room = sfuRoomManager.getRoom(roomId);
  if (!room) {
    throw new Error(`[SFU:PeerHandler] Room ${roomId} not found`);
  }
  const peer = room.peers.get(peerId);
  if (!peer) {
    throw new Error(`[SFU:PeerHandler] Peer ${peerId} not found in room ${roomId}`);
  }
  return { room, peer };
}

/** Find a transport (send or recv) by ID for a specific peer. */
function findTransport(
  sfuRoomManager: SfuRoomManager,
  roomId: string,
  peerId: string,
  transportId: string,
): mediasoupTypes.WebRtcTransport {
  const { peer } = lookupRoomAndPeer(sfuRoomManager, roomId, peerId);

  if (peer.sendTransport?.id === transportId) return peer.sendTransport;
  if (peer.recvTransport?.id === transportId) return peer.recvTransport;

  throw new Error(
    `[SFU:PeerHandler] Transport ${transportId} not found for peer ${peerId} in room ${roomId}`,
  );
}

/** Find a producer by ID for a specific peer. */
function findProducer(
  sfuRoomManager: SfuRoomManager,
  roomId: string,
  peerId: string,
  producerId: string,
): mediasoupTypes.Producer {
  const { peer } = lookupRoomAndPeer(sfuRoomManager, roomId, peerId);

  const producer = peer.producers.get(producerId);
  if (!producer) {
    throw new Error(`[SFU:PeerHandler] Producer ${producerId} not found for peer ${peerId}`);
  }

  return producer;
}

/**
 * Create consumers on all other peers' recv transports for a new producer.
 *
 * For each peer that has a recv transport and compatible RTP capabilities,
 * creates a Consumer (paused) and sends `sfu-new-consumer` notification.
 */
async function createConsumersForProducer(
  room: SfuRoomState,
  producer: mediasoupTypes.Producer,
  producerPeerId: string,
  roomId: string,
  routeToPeer: RouteToPeerFn,
): Promise<void> {
  for (const [consumerPeerId, consumerPeer] of room.peers) {
    if (consumerPeerId === producerPeerId) continue;
    if (!consumerPeer.recvTransport || !consumerPeer.rtpCapabilities) continue;

    await createSingleConsumer(
      room,
      producer,
      producerPeerId,
      consumerPeerId,
      consumerPeer,
      roomId,
      routeToPeer,
    );
  }
}

/**
 * When a new peer joins an existing SFU room, create consumers for all
 * existing producers from other peers. Called after the new peer creates
 * their recv transport (not immediately on join since they don't have one yet).
 *
 * Note: This is called eagerly on sfu-join, but consumers can only be created
 * once the new peer has a recv transport. Since transports are created after join,
 * this will be a no-op on initial join and the actual consumer creation happens
 * when producers arrive via createConsumersForProducer. However, if a peer
 * rejoins (already has a recv transport), this ensures they get existing producers.
 */
async function createConsumersForNewPeer(
  room: SfuRoomState,
  newPeer: SfuPeerState,
  roomId: string,
  routeToPeer: RouteToPeerFn,
): Promise<void> {
  if (!newPeer.recvTransport || !newPeer.rtpCapabilities) return;

  for (const [otherPeerId, otherPeer] of room.peers) {
    if (otherPeerId === newPeer.peerId) continue;

    for (const producer of otherPeer.producers.values()) {
      await createSingleConsumer(
        room,
        producer,
        otherPeerId,
        newPeer.peerId,
        newPeer,
        roomId,
        routeToPeer,
      );
    }
  }
}

/** Create a single consumer on a peer's recv transport for a given producer. */
async function createSingleConsumer(
  room: SfuRoomState,
  producer: mediasoupTypes.Producer,
  producerPeerId: string,
  consumerPeerId: string,
  consumerPeer: SfuPeerState,
  roomId: string,
  routeToPeer: RouteToPeerFn,
): Promise<void> {
  if (!consumerPeer.recvTransport || !consumerPeer.rtpCapabilities) return;

  if (
    !room.router.canConsume({
      producerId: producer.id,
      rtpCapabilities: consumerPeer.rtpCapabilities,
    })
  ) {
    console.warn(`[SFU:PeerHandler] Peer ${consumerPeerId} cannot consume producer ${producer.id}`);
    return;
  }

  try {
    const consumer = await consumerPeer.recvTransport.consume({
      producerId: producer.id,
      rtpCapabilities: consumerPeer.rtpCapabilities,
      paused: true,
    });

    consumerPeer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      consumerPeer.consumers.delete(consumer.id);
    });
    consumer.on('producerclose', () => {
      consumerPeer.consumers.delete(consumer.id);
    });

    routeToPeer(roomId, consumerPeerId, {
      type: 'sfu-new-consumer',
      v: 1,
      peerId: producerPeerId,
      producerId: producer.id,
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    });

    console.log(
      `[SFU:PeerHandler] Created consumer ${consumer.id} on peer ${consumerPeerId} for producer ${producer.id} (${consumer.kind})`,
    );
  } catch (error) {
    console.error(
      `[SFU:PeerHandler] Failed to create consumer for peer ${consumerPeerId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
