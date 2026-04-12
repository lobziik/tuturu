/**
 * mediasoup-client Device singleton.
 *
 * The Device represents this browser's media capabilities.
 * It must be loaded with the Router's RTP capabilities before
 * creating transports or producing/consuming.
 *
 * @module client/sfu/device
 */

import { Device, type types as msTypes } from 'mediasoup-client';

let device: Device | null = null;

/**
 * Create and load a mediasoup-client Device with the router's RTP capabilities.
 * Returns the loaded Device. Subsequent calls return the existing Device.
 *
 * @param routerRtpCapabilities - RTP capabilities from the server's mediasoup Router.
 * @throws If the Device fails to load (unsupported browser, invalid capabilities).
 */
export async function loadDevice(routerRtpCapabilities: msTypes.RtpCapabilities): Promise<Device> {
  if (device?.loaded) {
    console.log('[SFU:Device] Already loaded, reusing');
    return device;
  }

  device = new Device();
  await device.load({ routerRtpCapabilities });
  console.log('[SFU:Device] Loaded successfully');
  return device;
}

/** Get the current Device, or null if not yet loaded. */
export function getDevice(): Device | null {
  return device?.loaded ? device : null;
}

/** Reset the Device singleton. Call on cleanup/disconnect. */
export function resetDevice(): void {
  device = null;
  console.log('[SFU:Device] Reset');
}
