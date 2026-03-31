/**
 * Shared constants used by both client and server.
 * Server-side defaults; some are configurable via environment variables.
 *
 * @module shared/constants
 */

/** Server message retention period in days */
export const RETENTION_DAYS = 7;

/** Number of messages per history page (cursor-based pagination) */
export const HISTORY_BATCH_SIZE = 100;

/** Maximum blob upload size in bytes (15 MB — covers 10 MB plaintext + encryption overhead) */
export const BLOB_MAX_BYTES = 15_728_640;

/** Server-to-client ping interval in milliseconds */
export const WS_PING_INTERVAL_MS = 30_000;

/** Server closes connection if no pong received within this period */
export const WS_PONG_TIMEOUT_MS = 90_000;

/** Client considers connection dead if no ping received within this period */
export const WS_DEAD_DETECTION_MS = 60_000;

/** Maximum participants per room (video mesh limit) */
export const MAX_ROOM_PARTICIPANTS = 6;

/** IndexedDB database name */
export const DB_NAME = 'tuturu';

/** IndexedDB schema version — increment when adding migrations */
export const DB_VERSION = 1;
