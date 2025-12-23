/**
 * TURN credential management using coturn REST API format
 *
 * Generates ephemeral HMAC-based credentials and manages revocation via Redis blocklist.
 * Credentials contain embedded expiry timestamp and are validated by coturn without a DB lookup.
 * Redis blocklist enables immediate revocation when calls end.
 */

import { createClient, type RedisClientType } from 'redis';
import { config, isTurnConfigured } from '../config';

/** Credential TTL in seconds (4 hours) */
const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

/** Redis key prefix for revoked credentials */
const REDIS_KEY_PREFIX = 'turn:revoked:';

/** Redis client instance (null if unavailable) */
let redisClient: RedisClientType | null = null;

/**
 * Ephemeral TURN credentials with expiry tracking
 */
export interface TurnCredentials {
  /** Username in format "expiryTimestamp:clientId" */
  username: string;
  /** HMAC-SHA1 signature encoded as base64 */
  credential: string;
  /** Unix timestamp when credentials expire */
  expiresAt: number;
}

/**
 * Initialize Redis client for TURN credential revocation.
 * Fails silently if Redis unavailable - credentials still work, just can't be revoked.
 */
export async function initTurnRedis(): Promise<void> {
  if (!isTurnConfigured()) {
    console.log('[TURN] TURN not configured, skipping Redis initialization');
    return;
  }

  try {
    redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
    redisClient.on('error', (err) => console.error('[REDIS] Connection error:', err));
    await redisClient.connect();
    console.log('[REDIS] Connected for TURN credential revocation');
  } catch (error) {
    console.warn(
      '[REDIS] Failed to connect, credential revocation disabled:',
      error instanceof Error ? error.message : String(error),
    );
    redisClient = null;
  }
}

/**
 * Check if Redis is available for credential revocation.
 */
export function isRevocationEnabled(): boolean {
  return redisClient !== null && redisClient.isOpen;
}

/**
 * Generate ephemeral TURN credentials using coturn REST API format.
 *
 * Format follows RFC 5389 / coturn REST API:
 * - username: "expiryTimestamp:clientId"
 * - credential: base64(HMAC-SHA1(username, sharedSecret))
 *
 * @param clientId - Unique identifier for this client
 * @returns Generated credentials with expiry timestamp
 * @throws Error if TURN is not configured
 */
export function generateTurnCredentials(clientId: string): TurnCredentials {
  if (!config.turnSecret) {
    throw new Error('TURN_SECRET not configured');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAt}:${clientId}`;

  const hasher = new Bun.CryptoHasher('sha1', config.turnSecret);
  hasher.update(username);
  const credential = hasher.digest('base64');

  return { username, credential, expiresAt };
}

/**
 * Revoke TURN credentials by adding to Redis blocklist.
 *
 * Entry TTL = remaining credential lifetime, so Redis auto-cleans expired entries.
 * Silently returns if Redis unavailable.
 *
 * @param username - The credential username to revoke
 * @param expiresAt - Unix timestamp when credential expires
 */
export async function revokeTurnCredentials(username: string, expiresAt: number): Promise<void> {
  if (!redisClient || !redisClient.isOpen) return;

  const remainingTtl = expiresAt - Math.floor(Date.now() / 1000);
  if (remainingTtl <= 0) return; // Already expired, no need to blocklist

  try {
    await redisClient.set(`${REDIS_KEY_PREFIX}${username}`, '1', { EX: remainingTtl });
    console.log(`[TURN] Revoked credentials for ${username}, TTL: ${remainingTtl}s`);
  } catch (error) {
    console.error(
      '[TURN] Failed to revoke credentials:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Revoke multiple TURN credentials in batch.
 *
 * @param credentials - Array of credentials to revoke
 */
export async function revokeTurnCredentialsBatch(
  credentials: Array<{ username: string; expiresAt: number }>,
): Promise<void> {
  await Promise.all(credentials.map((c) => revokeTurnCredentials(c.username, c.expiresAt)));
}

/**
 * Get TURN credential TTL in seconds.
 */
export function getTurnCredentialTtlSeconds(): number {
  return TURN_CREDENTIAL_TTL_SECONDS;
}

/**
 * Gracefully close Redis connection.
 */
export async function closeTurnRedis(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    console.log('[REDIS] Connection closed');
  }
}
