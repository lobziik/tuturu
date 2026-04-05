/**
 * Zod schemas for v2 wire format — source of truth for all message types.
 * TypeScript types are derived via `z.infer<>`, never hand-written.
 *
 * @remarks
 * All WebSocket messages include `v: 1` for wire format versioning.
 * The server is transparent to blob content — it never parses the encrypted payload.
 * ChatMessage is the plaintext structure inside the encrypted blob.
 *
 * @module shared/schemas
 */

import { z } from 'zod';

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodeSchema = z.enum([
  'ROOM_FULL',
  'INVALID_MESSAGE',
  'RATE_LIMITED',
  'BLOB_TOO_LARGE',
  'INVALID_BLOB_ID',
  'NOT_IN_ROOM',
  'UNKNOWN_PEER',
  'UNKNOWN',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ============================================================================
// ICE Configuration (shared between v1 and v2)
// ============================================================================

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const IceTransportPolicySchema = z.enum(['all', 'relay']);

// ============================================================================
// ChatMessage — plaintext structure inside encrypted blob
// ============================================================================

export const ChatMessageSchema = z.object({
  /** Wire format version */
  v: z.literal(1),
  /** Unique per-device identifier (UUID v4, persisted in IndexedDB) */
  deviceId: z.string(),
  /** Monotonic counter per deviceId — for replay detection */
  seq: z.number().int().nonnegative(),
  /** Unique message identifier — for deduplication */
  uuid: z.string(),
  /** Display name of sender (not identity — can change, can collide) */
  sender: z.string(),
  /** Unix timestamp in milliseconds */
  timestamp: z.number(),
  /** Message content type */
  type: z.enum(['text', 'photo']),
  /** Text content (present when type = "text") */
  text: z.string().optional(),
  /** Blob reference for photo (present when type = "photo") */
  blobId: z.string().optional(),
  /** Photo size in bytes before encryption (present when type = "photo") */
  size: z.number().int().positive().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ============================================================================
// Client → Server Messages
// ============================================================================

const JoinSchema = z.object({
  type: z.literal('join'),
  v: z.literal(1),
  roomId: z.string(),
  /** Encrypted nickname blob — server stores and relays without parsing */
  encryptedNickname: z.string(),
});

const ClientOfferSchema = z.object({
  type: z.literal('offer'),
  v: z.literal(1),
  sdp: z.string(),
  targetPeerId: z.string().optional(),
});

const ClientAnswerSchema = z.object({
  type: z.literal('answer'),
  v: z.literal(1),
  sdp: z.string(),
  targetPeerId: z.string().optional(),
});

const ClientIceCandidateSchema = z.object({
  type: z.literal('ice-candidate'),
  v: z.literal(1),
  candidate: z.unknown(),
  targetPeerId: z.string().optional(),
});

const LeaveSchema = z.object({
  type: z.literal('leave'),
  v: z.literal(1),
});

const ChatSchema = z.object({
  type: z.literal('chat'),
  v: z.literal(1),
  roomId: z.string(),
  /** Base64-encoded encrypted blob: iv || AES-GCM(json) || authTag */
  blob: z.string(),
  /** Message UUID — echoed back in chat-ack for delivery confirmation */
  uuid: z.string(),
});

const HistoryRequestSchema = z.object({
  type: z.literal('history-request'),
  v: z.literal(1),
  roomId: z.string(),
  /** Cursor: fetch messages with id < before (server-assigned message ID) */
  before: z.number().optional(),
  /** Page size override (server caps at HISTORY_BATCH_SIZE) */
  limit: z.number().int().positive().optional(),
});

const PongSchema = z.object({
  type: z.literal('pong'),
  v: z.literal(1),
});

const JoinCallSchema = z.object({
  type: z.literal('join-call'),
  v: z.literal(1),
});

const LeaveCallSchema = z.object({
  type: z.literal('leave-call'),
  v: z.literal(1),
});

const ChatReceivedSchema = z.object({
  type: z.literal('chat-received'),
  v: z.literal(1),
  /** UUID of the message being acknowledged */
  uuid: z.string(),
  /** Target peerId — who should receive this delivery ACK */
  peerId: z.string(),
});

export const ClientToServerMessageSchema = z.discriminatedUnion('type', [
  JoinSchema,
  ClientOfferSchema,
  ClientAnswerSchema,
  ClientIceCandidateSchema,
  LeaveSchema,
  ChatSchema,
  HistoryRequestSchema,
  PongSchema,
  JoinCallSchema,
  LeaveCallSchema,
  ChatReceivedSchema,
]);

export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;

// ============================================================================
// Server → Client Messages
// ============================================================================

const JoinResponseSchema = z.object({
  type: z.literal('join'),
  v: z.literal(1),
  iceServers: z.array(IceServerSchema),
  iceTransportPolicy: IceTransportPolicySchema,
});

const PeerJoinedSchema = z.object({
  type: z.literal('peer-joined'),
  v: z.literal(1),
  peerId: z.string(),
  /** Encrypted nickname blob — opaque to server */
  encryptedNickname: z.string(),
  count: z.number().int(),
});

const PeerLeftSchema = z.object({
  type: z.literal('peer-left'),
  v: z.literal(1),
  peerId: z.string(),
  count: z.number().int(),
});

const PeersListSchema = z.object({
  type: z.literal('peers-list'),
  v: z.literal(1),
  peers: z.array(z.object({ peerId: z.string(), encryptedNickname: z.string() })),
  selfPeerId: z.string(),
});

const ServerOfferSchema = z.object({
  type: z.literal('offer'),
  v: z.literal(1),
  sdp: z.string(),
  fromPeerId: z.string().optional(),
});

const ServerAnswerSchema = z.object({
  type: z.literal('answer'),
  v: z.literal(1),
  sdp: z.string(),
  fromPeerId: z.string().optional(),
});

const ServerIceCandidateSchema = z.object({
  type: z.literal('ice-candidate'),
  v: z.literal(1),
  candidate: z.unknown(),
  fromPeerId: z.string().optional(),
});

const ChatBroadcastSchema = z.object({
  type: z.literal('chat-broadcast'),
  v: z.literal(1),
  /** Base64-encoded encrypted blob */
  blob: z.string(),
  /** Server-assigned timestamp (unix ms) */
  created_at: z.number(),
});

const HistoryMessageSchema = z.object({
  /** Server-assigned message ID — used as cursor for pagination */
  id: z.number(),
  /** Base64-encoded encrypted blob */
  blob: z.string(),
  /** Server-assigned timestamp (unix ms) */
  created_at: z.number(),
});

const HistorySchema = z.object({
  type: z.literal('history'),
  v: z.literal(1),
  messages: z.array(HistoryMessageSchema),
  hasMore: z.boolean(),
});

const PingSchema = z.object({
  type: z.literal('ping'),
  v: z.literal(1),
});

const ChatAckSchema = z.object({
  type: z.literal('chat-ack'),
  v: z.literal(1),
  /** UUID of the persisted message */
  uuid: z.string(),
});

/** Delivery ACK relayed from recipient to sender */
const ChatReceivedRelaySchema = z.object({
  type: z.literal('chat-received'),
  v: z.literal(1),
  /** UUID of the delivered message */
  uuid: z.string(),
  /** peerId of the peer who received the message */
  peerId: z.string(),
});

const PeerJoinedCallSchema = z.object({
  type: z.literal('peer-joined-call'),
  v: z.literal(1),
  peerId: z.string(),
});

const PeerLeftCallSchema = z.object({
  type: z.literal('peer-left-call'),
  v: z.literal(1),
  peerId: z.string(),
});

const CallPeersSchema = z.object({
  type: z.literal('call-peers'),
  v: z.literal(1),
  callPeers: z.array(z.string()),
});

const ServerErrorSchema = z.object({
  type: z.literal('error'),
  v: z.literal(1),
  code: ErrorCodeSchema,
  message: z.string(),
});

export const ServerToClientMessageSchema = z.discriminatedUnion('type', [
  JoinResponseSchema,
  PeerJoinedSchema,
  PeerLeftSchema,
  PeersListSchema,
  ServerOfferSchema,
  ServerAnswerSchema,
  ServerIceCandidateSchema,
  ChatBroadcastSchema,
  ChatAckSchema,
  ChatReceivedRelaySchema,
  HistorySchema,
  PingSchema,
  PeerJoinedCallSchema,
  PeerLeftCallSchema,
  CallPeersSchema,
  ServerErrorSchema,
]);

export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>;

// ============================================================================
// Sub-type exports for consumers that need individual message shapes
// ============================================================================

export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;
