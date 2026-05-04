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
import type { IceServerConfig, IceTransportPolicy } from '../../shared/types';
// Aliased on import — the rest of the file already uses the local name.
// Doc-block for the constant lives at the source in e2ee-transform.ts.
import { RTC_ENCODED_INSERTABLE_STREAMS as ENCODED_INSERTABLE_STREAMS_SETTINGS } from '../e2ee/e2ee-transform';

/** Default timeout for sfu-producer-created before failing the produce call (ms). */
export const PRODUCE_TIMEOUT_MS = 10_000;

/** Parameters received from server for transport creation. */
export interface TransportParams {
  id: string;
  iceParameters: msTypes.IceParameters;
  iceCandidates: msTypes.IceCandidate[];
  dtlsParameters: msTypes.DtlsParameters;
  sctpParameters?: msTypes.SctpParameters;
}

/** ICE configuration for mediasoup-client transports. */
interface TransportIceConfig {
  iceServers: IceServerConfig[];
  iceTransportPolicy: IceTransportPolicy;
}

/** Map IceServerConfig[] to RTCIceServer[] with exactOptionalPropertyTypes safety. */
function toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
  return servers.map((s) => ({
    urls: s.urls,
    ...(s.username !== undefined && { username: s.username }),
    ...(s.credential !== undefined && { credential: s.credential }),
  }));
}

/** Ref for the pending produce callback queue (resolved by SFU_PRODUCER_CREATED, FIFO). */
type PendingProduceCallbacks = { current: ((id: string) => void)[] };

/**
 * Create a mediasoup-client send transport, wired to server signaling.
 *
 * @param device - Loaded mediasoup-client Device.
 * @param ws - WebSocket for sending signaling messages.
 * @param params - Transport parameters from server.
 * @param pendingProduceCallbacks - Ref for the pending produce callback queue.
 * @param iceConfig - ICE servers and transport policy (TURN relay support).
 * @param e2eeEnabled - When true, request encoded-insertable-streams on the
 *   underlying RTCPeerConnection so RTCRtpScriptTransform can deliver encrypt
 *   frames. Must be false when E2EE is off — see DANGER note in
 *   e2ee-transform.ts.
 * @param produceTimeoutMs - Timeout for produce callback (ms). Defaults to {@link PRODUCE_TIMEOUT_MS}.
 */
export function createSfuSendTransport(
  device: Device,
  ws: WebSocket | null,
  params: TransportParams,
  pendingProduceCallbacks: PendingProduceCallbacks,
  iceConfig: TransportIceConfig,
  e2eeEnabled: boolean,
  produceTimeoutMs: number = PRODUCE_TIMEOUT_MS,
): msTypes.Transport {
  const transport = device.createSendTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    ...(params.sctpParameters ? { sctpParameters: params.sctpParameters } : {}),
    iceServers: toRtcIceServers(iceConfig.iceServers),
    iceTransportPolicy: iceConfig.iceTransportPolicy,
    // Only attach `additionalSettings` when E2EE is actually wired on the
    // producer side — Chrome silently drops media if encodedInsertableStreams
    // is set without a transform attached. See DANGER note in
    // e2ee-transform.ts. mediasoup-client forwards `additionalSettings` to
    // `new RTCPeerConnection(...)`.
    ...(e2eeEnabled ? { additionalSettings: ENCODED_INSERTABLE_STREAMS_SETTINGS } : {}),
  });

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    try {
      sendMessage(ws, {
        type: 'sfu-connect-transport',
        v: 1,
        transportId: transport.id,
        dtlsParameters: dtlsParameters as Record<string, unknown>,
      });
      // Resolve immediately — server handles DTLS connection asynchronously
      callback();
    } catch (error) {
      errback(error instanceof Error ? error : new Error(String(error)));
    }
  });

  transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    // Enqueue callback — will be resolved in FIFO order when SFU_PRODUCER_CREATED arrives.
    // Timeout prevents silent hangs if the server never responds.
    const timer = setTimeout(() => {
      const idx = pendingProduceCallbacks.current.indexOf(wrappedCallback);
      if (idx !== -1) {
        pendingProduceCallbacks.current.splice(idx, 1);
      }
      errback(new Error(`sfu-produce timed out for ${kind} on transport ${transport.id}`));
    }, produceTimeoutMs);

    const wrappedCallback = (id: string): void => {
      clearTimeout(timer);
      callback({ id });
    };

    pendingProduceCallbacks.current.push(wrappedCallback);

    sendMessage(ws, {
      type: 'sfu-produce',
      v: 1,
      transportId: transport.id,
      kind,
      rtpParameters: rtpParameters as Record<string, unknown>,
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
 * @param iceConfig - ICE servers and transport policy (TURN relay support).
 * @param e2eeEnabled - When true, request encoded-insertable-streams on the
 *   underlying RTCPeerConnection so RTCRtpScriptTransform can deliver decrypt
 *   frames. Must be false when E2EE is off — see DANGER note in
 *   e2ee-transform.ts.
 */
export function createSfuRecvTransport(
  device: Device,
  ws: WebSocket | null,
  params: TransportParams,
  iceConfig: TransportIceConfig,
  e2eeEnabled: boolean,
): msTypes.Transport {
  const transport = device.createRecvTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    ...(params.sctpParameters ? { sctpParameters: params.sctpParameters } : {}),
    iceServers: toRtcIceServers(iceConfig.iceServers),
    iceTransportPolicy: iceConfig.iceTransportPolicy,
    // See createSfuSendTransport and DANGER note in e2ee-transform.ts —
    // Chrome silently drops media if this flag is set without a transform.
    ...(e2eeEnabled ? { additionalSettings: ENCODED_INSERTABLE_STREAMS_SETTINGS } : {}),
  });

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    try {
      sendMessage(ws, {
        type: 'sfu-connect-transport',
        v: 1,
        transportId: transport.id,
        dtlsParameters: dtlsParameters as Record<string, unknown>,
      });
      callback();
    } catch (error) {
      errback(error instanceof Error ? error : new Error(String(error)));
    }
  });

  console.log(`[SFU:Transport] Created recv transport ${transport.id}`);
  return transport;
}
