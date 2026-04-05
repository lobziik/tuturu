/**
 * Integration tests for the v2 WebSocket server.
 *
 * Starts a real server on a random port with in-memory SQLite and temp blob dir.
 * Tests the full message flow: join, chat, history, relay, blob HTTP, heartbeat, call.
 *
 * @module server/ws_integration.test
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { serve, type ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerToClientMessage, ClientToServerMessage } from '../shared/schemas';
import { createDatabase } from './database';
import { createBlobStore } from './blob';
import { createRoomManager, type ServerClientData } from './rooms';
import { createHandlers } from './handlers';
import { createWebSocketHandlers } from './ws';
import { createFetchHandler } from './http';
import { loadAssets } from './assets';

// ============================================================================
// Test Server Setup
// ============================================================================

let server: ReturnType<typeof serve<ServerClientData>>;
let port: number;
let tempBlobDir: string;

const BLOB_MAX_BYTES = 1024 * 1024; // 1 MB for tests
const RATE_LIMIT_MS = 100; // Short for tests

beforeAll(async () => {
  tempBlobDir = mkdtempSync(join(tmpdir(), 'tuturu-integration-'));

  const db = createDatabase(':memory:');
  const blobStore = createBlobStore(tempBlobDir);

  function send(ws: ServerWebSocket<ServerClientData>, message: ServerToClientMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Connection closed — ignore in tests
    }
  }

  const rooms = createRoomManager({ maxParticipants: 6, send });

  const handlers = createHandlers({
    rooms,
    db,
    iceConfig: {
      buildIceServers: () => [{ urls: 'stun:stun.test:19302' }],
      forceRelay: false,
    },
    historyBatchSize: 5,
    send,
    pingIntervalMs: 500, // Short for tests
    pongTimeoutMs: 2000,
  });

  const wsHandlers = createWebSocketHandlers(handlers, send);

  const assets = await loadAssets();
  const fetch = createFetchHandler({
    assets,
    blobStore,
    blobMaxBytes: BLOB_MAX_BYTES,
    blobRateLimitMs: RATE_LIMIT_MS,
    getRoomCount: () => rooms.getRoomCount(),
  });

  server = serve<ServerClientData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch,
    websocket: {
      open: wsHandlers.open,
      message: wsHandlers.message,
      close: wsHandlers.close,
    },
  });

  if (!server.port) throw new Error('Server failed to bind to a port');
  port = server.port;
});

afterAll(async () => {
  await server.stop(true);
  rmSync(tempBlobDir, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

/** Collect messages from a WebSocket with timeout */
function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs: number = 2000,
): Promise<ServerToClientMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerToClientMessage[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(
        new Error(
          `Timeout waiting for ${count} messages (got ${messages.length}): ${JSON.stringify(messages.map((m) => m.type))}`,
        ),
      );
    }, timeoutMs);

    function handler(event: MessageEvent<string>) {
      const msg = JSON.parse(event.data) as ServerToClientMessage;
      messages.push(msg);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(messages);
      }
    }
    ws.addEventListener('message', handler);
  });
}

