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
  ServerToClientMessage,
  HistoryMessage,
  ErrorCode,
} from './schemas';

// ============================================================================
// Non-wire types — local data structures, not part of the protocol
// ============================================================================

/** Peer presence state (client-side tracking) */
export interface PeerState {
  peerId: string;
  /** Learned from decrypted chat messages — not available immediately on join */
  nickname?: string;
}

/** IndexedDB `settings` store record shape */
export interface SettingRecord {
  /** Record key (e.g. "nickname", "deviceId") */
  key: string;
  /** Stored value */
  value: string;
}

/** IndexedDB `seq` store record shape — tracks last seen sequence per sender */
export interface SeqRecord {
  /** Sender's device identifier */
  deviceId: string;
  /** Highest seq number received from this deviceId */
  lastSeenSeq: number;
}
