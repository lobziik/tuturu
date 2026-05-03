/**
 * Message handler orchestration layer.
 *
 * Each handler receives dependencies explicitly. Pure orchestration — no state.
 * Handlers bridge between the WebSocket router (ws.ts) and the data layer
 * (rooms, database, blob store).
 *
 * @module server/handlers
 */

import type { ServerWebSocket } from 'bun';
import type { ClientToServerMessage, ServerToClientMessage } from '../shared/schemas';
import type { types as mediasoupTypes } from 'mediasoup';
import type { MessageStore } from './database';
import type { RoomManager, ServerClientData, SendFn } from './rooms';
import type { Heartbeat } from './heartbeat';
import type { SfuPeerHandler } from './sfu/types';
import { createHeartbeat } from './heartbeat';
import { MAX_CALL_PARTICIPANTS } from '../shared/constants';

/** ICE configuration provider */
interface IceConfig {
  buildIceServers(peerId: string): Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  forceRelay: boolean;
}

/** Dependencies injected into the handler factory */
interface HandlerDeps {
  rooms: RoomManager;
  db: MessageStore;
  iceConfig: IceConfig;
  historyBatchSize: number;
  send: SendFn;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  /** SFU peer handler — optional, SFU features disabled when absent. */
  sfuPeerHandler?: SfuPeerHandler;
  /** Whether to require client-side E2EE (RTCRtpScriptTransform) for media. */
  e2eeMediaEnabled: boolean;
}

/** Public handler interface used by the WS router */
export interface Handlers {
  handleJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'join' }>,
  ): void;
  handleLeave(ws: ServerWebSocket<ServerClientData>, peerId: string): void;
  handleChat(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'chat' }>,
  ): void;
  handleHistoryRequest(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'history-request' }>,
  ): void;
  handleRelay(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg:
      | Extract<ClientToServerMessage, { type: 'offer' }>
      | Extract<ClientToServerMessage, { type: 'answer' }>
      | Extract<ClientToServerMessage, { type: 'ice-candidate' }>,
  ): void;
  handleJoinCall(ws: ServerWebSocket<ServerClientData>, peerId: string): void;
  handleLeaveCall(ws: ServerWebSocket<ServerClientData>, peerId: string): void;
  handleChatReceived(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'chat-received' }>,
  ): void;
  handlePong(ws: ServerWebSocket<ServerClientData>, peerId: string): void;
  /** Called on WS close — cleanup heartbeat and room membership */
  handleDisconnect(ws: ServerWebSocket<ServerClientData>, peerId: string): void;

  // SFU handlers
  handleSfuJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-join' }>,
  ): void;
  handleSfuCreateTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-create-transport' }>,
  ): void;
  handleSfuConnectTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-connect-transport' }>,
  ): void;
  handleSfuProduce(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-produce' }>,
  ): void;
  handleSfuConsumeResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-consume-resume' }>,
  ): void;
  handleSfuProducerPause(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-producer-pause' }>,
  ): void;
  handleSfuProducerResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-producer-resume' }>,
  ): void;
}

/**
 * Create message handlers with injected dependencies.
 */
