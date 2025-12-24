/**
 * TURN credential generation using coturn REST API format
 *
 * Generates ephemeral HMAC-based credentials validated by coturn.
 * Credentials contain embedded expiry timestamp and are validated without a DB lookup.
 * Credentials expire naturally after TTL (4 hours) - no revocation mechanism.
 */

import { config } from './config';

/** Credential TTL in seconds (4 hours) */
const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

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
 * Get TURN credential TTL in seconds.
 */
export function getTurnCredentialTtlSeconds(): number {
  return TURN_CREDENTIAL_TTL_SECONDS;
}
