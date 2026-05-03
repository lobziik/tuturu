/**
 * Unit tests for the WebRTC ICE server configuration builder.
 *
 * Mocks `./config` and `./turn` so the suite does not depend on the env-driven
 * `loadConfig()` cache or on real HMAC credential generation.
 *
 * @module server/ice.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ============================================================================
// Mock setup
// ============================================================================

let mockStunServers: string[] = ['stun:stun.test:19302'];
let mockDomain: string | undefined = 'example.com';
let mockTurnSecret: string | undefined = 'a'.repeat(32);

const mockGenerateTurnCredentials = mock((clientId: string) => ({
  username: `9999999999:${clientId}`,
  credential: 'mock-credential',
  expiresAt: 9999999999,
}));

// Mock `./config` and `./turn` before importing the module under test.
// `config.ts` evaluates `process.env` at import time, so swapping the module
// is the cleanest way to drive different scenarios per test.
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is synchronous in bun:test
mock.module('./config', () => ({
  config: {
    get stunServers() {
      return mockStunServers;
    },
    get domain() {
      return mockDomain;
    },
    get turnSecret() {
      return mockTurnSecret;
    },
  },
  isTurnConfigured: () => Boolean(mockTurnSecret && mockDomain),
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is synchronous in bun:test
mock.module('./turn', () => ({
  generateTurnCredentials: mockGenerateTurnCredentials,
}));

const { buildIceServers } = await import('./ice');

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockStunServers = ['stun:stun.test:19302'];
  mockDomain = 'example.com';
  mockTurnSecret = 'a'.repeat(32);
  mockGenerateTurnCredentials.mockClear();
});

describe('buildIceServers', () => {
  test('returns only STUN entries when TURN is not configured', () => {
    mockTurnSecret = undefined;
    const out = buildIceServers('client-1');
    expect(out).toEqual([{ urls: 'stun:stun.test:19302' }]);
    expect(mockGenerateTurnCredentials).not.toHaveBeenCalled();
  });

  test('preserves multiple STUN entries in order', () => {
    mockStunServers = ['stun:a:3478', 'stun:b:3478'];
    mockTurnSecret = undefined;
    expect(buildIceServers('client-1')).toEqual([{ urls: 'stun:a:3478' }, { urls: 'stun:b:3478' }]);
  });

  test('appends 4 TURN transports in priority order when TURN is configured', () => {
    const result = buildIceServers('client-42');

    expect(mockGenerateTurnCredentials).toHaveBeenCalledTimes(1);
    expect(mockGenerateTurnCredentials).toHaveBeenCalledWith('client-42');

    expect(result).toEqual([
      { urls: 'stun:stun.test:19302' },
      {
        urls: 'turns:t.example.com:443?transport=tcp',
        username: '9999999999:client-42',
        credential: 'mock-credential',
      },
      {
        urls: 'turns:t.example.com:5349?transport=tcp',
        username: '9999999999:client-42',
        credential: 'mock-credential',
      },
      {
        urls: 'turn:t.example.com:3478?transport=tcp',
        username: '9999999999:client-42',
        credential: 'mock-credential',
      },
      {
        urls: 'turn:t.example.com:3478?transport=udp',
        username: '9999999999:client-42',
        credential: 'mock-credential',
      },
    ]);
  });

  test('uses the configured domain (prefixed with `t.`) for TURN URLs', () => {
    mockDomain = 'call.elsewhere.io';
    const turnEntries = buildIceServers('c').slice(1);
    expect(turnEntries).toHaveLength(4);
    for (const entry of turnEntries) {
      expect(typeof entry.urls).toBe('string');
      expect(entry.urls as string).toContain('t.call.elsewhere.io');
    }
  });
});
