/**
 * Unit tests for the SFU Device manager (factory pattern).
 *
 * Mocks mediasoup-client Device to test lifecycle without a real browser.
 *
 * @module client/sfu/device.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { types as msTypes } from 'mediasoup-client';

// ============================================================================
// Mock setup
// ============================================================================

let mockLoaded = false;
const mockLoadFn = mock(async (_opts: { routerRtpCapabilities: msTypes.RtpCapabilities }) => {
  mockLoaded = true;
});

class MockDevice {
  get loaded(): boolean {
    return mockLoaded;
  }
  load = mockLoadFn;
  recvRtpCapabilities = { codecs: [], headerExtensions: [] };
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is sync in bun:test
mock.module('mediasoup-client', () => ({
  Device: MockDevice,
}));

const { createDeviceManager } = await import('./device');

const FAKE_RTP_CAPS: msTypes.RtpCapabilities = {
  codecs: [],
  headerExtensions: [],
};

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockLoaded = false;
  mockLoadFn.mockClear();
});

describe('createDeviceManager', () => {
  test('creates independent instances', () => {
    const dm1 = createDeviceManager();
    const dm2 = createDeviceManager();
    expect(dm1).not.toBe(dm2);
  });

  describe('getDevice', () => {
    test('returns null before loading', () => {
      const dm = createDeviceManager();
      expect(dm.getDevice()).toBeNull();
    });

    test('returns device after loading', async () => {
      const dm = createDeviceManager();
      await dm.loadDevice(FAKE_RTP_CAPS);
      expect(dm.getDevice()).not.toBeNull();
    });
  });

  describe('loadDevice', () => {
    test('creates and loads a device', async () => {
      const dm = createDeviceManager();
      const device = await dm.loadDevice(FAKE_RTP_CAPS);
      expect(device).toBeDefined();
      expect(device.loaded).toBe(true);
      expect(mockLoadFn).toHaveBeenCalledTimes(1);
    });

    test('returns existing device on subsequent calls', async () => {
      const dm = createDeviceManager();
      const d1 = await dm.loadDevice(FAKE_RTP_CAPS);
      const d2 = await dm.loadDevice(FAKE_RTP_CAPS);
      expect(d1).toBe(d2);
      // load() should only be called once — second call reuses
      expect(mockLoadFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetDevice', () => {
    test('clears the device', async () => {
      const dm = createDeviceManager();
      await dm.loadDevice(FAKE_RTP_CAPS);
      expect(dm.getDevice()).not.toBeNull();

      dm.resetDevice();
      expect(dm.getDevice()).toBeNull();
    });

    test('allows reloading after reset', async () => {
      const dm = createDeviceManager();
      await dm.loadDevice(FAKE_RTP_CAPS);
      dm.resetDevice();

      // Reset mock state to simulate fresh device
      mockLoaded = false;
      const device = await dm.loadDevice(FAKE_RTP_CAPS);
      expect(device).toBeDefined();
      expect(mockLoadFn).toHaveBeenCalledTimes(2);
    });
  });
});