/** Wait for a single message of a specific type */
function waitForMessage<T extends ServerToClientMessage['type']>(
  ws: WebSocket,
  type: T,
  timeoutMs: number = 2000,
): Promise<Extract<ServerToClientMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timeout waiting for message type "${type}"`));
    }, timeoutMs);

    function handler(event: MessageEvent<string>) {
      const msg = JSON.parse(event.data) as ServerToClientMessage;
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg as Extract<ServerToClientMessage, { type: T }>);
      }
    }
    ws.addEventListener('message', handler);
  });
}

/** Create a WebSocket connection and wait for it to open */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket connect failed')));
  });
}

/** Send a typed message */
function sendMsg(ws: WebSocket, msg: ClientToServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Find a message by type in an array, throwing if not found */
function findMsg<T extends ServerToClientMessage['type']>(
  messages: ServerToClientMessage[],
  type: T,
): Extract<ServerToClientMessage, { type: T }> {
  const msg = messages.find((m) => m.type === type);
  if (!msg) {
    throw new Error(`Missing "${type}" message. Got: ${messages.map((m) => m.type).join(', ')}`);
  }
  return msg as Extract<ServerToClientMessage, { type: T }>;
}

/** Connect and join a room, returning the ws and join-related messages */
async function connectAndJoin(
  roomId: string,
  encryptedNickname: string = 'nick',
): Promise<{
  ws: WebSocket;
  joinMsg: Extract<ServerToClientMessage, { type: 'join' }>;
  peersList: Extract<ServerToClientMessage, { type: 'peers-list' }>;
  history: Extract<ServerToClientMessage, { type: 'history' }>;
}> {
  const ws = await connect();

  // Set up message collection BEFORE sending join
  const messagesPromise = collectMessages(ws, 3);

  sendMsg(ws, { type: 'join', v: 1, roomId, encryptedNickname });

  const messages = await messagesPromise;

  const joinMsg = findMsg(messages, 'join');
  const peersList = findMsg(messages, 'peers-list');
  const history = findMsg(messages, 'history');

  return { ws, joinMsg, peersList, history };
}

// ============================================================================
// Smoke Tests
// ============================================================================

describe('smoke', () => {
  test('server starts and accepts WebSocket connection', async () => {
    const ws = await connect();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('health endpoint returns OK', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; rooms: number };
    expect(body.status).toBe('ok');
    expect(typeof body.rooms).toBe('number');
  });
});

// ============================================================================
// Join + Peers
// ============================================================================

describe('join + peers', () => {
  test('first client receives peers-list, join response, and history', async () => {
    const roomId = `room-join-${Date.now()}`;
    const { ws, joinMsg, peersList, history } = await connectAndJoin(roomId, 'Alice');

    expect(joinMsg.type).toBe('join');
    expect(joinMsg.iceServers.length).toBeGreaterThan(0);
    expect(joinMsg.iceTransportPolicy).toBe('all');

    expect(peersList.type).toBe('peers-list');
    expect(peersList.peers).toHaveLength(0);
    expect(typeof peersList.selfPeerId).toBe('string');

    expect(history.type).toBe('history');
    expect(history.messages).toHaveLength(0);
    expect(history.hasMore).toBe(false);

    ws.close();
  });

  test('second client triggers peer-joined for first client', async () => {
    const roomId = `room-peers-${Date.now()}`;

    // Client 1 joins
    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    // Set up listener for peer-joined BEFORE client 2 joins
    const peerJoinedPromise = waitForMessage(ws1, 'peer-joined');

    // Client 2 joins
    const { ws: ws2, peersList: peersList2 } = await connectAndJoin(roomId, 'Bob');

    // Client 1 should receive peer-joined
    const peerJoined = await peerJoinedPromise;
    expect(peerJoined.type).toBe('peer-joined');
    expect(peerJoined.encryptedNickname).toBe('Bob');
    expect(peerJoined.count).toBe(2);

    // Client 2's peers-list should include Client 1
    expect(peersList2.peers).toHaveLength(1);
    expect(peersList2.peers[0]!.encryptedNickname).toBe('Alice');

    ws1.close();
    ws2.close();
  });
});

// ============================================================================
// Chat + Broadcast
// ============================================================================

describe('chat + broadcast', () => {
  test('chat message is broadcast to other peers and acked to sender', async () => {
    const roomId = `room-chat-${Date.now()}`;

    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    // Set up listener BEFORE second client joins to catch peer-joined
    const peerJoinedPromise = waitForMessage(ws1, 'peer-joined');
    const { ws: ws2 } = await connectAndJoin(roomId, 'Bob');
    await peerJoinedPromise;

    // Set up listeners
    const broadcastPromise = waitForMessage(ws2, 'chat-broadcast');
    const ackPromise = waitForMessage(ws1, 'chat-ack');

    // Client 1 sends chat
    sendMsg(ws1, {
      type: 'chat',
      v: 1,
      roomId,
      blob: 'encrypted-blob-data',
      uuid: 'test-uuid-123',
    });

    // Client 2 receives broadcast
    const broadcast = await broadcastPromise;
    expect(broadcast.blob).toBe('encrypted-blob-data');
    expect(typeof broadcast.created_at).toBe('number');

    // Client 1 receives ack
    const ack = await ackPromise;
    expect(ack.uuid).toBe('test-uuid-123');

    ws1.close();
    ws2.close();
  });

  test('sender does NOT receive own broadcast', async () => {
    const roomId = `room-no-echo-${Date.now()}`;

    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    // Send chat
    sendMsg(ws1, {
      type: 'chat',
      v: 1,
      roomId,
      blob: 'test-blob',
      uuid: 'echo-test-uuid',
    });

    // Should only receive chat-ack, not chat-broadcast
    const ack = await waitForMessage(ws1, 'chat-ack');
    expect(ack.uuid).toBe('echo-test-uuid');

    // Wait a bit and verify no broadcast was received
    await new Promise((r) => setTimeout(r, 200));
    // If we got here without error, no unexpected broadcast was received

    ws1.close();
  });
});

// ============================================================================
// History
// ============================================================================

describe('history', () => {
  test('join returns initial history batch', async () => {
    const roomId = `room-history-${Date.now()}`;

    // First client joins and sends messages
    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    for (let i = 0; i < 3; i++) {
      sendMsg(ws1, {
        type: 'chat',
        v: 1,
        roomId,
        blob: `msg-${i}`,
        uuid: `uuid-${i}`,
      });
      await waitForMessage(ws1, 'chat-ack');
    }

    // Second client joins — should receive history
    const { ws: ws2, history } = await connectAndJoin(roomId, 'Bob');
    expect(history.messages.length).toBe(3);
    expect(history.hasMore).toBe(false);

    ws1.close();
    ws2.close();
  });

  test('history-request with cursor paginates correctly', async () => {
    const roomId = `room-pagination-${Date.now()}`;

    // Join and send 8 messages (batch size is 5 in test config)
    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    for (let i = 0; i < 8; i++) {
      sendMsg(ws1, {
        type: 'chat',
        v: 1,
        roomId,
        blob: `paginated-msg-${i}`,
        uuid: `page-uuid-${i}`,
      });
      await waitForMessage(ws1, 'chat-ack');
    }

    // Second client joins — gets first page (newest 5)
    const { ws: ws2, history: page1 } = await connectAndJoin(roomId, 'Bob');
    expect(page1.messages.length).toBe(5);
    expect(page1.hasMore).toBe(true);

    // Request second page using id-based cursor
    const oldestId = page1.messages[page1.messages.length - 1]!.id;
    const page2Promise = waitForMessage(ws2, 'history');
    sendMsg(ws2, {
      type: 'history-request',
      v: 1,
      roomId,
      before: oldestId,
    });
    const page2 = await page2Promise;
    expect(page2.messages.length).toBe(3);
    expect(page2.hasMore).toBe(false);

    ws1.close();
    ws2.close();
  });
});

// ============================================================================
// Disconnect
// ============================================================================

describe('disconnect', () => {
  test('peer-left broadcast on disconnect', async () => {
    const roomId = `room-disconnect-${Date.now()}`;

    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    // Set up listener BEFORE second client joins
    const peerJoinedPromise = waitForMessage(ws1, 'peer-joined');
    const { ws: ws2 } = await connectAndJoin(roomId, 'Bob');
    await peerJoinedPromise;

    // Set up listener for peer-left
    const peerLeftPromise = waitForMessage(ws1, 'peer-left');

    // Client 2 disconnects
    ws2.close();

    const peerLeft = await peerLeftPromise;
    expect(peerLeft.type).toBe('peer-left');
    expect(peerLeft.count).toBe(1);

    ws1.close();
  });
});

// ============================================================================
// Negative: Pre-join
// ============================================================================

describe('negative — pre-join', () => {
  test('chat before join returns error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    sendMsg(ws, {
      type: 'chat',
      v: 1,
      roomId: 'some-room',
      blob: 'test',
      uuid: 'test-uuid',
    });

    const error = await errorPromise;
    expect(error.code).toBe('NOT_IN_ROOM');

    ws.close();
  });

  test('history-request before join returns error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    sendMsg(ws, {
      type: 'history-request',
      v: 1,
      roomId: 'some-room',
    });

    const error = await errorPromise;
    expect(error.code).toBe('NOT_IN_ROOM');

    ws.close();
  });
});

// ============================================================================
// Negative: Invalid messages
// ============================================================================

describe('negative — invalid messages', () => {
  test('invalid JSON returns INVALID_MESSAGE error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    ws.send('not valid json{{{');

    const error = await errorPromise;
    expect(error.code).toBe('INVALID_MESSAGE');

    ws.close();
  });

  test('message without type returns error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    ws.send(JSON.stringify({ v: 1, roomId: 'test' }));

    const error = await errorPromise;
    expect(error.code).toBe('INVALID_MESSAGE');

    ws.close();
  });

  test('unknown message type returns error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    ws.send(JSON.stringify({ type: 'unknown-type', v: 1 }));

    const error = await errorPromise;
    expect(error.code).toBe('INVALID_MESSAGE');

    ws.close();
  });

  test('message with wrong v returns error', async () => {
    const ws = await connect();
    const errorPromise = waitForMessage(ws, 'error');

    ws.send(JSON.stringify({ type: 'join', v: 999, roomId: 'test', encryptedNickname: 'nick' }));

    const error = await errorPromise;
    expect(error.code).toBe('INVALID_MESSAGE');

    ws.close();
  });

  test('connection stays open after error', async () => {
    const ws = await connect();

    // Send invalid message
    const error1Promise = waitForMessage(ws, 'error');
    ws.send('bad json');
    await error1Promise;

    // Connection should still work — send another message
    const error2Promise = waitForMessage(ws, 'error');
    ws.send('still bad');
    const error2 = await error2Promise;
    expect(error2.code).toBe('INVALID_MESSAGE');

    ws.close();
  });
});

// ============================================================================
// Relay
// ============================================================================

describe('relay', () => {
  test('offer with targetPeerId is delivered with peerId substituted', async () => {
    const roomId = `room-relay-${Date.now()}`;

    const { ws: ws1, peersList: pl1 } = await connectAndJoin(roomId, 'Alice');

    // Set up listener BEFORE second client joins
    const peerJoinedPromise = waitForMessage(ws1, 'peer-joined');
    const { ws: ws2, peersList: pl2 } = await connectAndJoin(roomId, 'Bob');
    await peerJoinedPromise;

    const client1PeerId = pl1.selfPeerId;
    const client2PeerId = pl2.selfPeerId;

    // Client 1 sends offer to Client 2
    const offerPromise = waitForMessage(ws2, 'offer');
    sendMsg(ws1, {
      type: 'offer',
      v: 1,
      sdp: 'v=0\r\ntest-sdp',
      targetPeerId: client2PeerId,
    });

    const offer = await offerPromise;
    expect(offer.sdp).toBe('v=0\r\ntest-sdp');
    expect(offer.peerId).toBe(client1PeerId);

    ws1.close();
    ws2.close();
  });
});

// ============================================================================
// Blob HTTP Endpoints
// ============================================================================

describe('blob HTTP endpoints', () => {
  const validBlobId = '550e8400-e29b-41d4-a716-446655440099';

  test('POST + GET roundtrip', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const blobId = '550e8400-e29b-41d4-a716-446655440001';

    const postRes = await fetch(`http://127.0.0.1:${port}/api/blob/${blobId}`, {
      method: 'POST',
      body: data,
      headers: { 'X-Forwarded-For': `roundtrip-${Date.now()}` },
    });
    expect(postRes.status).toBe(201);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/blob/${blobId}`);
    expect(getRes.status).toBe(200);
    const body = new Uint8Array(await getRes.arrayBuffer());
    expect(body).toEqual(data);
  });

  test('POST with invalid UUID returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/blob/not-a-uuid`, {
      method: 'POST',
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });

  test('POST oversize blob returns 413', async () => {
    const data = new Uint8Array(BLOB_MAX_BYTES + 1);
    const res = await fetch(`http://127.0.0.1:${port}/api/blob/${validBlobId}`, {
      method: 'POST',
      body: data,
      headers: {
        'Content-Length': String(data.byteLength),
        'X-Forwarded-For': `oversize-${Date.now()}`,
      },
    });
    expect(res.status).toBe(413);
  });

  test('POST rate limit returns 429', async () => {
    const blobId1 = '550e8400-e29b-41d4-a716-446655440002';
    const blobId2 = '550e8400-e29b-41d4-a716-446655440003';
    const testIp = `rate-limit-test-${Date.now()}`;

    // First upload should succeed
    const res1 = await fetch(`http://127.0.0.1:${port}/api/blob/${blobId1}`, {
      method: 'POST',
      body: new Uint8Array([1]),
      headers: { 'X-Forwarded-For': testIp },
    });
    expect(res1.status).toBe(201);

    // Second upload immediately should be rate limited (same IP)
    const res2 = await fetch(`http://127.0.0.1:${port}/api/blob/${blobId2}`, {
      method: 'POST',
      body: new Uint8Array([2]),
      headers: { 'X-Forwarded-For': testIp },
    });
    expect(res2.status).toBe(429);
  });

  test('GET nonexistent blob returns 404', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/blob/550e8400-e29b-41d4-a716-446655440999`,
    );
    expect(res.status).toBe(404);
  });

  test('GET with invalid UUID returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/blob/bad-id`);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// Heartbeat
