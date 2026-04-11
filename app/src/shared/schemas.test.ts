/**
 * Tests for Zod wire format schemas
 *
 * @module shared/schemas.test
 */

import { describe, test, expect } from 'bun:test';
import {
  ChatMessageSchema,
  ClientToServerMessageSchema,
  ServerToClientMessageSchema,
  ErrorCodeSchema,
} from './schemas';

// ============================================================================
// ChatMessage
// ============================================================================

describe('ChatMessageSchema', () => {
  const validTextMessage = {
    v: 1,
    deviceId: 'device-123',
    seq: 0,
    uuid: 'msg-uuid-1',
    sender: 'Alice',
    timestamp: 1700000000000,
    type: 'text',
    text: 'Hello!',
  };

  const validPhotoMessage = {
    v: 1,
    deviceId: 'device-123',
    seq: 1,
    uuid: 'msg-uuid-2',
    sender: 'Bob',
    timestamp: 1700000001000,
    type: 'photo',
    blobId: '550e8400-e29b-41d4-a716-446655440000',
    size: 1234567,
  };

  test('parses valid text message', () => {
    const result = ChatMessageSchema.safeParse(validTextMessage);
    expect(result.success).toBe(true);
  });

  test('parses valid photo message', () => {
    const result = ChatMessageSchema.safeParse(validPhotoMessage);
    expect(result.success).toBe(true);
  });

  test('rejects missing v field', () => {
    const { v: _, ...noV } = validTextMessage;
    const result = ChatMessageSchema.safeParse(noV);
    expect(result.success).toBe(false);
  });

  test('rejects wrong v value', () => {
    const result = ChatMessageSchema.safeParse({ ...validTextMessage, v: 2 });
    expect(result.success).toBe(false);
  });

  test('rejects missing deviceId', () => {
    const { deviceId: _, ...noDeviceId } = validTextMessage;
    const result = ChatMessageSchema.safeParse(noDeviceId);
    expect(result.success).toBe(false);
  });

  test('rejects negative seq', () => {
    const result = ChatMessageSchema.safeParse({ ...validTextMessage, seq: -1 });
    expect(result.success).toBe(false);
  });

  test('accepts seq = 0', () => {
    const result = ChatMessageSchema.safeParse({ ...validTextMessage, seq: 0 });
    expect(result.success).toBe(true);
  });

  test('rejects invalid type', () => {
    const result = ChatMessageSchema.safeParse({ ...validTextMessage, type: 'video' });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer seq', () => {
    const result = ChatMessageSchema.safeParse({ ...validTextMessage, seq: 1.5 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ClientToServerMessage
// ============================================================================

describe('ClientToServerMessageSchema', () => {
  test('parses join message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join',
      v: 1,
      roomId: 'abc123def456',
      encryptedNickname: 'encrypted-nick-blob',
    });
    expect(result.success).toBe(true);
  });

  test('rejects join without encryptedNickname', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join',
      v: 1,
      roomId: 'abc123def456',
    });
    expect(result.success).toBe(false);
  });

  test('parses offer message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'offer',
      v: 1,
      sdp: 'v=0\r\no=...',
      targetPeerId: 'peer-uuid',
    });
    expect(result.success).toBe(true);
  });

  test('rejects offer without targetPeerId', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'offer',
      v: 1,
      sdp: 'v=0\r\no=...',
    });
    expect(result.success).toBe(false);
  });

  test('parses answer message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'answer',
      v: 1,
      sdp: 'v=0\r\no=...',
      targetPeerId: 'peer-uuid',
    });
    expect(result.success).toBe(true);
  });

  test('rejects answer without targetPeerId', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'answer',
      v: 1,
      sdp: 'v=0\r\no=...',
    });
    expect(result.success).toBe(false);
  });

  test('parses ice-candidate message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'ice-candidate',
      v: 1,
      candidate: { candidate: 'candidate:...', sdpMLineIndex: 0 },
      targetPeerId: 'peer-uuid',
    });
    expect(result.success).toBe(true);
  });

  test('rejects ice-candidate without targetPeerId', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'ice-candidate',
      v: 1,
      candidate: { candidate: 'candidate:...', sdpMLineIndex: 0 },
    });
    expect(result.success).toBe(false);
  });

  test('parses leave message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'leave',
      v: 1,
    });
    expect(result.success).toBe(true);
  });

  test('parses chat message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'chat',
      v: 1,
      roomId: 'abc123',
      blob: 'base64encodedblob==',
      uuid: 'msg-uuid-1',
    });
    expect(result.success).toBe(true);
  });

  test('rejects chat without uuid', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'chat',
      v: 1,
      roomId: 'abc123',
      blob: 'base64encodedblob==',
    });
    expect(result.success).toBe(false);
  });

  test('parses history-request message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'history-request',
      v: 1,
      roomId: 'abc123',
      before: 1700000000000,
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  test('parses history-request without optional fields', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'history-request',
      v: 1,
      roomId: 'abc123',
    });
    expect(result.success).toBe(true);
  });

  test('parses pong message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'pong',
      v: 1,
    });
    expect(result.success).toBe(true);
  });

  test('rejects unknown type', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'unknown-type',
      v: 1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing v field', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join',
      roomId: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  test('rejects wrong v value', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join',
      v: 2,
      roomId: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  test('rejects join without roomId', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join',
      v: 1,
      encryptedNickname: 'nick',
    });
    expect(result.success).toBe(false);
  });

  test('parses join-call message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'join-call',
      v: 1,
    });
    expect(result.success).toBe(true);
  });

  test('parses leave-call message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'leave-call',
      v: 1,
    });
    expect(result.success).toBe(true);
  });

  test('parses chat-received message', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'chat-received',
      v: 1,
      uuid: 'msg-uuid-1',
      peerId: 'peer-uuid-1',
    });
    expect(result.success).toBe(true);
  });

  test('rejects history-request with non-positive limit', () => {
    const result = ClientToServerMessageSchema.safeParse({
      type: 'history-request',
      v: 1,
      roomId: 'abc123',
      limit: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ServerToClientMessage
// ============================================================================

describe('ServerToClientMessageSchema', () => {
  test('parses join response', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'join',
      v: 1,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: 'all',
    });
    expect(result.success).toBe(true);
  });

  test('parses join response with TURN credentials', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'join',
      v: 1,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turns:t.example.com:443', username: 'user', credential: 'pass' },
      ],
      iceTransportPolicy: 'relay',
    });
    expect(result.success).toBe(true);
  });

  test('parses peer-joined', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'peer-joined',
      v: 1,
      peerId: 'uuid-123',
      encryptedNickname: 'encrypted-nick',
      count: 2,
    });
    expect(result.success).toBe(true);
  });

  test('rejects peer-joined without encryptedNickname', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'peer-joined',
      v: 1,
      peerId: 'uuid-123',
      count: 2,
    });
    expect(result.success).toBe(false);
  });

  test('parses peer-left', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'peer-left',
      v: 1,
      peerId: 'uuid-123',
      count: 1,
    });
    expect(result.success).toBe(true);
  });

  test('parses peers-list', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'peers-list',
      v: 1,
      peers: [
        { peerId: 'uuid-1', encryptedNickname: 'nick-1' },
        { peerId: 'uuid-2', encryptedNickname: 'nick-2' },
      ],
      selfPeerId: 'uuid-3',
    });
    expect(result.success).toBe(true);
  });

  test('parses offer from server', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'offer',
      v: 1,
      sdp: 'v=0\r\no=...',
      peerId: 'uuid-123',
    });
    expect(result.success).toBe(true);
  });

  test('parses answer from server', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'answer',
      v: 1,
      sdp: 'v=0\r\no=...',
      peerId: 'uuid-123',
    });
    expect(result.success).toBe(true);
  });

  test('parses ice-candidate from server', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'ice-candidate',
      v: 1,
      candidate: { candidate: 'candidate:...' },
      peerId: 'uuid-123',
    });
    expect(result.success).toBe(true);
  });

  test('parses chat-broadcast', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'chat-broadcast',
      v: 1,
      blob: 'base64data==',
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  test('parses history response', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'history',
      v: 1,
      messages: [
        { id: 2, blob: 'base64a==', created_at: 1700000001000 },
        { id: 1, blob: 'base64b==', created_at: 1700000000000 },
      ],
      hasMore: true,
    });
    expect(result.success).toBe(true);
  });

  test('parses empty history', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'history',
      v: 1,
      messages: [],
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  test('parses ping', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'ping',
      v: 1,
    });
    expect(result.success).toBe(true);
  });

  test('parses error with valid code', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'error',
      v: 1,
      code: 'ROOM_FULL',
      message: 'Room has reached maximum capacity',
    });
    expect(result.success).toBe(true);
  });

  test('rejects error with invalid code', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'error',
      v: 1,
      code: 'INVALID_CODE',
      message: 'Something happened',
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown message type', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'unknown',
      v: 1,
    });
    expect(result.success).toBe(false);
  });

  test('parses chat-ack', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'chat-ack',
      v: 1,
      uuid: 'msg-uuid-1',
    });
    expect(result.success).toBe(true);
  });

  test('parses chat-received relay', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'chat-received',
      v: 1,
      uuid: 'msg-uuid-1',
      peerId: 'peer-uuid-1',
    });
    expect(result.success).toBe(true);
  });

  test('parses call-peers', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'call-peers',
      v: 1,
      callPeers: ['uuid-1', 'uuid-2'],
    });
    expect(result.success).toBe(true);
  });

  test('parses call-peers with empty array', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'call-peers',
      v: 1,
      callPeers: [],
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing v field', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'ping',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ErrorCode
// ============================================================================

describe('ErrorCodeSchema', () => {
  const validCodes = [
    'ROOM_FULL',
    'INVALID_MESSAGE',
    'RATE_LIMITED',
    'BLOB_TOO_LARGE',
    'INVALID_BLOB_ID',
    'NOT_IN_ROOM',
    'UNKNOWN_PEER',
    'UNKNOWN',
  ];

  test.each(validCodes)('accepts valid code: %s', (code) => {
    const result = ErrorCodeSchema.safeParse(code);
    expect(result.success).toBe(true);
  });

  test('rejects invalid code', () => {
    const result = ErrorCodeSchema.safeParse('NOT_A_CODE');
    expect(result.success).toBe(false);
  });

  test('rejects empty string', () => {
    const result = ErrorCodeSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  test('rejects number', () => {
    const result = ErrorCodeSchema.safeParse(404);
    expect(result.success).toBe(false);
  });
});
