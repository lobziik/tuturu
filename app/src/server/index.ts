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
import { resolveWorkerBin } from './worker-bin';
import { smokeTestWorker } from './worker-smoke-test';
import { createWorkerManager, createSfuRoomManager, createSfuPeerHandler } from './sfu';

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

  // Resolve SFU announced IP early — used in both SFU init and startup banner.
  // In dev mode, default to 127.0.0.1 so browsers can reach the mediasoup
  // WebRtcTransport (0.0.0.0 is not routable from the browser).
  const sfuAnnouncedIp =
    config.sfuAnnouncedIp ??
    config.externalIp ??
    (config.nodeEnv === 'development' ? '127.0.0.1' : undefined);

  // SFU subsystem — only initialize when enabled
  let workerManager: Awaited<ReturnType<typeof createWorkerManager>> | null = null;
  let sfuPeerHandler: ReturnType<typeof createSfuPeerHandler> | null = null;

  if (config.sfuEnabled) {
    // Fail fast in production — without announcedIp, mediasoup ICE candidates
    // advertise 0.0.0.0 which browsers can't connect to. SFU calls silently fail.
    if (!sfuAnnouncedIp && config.nodeEnv === 'production') {
      throw new Error(
        '[SFU] No announcedIp configured for production. ' +
          'Set EXTERNAL_IP or TUTURU_SFU_ANNOUNCED_IP environment variable. ' +
          'Without it, SFU ICE candidates will advertise 0.0.0.0 and calls will silently fail.',
      );
    }

    // Resolve and verify mediasoup worker binary before anything else.
    const worker = await resolveWorkerBin();

    // Smoke test only on first extraction (binary changed) or when explicitly requested.
    // Skipped on regular restarts — the binary doesn't change between them.
    if (worker.extracted || process.env.TUTURU_SMOKE_TEST === '1') {
      await smokeTestWorker(worker.path);
    }

    // Create SFU worker pool
    workerManager = await createWorkerManager(worker.path, config.sfuNumWorkers);

    // Create SFU room manager and peer handler
    const sfuRoomManager = createSfuRoomManager({
      workerManager,
      broadcast: (roomId, message, excludePeerId) =>
        rooms.broadcast(roomId, message, excludePeerId),
      listenIp: config.sfuListenIp,
      announcedIp: sfuAnnouncedIp,
    });

    sfuPeerHandler = createSfuPeerHandler({
      sfuRoomManager,
      send,
      routeToPeer: (roomId, targetPeerId, message) =>
        rooms.routeToPeer(roomId, targetPeerId, message),
      listenIp: config.sfuListenIp,
      announcedIp: sfuAnnouncedIp,
    });
  } else {
    console.log('[SFU] Disabled — all calls will use mesh (peer-to-peer) topology');
  }

  // Create handlers with all dependencies
  const handlers = createHandlers({
    rooms,
    db,
    iceConfig: { buildIceServers, forceRelay: config.forceRelay },
    historyBatchSize: config.historyBatchSize,
    send,
    pingIntervalMs,
    pongTimeoutMs,
    ...(sfuPeerHandler ? { sfuPeerHandler } : {}),
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
    blobUploadToken: config.blobUploadToken,
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

SFU: ${workerManager ? `${workerManager.workerCount} mediasoup worker(s)` : 'disabled (mesh mode)'}
${workerManager ? `SFU listen: ${config.sfuListenIp}${sfuAnnouncedIp ? ` (announced: ${sfuAnnouncedIp})` : ''}` : ''}

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
    workerManager?.close();
    db.close();
    void server.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the server
await main();
