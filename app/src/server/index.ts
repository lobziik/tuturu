/**
 * tuturu v2 Server — Entry Point
 *
 * Wires all dependencies (DI), starts HTTP/WebSocket server, and manages lifecycle.
 *
 * @module server/index
 */

import { serve, type ServerWebSocket } from 'bun';
import type { ServerToClientMessage } from '../shared/schemas';
import {
  config,
  isTurnConfigured,
  retentionMs,
  pingIntervalMs,
  pongTimeoutMs,
  cleanupIntervalMs,
} from './config';
import { loadAssets } from './assets';
import { createFetchHandler } from './http';
import { createDatabase } from './database';
import { createBlobStore } from './blob';
import { createRoomManager, type ServerClientData } from './rooms';
import { createHandlers } from './handlers';
import { createWebSocketHandlers } from './ws';
import { buildIceServers } from './ice';

/**
 * Send callback for all outgoing WebSocket messages.
 * Single point for error handling — log failures, never crash the server.
 */
function send(ws: ServerWebSocket<ServerClientData>, message: ServerToClientMessage): void {
  if (message.type === 'error') {
    console.warn(`[SEND] Error to ${ws.data.peerId}: [${message.code}] ${message.message}`);
  }
  try {
    const json = JSON.stringify(message);
    const result = ws.send(json);
    if (result === -1) {
      console.warn(
        `[SEND] Failed to send ${message.type} to ${ws.data.peerId} (connection may be closed)`,
      );
    }
  } catch (error) {
    console.warn(
      `[SEND] Error sending ${message.type} to ${ws.data.peerId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Initialize and start the server.
 */
async function main(): Promise<void> {
  // Create data layer
  const db = createDatabase(config.dbPath);
  const blobStore = createBlobStore(config.blobDir);

  // Create room manager with send callback
  const rooms = createRoomManager({
    maxParticipants: config.maxParticipants,
    send,
  });

  // Create handlers with all dependencies
  const handlers = createHandlers({
    rooms,
    db,
    iceConfig: { buildIceServers, forceRelay: config.forceRelay },
    historyBatchSize: config.historyBatchSize,
    send,
    pingIntervalMs,
    pongTimeoutMs,
  });

  // Create WebSocket event handlers
  const wsHandlers = createWebSocketHandlers(handlers, send);

  // Load static assets
  const assets = await loadAssets();

  // Create HTTP request handler
  const fetch = createFetchHandler({
    assets,
    blobStore,
    blobMaxBytes: config.blobMaxBytes,
    blobRateLimitMs: 1_000,
    getRoomCount: () => rooms.getRoomCount(),
  });

  // Start server
  const server = serve<ServerClientData>({
    port: config.port,
    hostname: '0.0.0.0',
    fetch,
    websocket: {
      open: wsHandlers.open,
      message: wsHandlers.message,
      close: wsHandlers.close,
    },
  });

  // Periodic cleanup for expired messages and blobs
  const cleanupTimer = setInterval(() => {
    try {
      const deletedMsgs = db.cleanup(retentionMs);
      const deletedBlobs = blobStore.cleanup(retentionMs);
      if (deletedMsgs > 0 || deletedBlobs > 0) {
        console.log(`[CLEANUP] Deleted ${deletedMsgs} messages, ${deletedBlobs} blobs`);
      }
    } catch (error) {
      console.error(`[CLEANUP] Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, cleanupIntervalMs);

  console.log(`
╔═══════════════════════════════════════╗
║         tuturu v2 Server              ║
╚═══════════════════════════════════════╝

Server running on http://${server.hostname}:${server.port}
WebSocket endpoint: ws://${server.hostname}:${server.port}/ws
Health check: http://${server.hostname}:${server.port}/health
Environment: ${config.nodeEnv}

STUN servers: ${config.stunServers.join(', ')}
${config.externalIp ? `External IP: ${config.externalIp}` : 'No EXTERNAL_IP configured'}
${isTurnConfigured() ? 'TURN server configured (ephemeral credentials, 4h TTL)' : 'No TURN server configured (STUN only)'}
Force relay: ${config.forceRelay ? 'enabled' : 'disabled'}

Database: ${config.dbPath}
Blob storage: ${config.blobDir}
Retention: ${config.retentionDays} days
Max participants: ${config.maxParticipants}

Press Ctrl+C to stop
`);

  // Graceful shutdown
  function shutdown(): void {
    console.log('\nShutting down server...');
    clearInterval(cleanupTimer);
    db.close();
    void server.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the server
await main();
