/**
 * ICE server configuration builder
 *
 * Builds WebRTC ICE server configuration with STUN and TURN servers.
 * TURN servers are configured with ephemeral credentials and ordered by networking passing likelihood.
 */

/** ICE server configuration (matches IceServerSchema from shared/schemas) */
interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}
import { config, isTurnConfigured } from './config';
import { generateTurnCredentials } from './turn';

/**
 * Build ICE server configuration for WebRTC.
 *
 * Includes STUN servers and TURN servers with ephemeral credentials if configured.
 *
 * @param clientId - Client ID for credential generation
 * @returns Array of ICE server configurations
 */
export function buildIceServers(clientId: string): IceServerConfig[] {
  // STUN servers from config (validated and parsed)
  const iceServers: IceServerConfig[] = config.stunServers.map((url) => ({
    urls: url,
  }));

  // Add TURN servers if configured
  if (isTurnConfigured()) {
    const domain = `t.${config.domain}`;

    // Generate ephemeral credentials for this client
    const { username, credential } = generateTurnCredentials(clientId);

    console.log(`[ICE] Generated ephemeral credentials for ${clientId}, TTL: 4h`);

    // TURN transports listed in priority order:
    // 1. TURNS on 443 — routes through nginx SNI router to coturn:5349
    // 2. TURNS on standard TLS port 5349 — direct fallback if nginx routing fails
    // 3. TURN TCP on 3478 — unencrypted but standard port
    // 4. TURN UDP on 3478 — likely blocked in restrictive networks
    iceServers.push(
      { urls: `turns:${domain}:443?transport=tcp`, username, credential },
      { urls: `turns:${domain}:5349?transport=tcp`, username, credential },
      { urls: `turn:${domain}:3478?transport=tcp`, username, credential },
      { urls: `turn:${domain}:3478?transport=udp`, username, credential },
    );

    console.log(`[ICE] Configured TURN server: ${domain} (4 transports)`);
  }

  return iceServers;
}
