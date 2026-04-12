/**
 * SFU transport creation — wires mediasoup-client transports to server signaling.
 *
 * Each transport's `connect` and `produce` events are handled by sending
 * messages to the server via WebSocket. The `produce` event uses a pending
 * callback pattern: the effect stores a resolver that is called when
 * `sfu-producer-created` arrives from the server.
 *
 * @module client/sfu/transport
 */

import type { Device, types as msTypes } from 'mediasoup-client';
import { sendMessage } from '../services/websocket';

/** Parameters received from server for transport creation. */
export interface TransportParams {
  id: string;
  iceParameters: msTypes.IceParameters;
  iceCandidates: msTypes.IceCandidate[];
  dtlsParameters: msTypes.DtlsParameters;
  sctpParameters?: msTypes.SctpParameters;
}

/** Ref for the pending produce callback (resolved by SFU_PRODUCER_CREATED). */
type PendingProduceCallback = { current: ((id: string) => void) | null };

/**
 * Create a mediasoup-client send transport, wired to server signaling.
 *
 * @param device - Loaded mediasoup-client Device.
 * @param ws - WebSocket for sending signaling messages.
 * @param params - Transport parameters from server.
 * @param pendingProduceCallback - Ref for the pending produce callback.
 */
export function createSfuSendTransport(
  device: Device,
  ws: WebSocket | null,
  params: TransportParams,
  pendingProduceCallback: PendingProduceCallback,
): msTypes.Transport {
  const transport = device.createSendTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    ...(params.sctpParameters ? { sctpParameters: params.sctpParameters } : {}),
  });

  transport.on('connect', ({ dtlsParameters }, callback, _errback) => {
    sendMessage(ws, {
      type: 'sfu-connect-transport',
      v: 1,
      transportId: transport.id,
      dtlsParameters: dtlsParameters as unknown,
    });
    // Resolve immediately — server handles DTLS connection asynchronously
    callback();
  });

  transport.on('produce', ({ kind, rtpParameters }, callback, _errback) => {
    // Store callback — will be resolved when SFU_PRODUCER_CREATED arrives
    pendingProduceCallback.current = (id: string) => {
      callback({ id });
    };

    sendMessage(ws, {
      type: 'sfu-produce',
      v: 1,
      transportId: transport.id,
      kind,
      rtpParameters: rtpParameters as unknown,
    });
  });

  console.log(`[SFU:Transport] Created send transport ${transport.id}`);
  return transport;
}

/**
 * Create a mediasoup-client recv transport, wired to server signaling.
 *
 * @param device - Loaded mediasoup-client Device.
 * @param ws - WebSocket for sending signaling messages.
 * @param params - Transport parameters from server.
 */
export function createSfuRecvTransport(
  device: Device,
  ws: WebSocket | null,
  params: TransportParams,
): msTypes.Transport {
  const transport = device.createRecvTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    ...(params.sctpParameters ? { sctpParameters: params.sctpParameters } : {}),
  });

  transport.on('connect', ({ dtlsParameters }, callback, _errback) => {
    sendMessage(ws, {
      type: 'sfu-connect-transport',
      v: 1,
      transportId: transport.id,
      dtlsParameters: dtlsParameters as unknown,
    });
    callback();
  });

  console.log(`[SFU:Transport] Created recv transport ${transport.id}`);
  return transport;
}
