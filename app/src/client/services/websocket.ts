/**
 * WebSocket connection management for room-level communication.
 *
 * Handles WebSocket lifecycle, Zod validation of incoming messages,
 * and routing server messages to state machine actions. Supports
 * async decrypt of chat-broadcast and history messages.
 *
 * @module client/services/websocket
 */

import type { types as msTypes } from 'mediasoup-client';
import type { ClientToServerMessage } from '../../shared/types';
import {
  ServerToClientMessageSchema,
  ChatMessageSchema,
  type ChatMessage,
} from '../../shared/schemas';
import type { Action } from '../state/types';
import { handleIncomingMessage } from './chatProtocol';
import { decryptMessage, fromBase64, encryptMessage, toBase64 } from './crypto';
import { storeBlobIfNew } from './db';

type Dispatch = (action: Action) => void;

/** Room context needed for WS setup (join message + message processing) */
export interface WsRoomContext {
  roomId: string;
  nickname: string;
  aesKey: CryptoKey;
}

/** Refs needed by the WS message handler for async operations */
interface WsRefs {
  aesKey: { current: CryptoKey | null };
  db: { current: IDBDatabase | null };
}

/** Create WebSocket connection to signaling server */
export function createWebSocket(): WebSocket {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${globalThis.location.host}/ws`;
  console.log('[WS] Creating connection to', wsUrl);
  return new WebSocket(wsUrl);
}

/**
 * Set up WebSocket event handlers for room-level communication.
 *
 * On open: dispatches WS_ROOM_CONNECTED, encrypts nickname, sends join message.
 * On message: Zod-validates incoming, routes to appropriate actions.
 * On close/error: dispatches WS_CLOSED/WS_ERROR for reconnect handling.
 */
export function setupWebSocketHandlers(
  dispatch: Dispatch,
  ws: WebSocket,
  refs: WsRefs,
  roomContext: WsRoomContext,
): void {
  ws.onopen = () => {
    console.log('[WS] Connected');
    dispatch({ type: 'WS_ROOM_CONNECTED' });

    // Encrypt nickname and send join message (async — WS is already OPEN)
    void (async () => {
      const encrypted = await encryptMessage(
        roomContext.aesKey,
        new TextEncoder().encode(roomContext.nickname),
      );
      sendMessage(ws, {
        type: 'join',
        v: 1,
        roomId: roomContext.roomId,
        encryptedNickname: toBase64(encrypted),
      });
    })();
  };

  ws.onerror = (error) => {
    console.error('[WS] Connection error:', error);
    dispatch({
      type: 'WS_ERROR',
      error: 'WebSocket connection failed. Check server is running.',
    });
  };

  ws.onclose = (event: CloseEvent) => {
    console.log('[WS] Connection closed:', event.code, event.reason);
    const intentional =
      event.code === 1000 &&
      (event.reason === 'Leaving room' || event.reason === 'Nickname change');
    dispatch({
      type: 'WS_CLOSED',
      code: event.code,
      reason: event.reason,
      intentional,
    });
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      console.warn('[WS] Received invalid JSON, ignoring');
      return;
    }

    const result = ServerToClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[WS] Message failed Zod validation:', result.error.issues);
      return;
    }

    handleServerMessage(result.data, dispatch, refs, roomContext.roomId);
  };
}

/** Send typed v2 message to server via WebSocket */
export function sendMessage(ws: WebSocket | null, message: ClientToServerMessage): void {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.error(`[WS] Cannot send '${message.type}': WebSocket not connected`);
    return;
  }
  console.log('[WS] Sending:', message.type);
  ws.send(JSON.stringify(message));
}

/**
 * Detach all event handlers from a WebSocket.
 *
 * Call this before closing a WS that's being replaced to prevent the stale
 * `onclose` from dispatching `WS_CLOSED` and overwriting the new WS state.
 */
export function detachWebSocketHandlers(ws: WebSocket): void {
  ws.onopen = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
}

/** Close WebSocket with proper close code */
export function closeWebSocket(ws: WebSocket, reason = 'Leaving room'): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000, reason);
  }
}

// ============================================================================
// Internal message routing
// ============================================================================

type ServerToClientMessage = ReturnType<typeof ServerToClientMessageSchema.parse>;

/** Route incoming server messages to state machine actions */
function handleServerMessage(
  message: ServerToClientMessage,
  dispatch: Dispatch,
  refs: WsRefs,
  roomId: string,
): void {
  switch (message.type) {
    case 'join':
      dispatch({
        type: 'JOINED_ROOM',
        iceServers: message.iceServers,
        iceTransportPolicy: message.iceTransportPolicy,
        ...(message.sfuEnabled === undefined ? {} : { sfuEnabled: message.sfuEnabled }),
        ...(message.e2eeMediaEnabled === undefined
          ? {}
          : { e2eeMediaEnabled: message.e2eeMediaEnabled }),
      });
      break;

    case 'peers-list':
      dispatch({
        type: 'PEERS_LIST',
        peers: message.peers,
        selfPeerId: message.selfPeerId,
      });
      break;

    case 'peer-joined':
      dispatch({
        type: 'PEER_JOINED_ROOM',
        peerId: message.peerId,
        encryptedNickname: message.encryptedNickname,
        count: message.count,
      });
      break;

    case 'peer-left':
      dispatch({
        type: 'PEER_LEFT_ROOM',
        peerId: message.peerId,
        count: message.count,
      });
      break;

    case 'ping':
      dispatch({ type: 'PING_RECEIVED' });
      break;

    case 'chat-broadcast':
      handleChatBroadcast(message.blob, dispatch, refs, roomId);
      break;

    case 'history':
      handleHistory(message, dispatch, refs, roomId);
      break;

    case 'chat-ack':
      dispatch({ type: 'CHAT_ACK', uuid: message.uuid });
      break;

    case 'offer':
      dispatch({
        type: 'RECEIVED_OFFER',
        offer: { type: 'offer', sdp: message.sdp },
        fromPeerId: message.peerId,
      });
      break;

    case 'answer':
      dispatch({
        type: 'RECEIVED_ANSWER',
        answer: { type: 'answer', sdp: message.sdp },
        fromPeerId: message.peerId,
      });
      break;

    case 'ice-candidate':
      dispatch({
        type: 'RECEIVED_ICE_CANDIDATE',
        candidate: message.candidate as RTCIceCandidateInit,
        fromPeerId: message.peerId,
      });
      break;

    case 'error':
      dispatch({ type: 'SERVER_ERROR', error: message.message });
      break;

    case 'call-peers':
      dispatch({ type: 'CALL_PEERS_RECEIVED', callPeers: message.callPeers });
      break;

    // Stubs for call-level messages not yet wired
    case 'chat-received':
      console.log('[WS] Received (stub):', message.type);
      break;

    // SFU messages — cast from z.unknown() to mediasoup types (mediasoup validates internally)
    case 'sfu-router-caps':
      dispatch({
        type: 'SFU_ROUTER_CAPS_RECEIVED',
        rtpCapabilities: message.rtpCapabilities as msTypes.RtpCapabilities,
      });
      break;

    case 'sfu-transport-created':
      dispatch({
        type: 'SFU_TRANSPORT_CREATED',
        direction: message.direction,
        id: message.id,
        iceParameters: message.iceParameters as msTypes.IceParameters,
        iceCandidates: message.iceCandidates as msTypes.IceCandidate[],
        dtlsParameters: message.dtlsParameters as msTypes.DtlsParameters,
        ...(message.sctpParameters
          ? { sctpParameters: message.sctpParameters as msTypes.SctpParameters }
          : {}),
      });
      break;

    case 'sfu-producer-created':
      dispatch({
        type: 'SFU_PRODUCER_CREATED',
        id: message.id,
        kind: message.kind,
      });
      break;

    case 'sfu-new-consumer':
      dispatch({
        type: 'SFU_NEW_CONSUMER',
        peerId: message.peerId,
        producerId: message.producerId,
        consumerId: message.consumerId,
        kind: message.kind,
        rtpParameters: message.rtpParameters as msTypes.RtpParameters,
        producerPaused: message.producerPaused,
      });
      break;

    case 'sfu-active-speaker':
      dispatch({
        type: 'SFU_ACTIVE_SPEAKER',
        peerId: message.peerId,
      });
      break;
  }
}

/** Decrypt and process a live chat-broadcast message */
function handleChatBroadcast(blob: string, dispatch: Dispatch, refs: WsRefs, roomId: string): void {
  const aesKey = refs.aesKey.current;
  const db = refs.db.current;
  if (!aesKey || !db) {
    console.warn('[WS] chat-broadcast received but aesKey or db not ready');
    return;
  }

  void (async () => {
    const result = await handleIncomingMessage(blob, aesKey, db, roomId);
    if (result.type === 'ok') {
      dispatch({ type: 'CHAT_RECEIVED', message: result.message });
    } else {
      console.warn('[WS] chat-broadcast processing result:', result.type);
    }
  })();
}

/**
 * Decrypt history batch, persist to IDB, and dispatch HISTORY_LOADED.
 *
 * Uses decryptAndValidate (no seq check) to avoid false replay
 * rejection of old-but-valid messages. Persists wire blobs via storeBlobIfNew
 * so they are available from IDB cache on next cold start.
 */
function handleHistory(
  message: { messages: Array<{ id: number; blob: string; created_at: number }>; hasMore: boolean },
  dispatch: Dispatch,
  refs: WsRefs,
  roomId: string,
): void {
  const aesKey = refs.aesKey.current;
  if (!aesKey) {
    console.warn('[WS] history received but aesKey not ready');
    return;
  }

  void (async () => {
    const results = await Promise.all(
      message.messages.map(async (hm) => {
        let wire: Uint8Array;
        try {
          wire = fromBase64(hm.blob);
        } catch {
          return { result: null, id: hm.id, wire: null };
        }
        const result = await decryptAndValidateBlob(wire, aesKey);
        return { result, id: hm.id, wire };
      }),
    );

    const db = refs.db.current;
    const decrypted: ChatMessage[] = [];
    let minId: number | null = null;
    for (const { result, id, wire } of results) {
      if (result) {
        decrypted.push(result);
        // Persist to IDB (fire-and-forget — don't block dispatch).
        // If the tab closes before this completes, some blobs may not be cached.
        // This is acceptable: next history fetch (delta) will re-deliver them.
        if (db && wire) {
          storeBlobIfNew(db, roomId, result, wire).catch((err) => {
            console.warn('[WS] Failed to persist history blob:', err);
          });
        }
      }
      if (minId === null || id < minId) minId = id;
    }

    dispatch({
      type: 'HISTORY_LOADED',
      messages: decrypted,
      cursor: minId,
      hasMore: message.hasMore,
    });
  })();
}

/**
 * Decrypt and validate wire bytes without IDB interaction.
 * Steps: AES-GCM decrypt → JSON parse → version check → Zod validate.
 * Used for history messages where replay/dedup checks are not appropriate.
 *
 * @param wire - Raw encrypted bytes (caller handles base64 decoding)
 * @param aesKey - AES-GCM decryption key
 */
async function decryptAndValidateBlob(
  wire: Uint8Array,
  aesKey: CryptoKey,
): Promise<ChatMessage | null> {
  try {
    const plainBytes = await decryptMessage(aesKey, wire);
    const json: unknown = JSON.parse(new TextDecoder().decode(plainBytes));

    // Version check
    if (typeof json === 'object' && json !== null && 'v' in json) {
      const v = (json as Record<string, unknown>)['v'];
      if (typeof v === 'number' && v !== 1) {
        console.warn('[WS] History message with unknown version:', v);
        return null;
      }
    }

    const parsed = ChatMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('[WS] History message failed validation:', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn('[WS] History message decrypt/parse failed:', err);
    return null;
  }
}
