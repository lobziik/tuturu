/**
 * Shared constants used by both client and server.
 * Server-side defaults; some are configurable via environment variables.
 *
 * @module shared/constants
 */

/** Number of messages per history page (cursor-based pagination) */
export const HISTORY_BATCH_SIZE = 100;

/** Maximum blob upload size in bytes (15 MB — covers 10 MB plaintext + encryption overhead) */
export const BLOB_MAX_BYTES = 15_728_640;

/** Server-to-client ping interval in milliseconds */
export const WS_PING_INTERVAL_MS = 30_000;

/** Server closes connection if no pong received within this period */
export const WS_PONG_TIMEOUT_MS = 90_000;

/** Client considers connection dead if no ping received within this period.
 *  Must exceed WS_PONG_TIMEOUT_MS to avoid premature reconnects on jittery networks. */
export const WS_DEAD_DETECTION_MS = 100_000;

/** Maximum number of WebSocket reconnect attempts before giving up */
export const MAX_RECONNECT_ATTEMPTS = 20;

/** Maximum number of participants in a single video call (full mesh topology) */
export const MAX_CALL_PARTICIPANTS = 6;

/** IndexedDB database name */
export const DB_NAME = 'tuturu';

/** IndexedDB schema version — increment when adding migrations */
export const DB_VERSION = 4;
