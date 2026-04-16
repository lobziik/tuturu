/**
 * mediasoup-client Device manager (factory pattern).
 *
 * The Device represents this browser's media capabilities.
 * It must be loaded with the Router's RTP capabilities before
 * creating transports or producing/consuming.
 *
 * Uses a factory function instead of module-level mutable state,
 * so each instance is independently testable and cleanly scoped to refs.
 *
 * @module client/sfu/device
 */

import { Device, type types as msTypes } from 'mediasoup-client';

/** Device manager returned by {@link createDeviceManager}. */
export interface DeviceManager {
  /**
   * Create and load a mediasoup-client Device with the router's RTP capabilities.
   * Returns the loaded Device. Subsequent calls return the existing Device.
   *
   * @param routerRtpCapabilities - RTP capabilities from the server's mediasoup Router.
   * @throws If the Device fails to load (unsupported browser, invalid capabilities).
   */
  loadDevice(routerRtpCapabilities: msTypes.RtpCapabilities): Promise<Device>;

  /** Get the current Device, or null if not yet loaded. */
  getDevice(): Device | null;

  /** Reset the Device. Call on cleanup/disconnect. */
  resetDevice(): void;
}

/**
 * Create a new Device manager with encapsulated state.
 * Each call returns an independent instance — no shared module-level mutable state.
 */
export function createDeviceManager(): DeviceManager {
  let device: Device | null = null;

  async function loadDevice(routerRtpCapabilities: msTypes.RtpCapabilities): Promise<Device> {
    if (device?.loaded) {
      console.log('[SFU:Device] Already loaded, reusing');
      return device;
    }

    device = new Device();
    await device.load({ routerRtpCapabilities });
    console.log('[SFU:Device] Loaded successfully');
    return device;
  }

  function getDevice(): Device | null {
    return device?.loaded ? device : null;
  }

  function resetDevice(): void {
    device = null;
    console.log('[SFU:Device] Reset');
  }

  return { loadDevice, getDevice, resetDevice };
}