export function createHandlers(deps: HandlerDeps): Handlers {
  const { rooms, db, iceConfig, historyBatchSize, send, pingIntervalMs, pongTimeoutMs } = deps;

  /** Active heartbeats per peerId */
  const heartbeats = new Map<string, Heartbeat>();

  function startHeartbeat(ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    stopHeartbeat(peerId);
    const hb = createHeartbeat(
      () => send(ws, { type: 'ping', v: 1 }),
      () => {
        console.log(`[HEARTBEAT] Peer ${peerId} timed out — closing connection`);
        stopHeartbeat(peerId);
        try {
          ws.close(1000, 'Pong timeout');
        } catch {
          // Connection already closed
        }
      },
      { pingIntervalMs, pongTimeoutMs },
    );
    heartbeats.set(peerId, hb);
    hb.start();
  }

  function stopHeartbeat(peerId: string): void {
    const hb = heartbeats.get(peerId);
    if (hb) {
      hb.stop();
      heartbeats.delete(peerId);
    }
  }

  function handleJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'join' }>,
  ): void {
    const result = rooms.join(msg.roomId, peerId, ws, msg.encryptedNickname);

    if ('error' in result) {
      console.warn(`[HANDLER] ${peerId} join rejected: room ${msg.roomId} is full`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'ROOM_FULL',
        message: 'Room has reached maximum capacity',
      });
      return;
    }

    // Store roomId on WebSocket data
    ws.data.roomId = msg.roomId;

    // Send ICE configuration + SFU availability flag
    const iceServers = iceConfig.buildIceServers(peerId);
    send(ws, {
      type: 'join',
      v: 1,
      iceServers,
      iceTransportPolicy: iceConfig.forceRelay ? 'relay' : 'all',
      sfuEnabled: !!deps.sfuPeerHandler,
      e2eeMediaEnabled: deps.e2eeMediaEnabled,
    });

    // Send peers list to the new peer
    send(ws, {
      type: 'peers-list',
      v: 1,
      selfPeerId: peerId,
      peers: result.peers.map((p) => ({
        peerId: p.peerId,
        encryptedNickname: p.encryptedNickname,
      })),
    });

    // Send current call peers so new joiner knows if a call is active
    const callPeers = rooms.getCallPeers(msg.roomId);
    if (callPeers.length > 0) {
      send(ws, { type: 'call-peers', v: 1, callPeers });
    }

    // Send initial history batch
    const history = db.getHistory(msg.roomId, undefined, historyBatchSize);
    send(ws, {
      type: 'history',
      v: 1,
      messages: history.messages.map((m) => ({
        id: m.id,
        blob: m.blob,
        created_at: m.createdAt,
      })),
      hasMore: history.hasMore,
    });

    // Start heartbeat for this connection
    startHeartbeat(ws, peerId);
  }

  function handleLeave(ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    const roomId = ws.data.roomId;
    if (roomId) {
      deps.sfuPeerHandler?.handlePeerLeave(peerId, roomId);
      rooms.leave(roomId, peerId);
      ws.data.roomId = null;
    }
    sfuPeerQueues.delete(peerId);
    stopHeartbeat(peerId);
  }

  function handleChat(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'chat' }>,
  ): void {
    const roomId = ws.data.roomId;
    if (!roomId) {
      console.warn(`[HANDLER] ${peerId} chat rejected: not in room`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before sending chat',
      });
      return;
    }

    // Verify the chat message targets the room the peer is in
    if (msg.roomId !== roomId) {
      console.warn(
        `[HANDLER] ${peerId} chat rejected: roomId mismatch (sent=${msg.roomId}, joined=${roomId})`,
      );
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Chat roomId does not match joined room',
      });
      return;
    }

    // Persist the message
    const { createdAt } = db.insertMessage(roomId, msg.blob);

    // Broadcast to all peers except sender
    rooms.broadcast(
      roomId,
      {
        type: 'chat-broadcast',
        v: 1,
        blob: msg.blob,
        created_at: createdAt,
      },
      peerId,
    );

    // Send ack to sender
    send(ws, { type: 'chat-ack', v: 1, uuid: msg.uuid });
  }

  function handleHistoryRequest(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'history-request' }>,
  ): void {
    const roomId = ws.data.roomId;
    if (!roomId) {
      console.warn(`[HANDLER] ${peerId} history-request rejected: not in room`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before requesting history',
      });
      return;
    }

    const limit =
      msg.limit === undefined ? historyBatchSize : Math.min(msg.limit, historyBatchSize);
    const history = db.getHistory(roomId, msg.before, limit);

    send(ws, {
      type: 'history',
      v: 1,
      messages: history.messages.map((m) => ({
        id: m.id,
        blob: m.blob,
        created_at: m.createdAt,
      })),
      hasMore: history.hasMore,
    });
  }

  function handleRelay(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg:
      | Extract<ClientToServerMessage, { type: 'offer' }>
      | Extract<ClientToServerMessage, { type: 'answer' }>
      | Extract<ClientToServerMessage, { type: 'ice-candidate' }>,
  ): void {
    const roomId = ws.data.roomId;
    if (!roomId) {
      console.warn(`[HANDLER] ${peerId} relay (${msg.type}) rejected: not in room`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before relaying',
      });
      return;
    }

    // Directed relay: substitute sender peerId and route to target
    let relayMsg: ServerToClientMessage;
    switch (msg.type) {
      case 'offer':
        relayMsg = { type: 'offer', v: 1, sdp: msg.sdp, peerId };
        break;
      case 'answer':
        relayMsg = { type: 'answer', v: 1, sdp: msg.sdp, peerId };
        break;
      case 'ice-candidate':
        relayMsg = { type: 'ice-candidate', v: 1, candidate: msg.candidate, peerId };
        break;
    }

    const found = rooms.routeToPeer(roomId, msg.targetPeerId, relayMsg);
    if (!found) {
      console.warn(`[RELAY] Target peer ${msg.targetPeerId} not found in room ${roomId}`);
    }
  }

  function handleJoinCall(ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    const roomId = ws.data.roomId;
    if (!roomId) {
      console.warn(`[HANDLER] ${peerId} join-call rejected: not in room`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before joining call',
      });
      return;
    }

    const result = rooms.joinCall(roomId, peerId);
    if ('error' in result) {
      if (result.error === 'call_full') {
        console.warn(`[HANDLER] ${peerId} join-call rejected: call is full`);
        send(ws, {
          type: 'error',
          v: 1,
          code: 'CALL_FULL',
          message: `Call is full (max ${MAX_CALL_PARTICIPANTS} participants)`,
        });
        return;
      }
      console.warn(`[HANDLER] ${peerId} join-call rejected: not in room (rooms check)`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before joining call',
      });
      return;
    }

    // Send current call peers to the new call participant
    send(ws, { type: 'call-peers', v: 1, callPeers: result.callPeers });
  }

  function handleLeaveCall(ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    const roomId = ws.data.roomId;
    if (!roomId) return;
    deps.sfuPeerHandler?.handlePeerLeave(peerId, roomId);
    rooms.leaveCall(roomId, peerId);
  }

  function handleChatReceived(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'chat-received' }>,
  ): void {
    const roomId = ws.data.roomId;
    if (!roomId) return;

    // Relay the delivery ACK to the target peer
    rooms.routeToPeer(roomId, msg.peerId, {
      type: 'chat-received',
      v: 1,
      uuid: msg.uuid,
      peerId,
    });
  }

  function handlePong(_ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    const hb = heartbeats.get(peerId);
    if (hb) hb.receivedPong();
  }

  function handleDisconnect(ws: ServerWebSocket<ServerClientData>, peerId: string): void {
    handleLeave(ws, peerId);
  }

  // ============================================================================
  // SFU handlers — thin wrappers: guard "not in room", delegate to sfuPeerHandler
  // ============================================================================

  /** Guard: peer must be in a room for SFU operations. Returns roomId or sends error. */
  function requireRoomId(ws: ServerWebSocket<ServerClientData>, peerId: string): string | null {
    const roomId = ws.data.roomId;
    if (!roomId) {
      console.warn(`[HANDLER] ${peerId} SFU operation rejected: not in room`);
      send(ws, {
        type: 'error',
        v: 1,
        code: 'NOT_IN_ROOM',
        message: 'Must join a room before SFU operations',
      });
      return null;
    }
    return roomId;
  }

  /**
   * Per-peer sequential queue for SFU operations.
   * Chains promises per peerId so operations execute in order (e.g., sfu-join
   * completes before sfu-create-transport starts). Prevents race conditions
   * from fire-and-forget async dispatch.
   */
  const sfuPeerQueues = new Map<string, Promise<void>>();

  /** Enqueue an async SFU operation for sequential per-peer execution. */
  function enqueueSfuOp(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    fn: () => Promise<void>,
  ): void {
    const prev = sfuPeerQueues.get(peerId) ?? Promise.resolve();
    const next = prev
      .then(() => fn())
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[HANDLER] SFU error for peer ${peerId}: ${msg}`);
        send(ws, {
          type: 'error',
          v: 1,
          code: 'UNKNOWN',
          message: `SFU operation failed: ${msg}`,
        });
      });
    sfuPeerQueues.set(peerId, next);
  }

  function handleSfuJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-join' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleSfuJoin(
        ws,
        peerId,
        roomId,
        msg.rtpCapabilities as mediasoupTypes.RtpCapabilities | null,
      ),
    );
  }

  function handleSfuCreateTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-create-transport' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleCreateTransport(ws, peerId, roomId, msg.direction),
    );
  }

  function handleSfuConnectTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-connect-transport' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleConnectTransport(
        ws,
        peerId,
        roomId,
        msg.transportId,
        msg.dtlsParameters as mediasoupTypes.DtlsParameters,
      ),
    );
  }

  function handleSfuProduce(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-produce' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleProduce(
        ws,
        peerId,
        roomId,
        msg.transportId,
        msg.kind,
        msg.rtpParameters as mediasoupTypes.RtpParameters,
      ),
    );
  }

  function handleSfuConsumeResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-consume-resume' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleConsumeResume(ws, peerId, roomId, msg.consumerId),
    );
  }

  function handleSfuProducerPause(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-producer-pause' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleProducerPause(ws, peerId, roomId, msg.producerId),
    );
  }

  function handleSfuProducerResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    msg: Extract<ClientToServerMessage, { type: 'sfu-producer-resume' }>,
  ): void {
    const roomId = requireRoomId(ws, peerId);
    if (!roomId || !deps.sfuPeerHandler) return;
    enqueueSfuOp(ws, peerId, () =>
      deps.sfuPeerHandler!.handleProducerResume(ws, peerId, roomId, msg.producerId),
    );
  }

  return {
    handleJoin,
    handleLeave,
    handleChat,
    handleHistoryRequest,
    handleRelay,
    handleJoinCall,
    handleLeaveCall,
    handleChatReceived,
    handlePong,
    handleDisconnect,
    handleSfuJoin,
    handleSfuCreateTransport,
    handleSfuConnectTransport,
    handleSfuProduce,
    handleSfuConsumeResume,
    handleSfuProducerPause,
    handleSfuProducerResume,
  };
}
