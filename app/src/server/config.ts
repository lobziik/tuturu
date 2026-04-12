/**
 * Type-safe server configuration with runtime validation
 * Uses Zod for fail-fast validation at startup
 */

import { z } from 'zod';

/**
 * Configuration schema with strict validation
 */
const configSchema = z.object({
  // Server configuration
  port: z.coerce
    .number()
    .min(1000, 'Port must be at least 1000')
    .max(65535, 'Port must be at most 65535')
    .default(3000),

  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // STUN servers (comma-separated list)
  stunServers: z
    .string()
    .default('stun:stun.l.google.com:19302')
    .transform((str) => str.split(',').map((s) => s.trim()))
    .pipe(z.array(z.string().min(1, 'STUN server URL cannot be empty'))),

  // TURN server configuration (optional, but turnSecret + domain required together)
  // Uses coturn REST API format with HMAC-SHA1 for ephemeral credentials
  turnSecret: z
    .string()
    .min(32, 'TURN_SECRET must be at least 32 characters for security')
    .optional(),

  // Domain for TURN server URLs and realm (used for client ICE configuration)
  domain: z
    .string()
    .regex(
      /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i,
      'Domain must be a valid domain name (e.g., example.com)',
    )
    .optional(),

  // External IP (for coturn server configuration, not sent to client)
  externalIp: z
    .string()
    .regex(
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
      'External IP must be a valid IPv4 address',
    )
    .optional(),

  // Force relay mode (for TURN server validation)
  // When true, clients will ONLY use TURN relay candidates (no direct P2P or STUN)
  forceRelay: z.coerce.boolean().default(false),

  // v2: Chat persistence and rooms
  retentionDays: z.coerce.number().int().min(1).default(7),
  historyBatchSize: z.coerce.number().int().min(1).default(100),
  blobMaxBytes: z.coerce.number().int().min(1).default(15_728_640),
  blobUploadToken: z
    .string()
    .min(16, 'BLOB_UPLOAD_TOKEN must be at least 16 characters')
    .optional(),
  blobDir: z.string().default('./blobs'),
  dbPath: z.string().default('./messages.db'),
  maxParticipants: z.coerce.number().int().min(2).max(10).default(6),

  // SFU configuration
  /** IP for mediasoup WebRtcTransport to bind on. */
  sfuListenIp: z.string().default('0.0.0.0'),
  /** External IP announced in ICE candidates (for TURN relay). Falls back to EXTERNAL_IP. */
  sfuAnnouncedIp: z.string().ipv4('SFU announced IP must be a valid IPv4 address').optional(),
  /** Number of mediasoup workers to spawn. Defaults to CPU core count (max 8). */
  sfuNumWorkers: z.coerce.number().int().min(1).max(16).optional(),
});

/**
 * Parse and validate environment variables
 * FAILS LOUD with detailed error if validation fails
 */
function loadConfig() {
  const parseResult = configSchema.safeParse({
    port: process.env.BUN_PORT,
    nodeEnv: process.env.NODE_ENV,
    stunServers: process.env.STUN_SERVERS,
    turnSecret: process.env.TURN_SECRET,
    domain: process.env.DOMAIN,
    externalIp: process.env.EXTERNAL_IP,
    forceRelay: process.env.FORCE_RELAY,
    retentionDays: process.env.RETENTION_DAYS,
    historyBatchSize: process.env.HISTORY_BATCH_SIZE,
    blobMaxBytes: process.env.BLOB_MAX_BYTES,
    blobUploadToken: process.env.BLOB_UPLOAD_TOKEN,
    blobDir: process.env.BLOB_DIR,
    dbPath: process.env.DB_PATH,
    maxParticipants: process.env.MAX_PARTICIPANTS,
    sfuListenIp: process.env.TUTURU_SFU_LISTEN_IP,
    sfuAnnouncedIp: process.env.TUTURU_SFU_ANNOUNCED_IP,
    sfuNumWorkers: process.env.TUTURU_SFU_NUM_WORKERS,
  });

  if (!parseResult.success) {
    // FAIL FAST with detailed error messages
    console.error('[CONFIG ERROR] Invalid configuration:');
    for (const issue of parseResult.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error(
      `Configuration validation failed. Fix the errors above and restart the server.`,
    );
  }

  const config = parseResult.data;

  // Validate TURN configuration: turnSecret + domain required together or all absent
  const turnFields = [config.turnSecret, config.domain];
  const definedCount = turnFields.filter((f) => f !== undefined).length;

  if (definedCount > 0 && definedCount < 2) {
    const missingFields: string[] = [];
    if (!config.turnSecret) missingFields.push('TURN_SECRET');
    if (!config.domain) missingFields.push('DOMAIN');

    throw new Error(
      `TURN server configuration incomplete. Missing: ${missingFields.join(', ')}. ` +
        `Both TURN_SECRET and DOMAIN must be provided together or both omitted.`,
    );
  }

  return config;
}

/**
 * Validated configuration object
 * Loaded at module import time - server won't start if invalid
 */
export const config = loadConfig();

/** Retention period in milliseconds (derived from retentionDays) */
export const retentionMs = config.retentionDays * 86_400_000;

/** Server→client ping interval (ms) */
export const pingIntervalMs = 30_000;

/** Close connection if no pong received within this period (ms) */
export const pongTimeoutMs = 90_000;

/** Interval between cleanup runs for expired messages and blobs (ms) */
export const cleanupIntervalMs = 3_600_000;

/**
 * Check if TURN server is configured
 * Requires: turnSecret, domain
 */
export function isTurnConfigured(): boolean {
  return !!(config.turnSecret && config.domain);
}
