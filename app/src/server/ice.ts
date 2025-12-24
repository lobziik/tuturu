/**
 * ICE server configuration builder
 *
 * Builds WebRTC ICE server configuration with STUN and TURN servers.
 * TURN servers are configured with ephemeral credentials and ordered by DPI bypass likelihood.
 */

import type { IceServerConfig } from '../types';
import { config, isTurnConfigured } from './config';
import { generateTurnCredentials } from './turn';

/**
 * Build ICE server configuration for WebRTC.
 *
 * Includes STUN servers and TURN servers with ephemeral credentials if configured.
 * TURN servers are ordered by likelihood of bypassing DPI:
 * 1. TURNS on 443 (looks like HTTPS)
 * 2. TURNS on 5349 (standard TLS port)
 * 3. TURN TCP on 3478 (unencrypted but standard)
 * 4. TURN UDP on 3478 (often blocked)
 *
 * @param clientId - Client ID for credential generation
 * @returns Array of ICE server configurations
 */
export function buildIceServers(clientId: string): IceServerConfig[] {
  // STUN servers from config (validated and parsed)
  const iceServers: IceServerConfig[] = config.stunServers.map((url) => ({
    urls: url,
  }));

  // Add TURN servers if configured (DPI-resistant priority order)
  if (isTurnConfigured()) {
    const domain = `t.${config.domain}`;

    // Generate ephemeral credentials for this client
    const { username, credential } = generateTurnCredentials(clientId);

    console.log(`[ICE] Generated ephemeral credentials for ${clientId}, TTL: 4h`);

    // Priority 1: TURNS on 443 (most likely to bypass DPI)
    // Routes through nginx SNI router to coturn:5349
    iceServers.push({
      urls: `turns:${domain}:443?transport=tcp`,
      username,
      credential,
    });

    // Priority 2: TURNS on standard TLS port 5349
    // Direct connection to coturn (fallback if nginx routing fails)
    iceServers.push({
      urls: `turns:${domain}:5349?transport=tcp`,
      username,
      credential,
    });

    // Priority 3: TURN TCP on 3478 (unencrypted but standard port)
    iceServers.push({
      urls: `turn:${domain}:3478?transport=tcp`,
      username,
      credential,
    });

    // Priority 4: TURN UDP on 3478 (likely blocked in restrictive networks)
    iceServers.push({
      urls: `turn:${domain}:3478?transport=udp`,
      username,
      credential,
    });

    console.log(`[ICE] Configured TURN server: ${domain} (4 transports)`);
  }

  return iceServers;
}
