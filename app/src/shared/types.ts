/**
 * Shared type definitions for tuturu v2.
 *
 * Wire format types are re-exported from schemas.ts (Zod = source of truth).
 * Non-wire types (local data structures) are defined here directly.
 *
 * @module shared/types
 */

// Wire format types — derived from Zod schemas, never hand-written
export type {
  ChatMessage,
  ClientToServerMessage,
  IceServerConfig,
  IceTransportPolicy,
} from './schemas';

// ============================================================================
// Non-wire types — local data structures, not part of the protocol
// ============================================================================

/** Peer presence state (client-side tracking) */
export interface PeerState {
  peerId: string;
  /** Decrypted display name — set asynchronously after join */
  nickname?: string;
  /** Raw encrypted nickname from server — cleared after successful decryption */
  encryptedNickname?: string | undefined;
}

/** IndexedDB `settings` store record shape */
export interface SettingRecord {
  /** Record key (e.g. "nickname", "deviceId") */
  key: string;
  /** Stored value */
  value: string;
}

/** IndexedDB `seq` store record shape — tracks last seen sequence per sender per room */
export interface SeqRecord {
  /** Room this seq record belongs to */
  roomId: string;
  /** Sender's device identifier */
  deviceId: string;
  /** Highest seq number received from this deviceId in this room */
  lastSeenSeq: number;
}

/** IndexedDB `blobs` store record — encrypted wire blob + plaintext metadata index */
export interface BlobRecord {
  /** Message UUID — keyPath, deduplication */
  uuid: string;
  /** Room identifier — for filtering and pagination */
  roomId: string;
  /** Unix timestamp in milliseconds — sort order */
  timestamp: number;
  /** Sender device identifier — seq chain tracking */
  deviceId: string;
  /** Monotonic sequence number — replay detection */
  seq: number;
  /** Message content type — UI hints without decryption */
  type: 'text' | 'photo';
  /** Encrypted wire format: iv(12) || ciphertext || authTag(16) */
  blob: Uint8Array;
}
