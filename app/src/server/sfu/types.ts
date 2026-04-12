/**
 * Internal types for the SFU subsystem.
 *
 * Wire format schemas live in shared/schemas.ts (Zod = source of truth).
 * These types describe server-side SFU state that is never serialized.
 *
 * @module server/sfu/types
 */

import type { ServerWebSocket } from 'bun';
import type { types as mediasoupTypes } from 'mediasoup';
import type { ServerToClientMessage } from '../../shared/schemas';
import type { ServerClientData, SendFn } from '../rooms';

// ============================================================================
// Per-peer SFU state
// ============================================================================

/** Tracks all mediasoup resources for a single peer in a single room. */
export interface SfuPeerState {
  readonly peerId: string;
  readonly roomId: string;
  rtpCapabilities: mediasoupTypes.RtpCapabilities | null;
  sendTransport: mediasoupTypes.WebRtcTransport | null;
  recvTransport: mediasoupTypes.WebRtcTransport | null;
  /** producerId → Producer */
  readonly producers: Map<string, mediasoupTypes.Producer>;
  /** consumerId → Consumer */
  readonly consumers: Map<string, mediasoupTypes.Consumer>;
}

// ============================================================================
// Per-room SFU state
// ============================================================================

/** Tracks the mediasoup Router, AudioLevelObserver, and peer map for a room. */
export interface SfuRoomState {
  readonly router: mediasoupTypes.Router;
  readonly audioLevelObserver: mediasoupTypes.AudioLevelObserver;
  /** peerId → SfuPeerState */
  readonly peers: Map<string, SfuPeerState>;
  /** producerId → peerId — reverse lookup for consumer creation */
  readonly producerOwners: Map<string, string>;
}

// ============================================================================
// Worker manager
// ============================================================================

/** Manages a pool of mediasoup Workers with round-robin assignment. */
export interface WorkerManager {
  /** Get the next Worker in the pool (round-robin). */
  getNextWorker(): mediasoupTypes.Worker;
  /** Number of active workers in the pool. */
  readonly workerCount: number;
  /** Shut down all workers. */
  close(): void;
}

// ============================================================================
// SFU room manager
// ============================================================================

/** Callback for broadcasting a message to all peers in a room. */
export type BroadcastFn = (
  roomId: string,
  message: ServerToClientMessage,
  excludePeerId?: string,
) => void;

/** Dependencies for creating an SFU room manager. */
export interface SfuRoomManagerDeps {
  readonly workerManager: WorkerManager;
  /** Broadcast to all room peers via the existing RoomManager. */
  readonly broadcast: BroadcastFn;
  readonly listenIp: string;
  readonly announcedIp: string | undefined;
}

/** Manages mediasoup Routers per room — lazy creation, cleanup on empty. */
export interface SfuRoomManager {
  /** Get or lazily create an SFU room (Router + AudioLevelObserver). */
  getOrCreateRoom(roomId: string): Promise<SfuRoomState>;
  /** Get existing room state, or undefined. */
  getRoom(roomId: string): SfuRoomState | undefined;
  /** Close and remove a room. */
  removeRoom(roomId: string): void;
  /** Number of active SFU rooms. */
  readonly roomCount: number;
}

// ============================================================================
// SFU peer handler
// ============================================================================

/** Callback for sending a message to a specific peer via the existing RoomManager. */
export type RouteToPeerFn = (
  roomId: string,
  targetPeerId: string,
  message: ServerToClientMessage,
) => boolean;

/** Dependencies for creating an SFU peer handler. */
export interface SfuPeerHandlerDeps {
  readonly sfuRoomManager: SfuRoomManager;
  readonly send: SendFn;
  /** Route a message to a specific peer (delegates to RoomManager.routeToPeer). */
  readonly routeToPeer: RouteToPeerFn;
  readonly listenIp: string;
  readonly announcedIp: string | undefined;
}

/** Handles per-peer SFU signaling messages. */
export interface SfuPeerHandler {
  /** Peer joins SFU call — stores rtpCapabilities, responds with router caps. */
  handleSfuJoin(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ): Promise<void>;

  /** Create a send or recv WebRtcTransport for a peer. */
  handleCreateTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    direction: 'send' | 'recv',
  ): Promise<void>;

  /** Connect a transport with DTLS parameters. */
  handleConnectTransport(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    transportId: string,
    dtlsParameters: mediasoupTypes.DtlsParameters,
  ): Promise<void>;

  /** Peer starts producing a track (audio/video). */
  handleProduce(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: mediasoupTypes.RtpParameters,
  ): Promise<void>;

  /** Peer confirms it created a local Consumer — resume server-side Consumer. */
  handleConsumeResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    consumerId: string,
  ): Promise<void>;

  /** Peer pauses a Producer (mute). */
  handleProducerPause(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    producerId: string,
  ): Promise<void>;

  /** Peer resumes a Producer (unmute). */
  handleProducerResume(
    ws: ServerWebSocket<ServerClientData>,
    peerId: string,
    roomId: string,
    producerId: string,
  ): Promise<void>;

  /** Peer disconnected — clean up all SFU resources. */
  handlePeerLeave(peerId: string, roomId: string): void;
}
