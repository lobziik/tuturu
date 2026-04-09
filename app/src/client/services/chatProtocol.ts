/**
 * Chat protocol handler: decrypt, validate, dedup, and store incoming messages.
 *
 * Pipeline (order matters):
 * 1. Base64 decode → 2. AES-GCM decrypt → 3. JSON parse → 4. Version check →
 * 5. Zod validate → 6. Replay detect → 7. UUID dedup → 8. Store
 *
 * Returns a typed result union — never throws for expected failures.
 *
 * @module client/services/chatProtocol
 */

import { ChatMessageSchema } from '../../shared/schemas';
import type { ChatMessage, BlobRecord } from '../../shared/types';
import { decryptMessage, fromBase64 } from './crypto';
import { checkAndStoreBlob } from './db';

// ============================================================================
// Result Types
// ============================================================================

/** Successful message processing — message stored in IndexedDB */
interface HandleResultOk {
  type: 'ok';
  /** Validated and stored ChatMessage */
  message: ChatMessage;
}

/** Message seq ≤ lastSeenSeq for this deviceId (replay attack or re-delivery) */
interface HandleResultReplay {
  type: 'replay';
}

/** Message UUID already exists in IndexedDB (duplicate delivery) */
interface HandleResultDuplicate {
  type: 'duplicate';
}

/** AES-GCM decryption failed (wrong room key, tampered, or corrupted data) */
interface HandleResultDecryptError {
  type: 'decrypt-error';
}

/** Message has unknown wire format version — ignore gracefully */
interface HandleResultUnknownVersion {
  type: 'unknown-version';
  /** The version number found in the message */
  v: number;
}

/** JSON parse or Zod schema validation failed */
interface HandleResultParseError {
  type: 'parse-error';
}

/** All possible outcomes of processing an incoming encrypted blob */
type HandleResult =
  | HandleResultOk
  | HandleResultReplay
  | HandleResultDuplicate
  | HandleResultDecryptError
  | HandleResultUnknownVersion
  | HandleResultParseError;

// ============================================================================
// Handler
// ============================================================================

/**
 * Process an incoming encrypted chat message blob.
 *
 * @param blob - Base64-encoded encrypted wire format (iv || ciphertext || authTag)
 * @param aesKey - AES-256-GCM CryptoKey from deriveKeys()
 * @param db - Open IDBDatabase connection
 * @param roomId - Room this message belongs to (for scoped seq tracking and storage)
 * @returns Discriminated union result — never throws for expected failures
 */
export async function handleIncomingMessage(
  blob: string,
  aesKey: CryptoKey,
  db: IDBDatabase,
  roomId: string,
): Promise<HandleResult> {
  // Step 1: Base64 decode
  let wire: Uint8Array;
  try {
    wire = fromBase64(blob);
  } catch {
    return { type: 'decrypt-error' };
  }

  // Step 2: AES-GCM decrypt
  let plainBytes: Uint8Array;
  try {
    plainBytes = await decryptMessage(aesKey, wire);
  } catch {
    return { type: 'decrypt-error' };
  }

  // Step 3: JSON parse
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plainBytes));
  } catch {
    return { type: 'parse-error' };
  }

  // Step 4: Version check (before full schema validation)
  if (typeof json === 'object' && json !== null && 'v' in json) {
    const v = (json as Record<string, unknown>)['v'];
    if (typeof v === 'number' && v !== 1) {
      return { type: 'unknown-version', v };
    }
  }

  // Step 5: Zod schema validation
  const parsed = ChatMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { type: 'parse-error' };
  }
  const message = parsed.data;

  // Steps 6-8: Replay check + dedup check + store encrypted blob in a single IDB transaction.
  // Eliminates TOCTOU races when multiple messages are processed concurrently.
  // Stores the original wire blob (still encrypted) — not the decrypted plaintext.
  const storeResult = await checkAndStoreBlob(db, roomId, message, wire);
  if (!storeResult.stored) {
    return { type: storeResult.reason };
  }

  return { type: 'ok', message };
}

// ============================================================================
// Blob Record Decryption
// ============================================================================

/**
 * Decrypt a BlobRecord back to a ChatMessage.
 * Used for bulk decryption of cached blobs on room entry.
 *
 * No seq/dedup checks — data already passed validation when originally stored.
 * Returns null on any failure (decrypt, parse, validate) — never throws.
 */
export async function decryptBlobRecord(
  aesKey: CryptoKey,
  record: BlobRecord,
): Promise<ChatMessage | null> {
  try {
    const plainBytes = await decryptMessage(aesKey, record.blob);
    const json: unknown = JSON.parse(new TextDecoder().decode(plainBytes));
    const parsed = ChatMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('[CHAT_PROTO] Stored blob failed schema validation:', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn('[CHAT_PROTO] Failed to decrypt stored blob:', err);
    return null;
  }
}