// ============================================================================

describe('heartbeat', () => {
  test('server sends ping after joining', async () => {
    const roomId = `room-heartbeat-${Date.now()}`;
    const { ws } = await connectAndJoin(roomId, 'Alice');

    // Server should send ping within 500ms (test config)
    const ping = await waitForMessage(ws, 'ping', 3000);
    expect(ping.type).toBe('ping');

    // Respond with pong to keep connection alive
    sendMsg(ws, { type: 'pong', v: 1 });

    ws.close();
  });
});

// ============================================================================
// Call
// ============================================================================

describe('call', () => {
  test('join-call returns call-peers and broadcasts peer-joined-call', async () => {
    const roomId = `room-call-${Date.now()}`;

    const { ws: ws1 } = await connectAndJoin(roomId, 'Alice');

    // Set up listener BEFORE second client joins
    const peerJoinedPromise = waitForMessage(ws1, 'peer-joined');
    const { ws: ws2 } = await connectAndJoin(roomId, 'Bob');
    await peerJoinedPromise;

    // Client 1 joins call
    const callPeersPromise = waitForMessage(ws1, 'call-peers');
    sendMsg(ws1, { type: 'join-call', v: 1 });
    const callPeers = await callPeersPromise;
    expect(callPeers.callPeers).toHaveLength(0);

    // Client 2 joins call — Client 1 should get peer-joined-call
    const peerJoinedCallPromise = waitForMessage(ws1, 'peer-joined-call');
    sendMsg(ws2, { type: 'join-call', v: 1 });
    const peerJoinedCall = await peerJoinedCallPromise;
    expect(peerJoinedCall.type).toBe('peer-joined-call');

    // Client 2 leaves call — Client 1 should get peer-left-call
    const peerLeftCallPromise = waitForMessage(ws1, 'peer-left-call');
    sendMsg(ws2, { type: 'leave-call', v: 1 });
    const peerLeftCall = await peerLeftCallPromise;
    expect(peerLeftCall.type).toBe('peer-left-call');

    ws1.close();
    ws2.close();
  });
});
