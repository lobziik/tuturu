/**
 * tuturu WebRTC Signaling Server
 *
 * Entry point for the WebSocket-based signaling server.
 * Handles server lifecycle: initialization, startup, and graceful shutdown.
 */

import { serve } from 'bun';
import type { ClientData } from '../types';
import { config, isTurnConfigured } from '../config';
import { loadAssets } from './assets';
import { createFetchHandler } from './http';
import { handleOpen, handleMessage, handleClose } from './websocket';
import { initTurnRedis, isRevocationEnabled, closeTurnRedis } from './turn';

/**
 * Initialize and start the server.
 */
async function main(): Promise<void> {
  // Load static assets at startup
  const assets = await loadAssets();

  // Create HTTP request handler
  const fetch = createFetchHandler(assets);

  // Start HTTP and WebSocket server
  const server = serve<ClientData>({
    port: config.port,
    fetch,
    websocket: {
      open: handleOpen,
      message: handleMessage,
      close: handleClose,
      // Note: Bun's WebSocket error handler removed from types in recent versions
      // Errors are handled in message/close handlers
    },
  });

  // Initialize Redis for TURN credential revocation
  await initTurnRedis();

  console.log(`
╔═══════════════════════════════════════╗
║         tuturu WebRTC Server          ║
╚═══════════════════════════════════════╝

🚀 Server running on http://localhost:${config.port}
📞 WebSocket endpoint: ws://localhost:${config.port}/ws
🏥 Health check: http://localhost:${config.port}/health
🌍 Environment: ${config.nodeEnv}

📡 STUN servers: ${config.stunServers.join(', ')}
${config.externalIp ? `🌐 External IP: ${config.externalIp}` : '⚠️  No EXTERNAL_IP configured'}
${isTurnConfigured() ? `✅ TURN server configured (ephemeral credentials)` : '⚠️  No TURN server configured (STUN only)'}
${isRevocationEnabled() ? `✅ Redis connected (credential revocation enabled)` : '⚠️  Redis not available (credentials expire naturally)'}
Force relay: ${config.forceRelay ? 'enabled' : 'disabled'}

Press Ctrl+C to stop
`);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down server...');
    await closeTurnRedis();
    void server.stop();
    process.exit(0);
  });
}

// Start the server
await main();
