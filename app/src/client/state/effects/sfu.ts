/**
 * SFU side effects — mediasoup-client Device, Transport, Producer, Consumer lifecycle.
 *
 * Mirrors the mesh WebRTC effects but routes media through the SFU server
 * instead of peer-to-peer connections. Active only when `sfuMode` is true.
 *
 * Flow:
 * 1. MEDIA_ACQUIRED → join-call + sfu-join (null caps to get router caps)
 * 2. SFU_ROUTER_CAPS_RECEIVED → load Device → sfu-join (real caps) → create transports
 * 3. SFU_TRANSPORT_CREATED(send) → create send transport → produce tracks
 * 4. SFU_TRANSPORT_CREATED(recv) → create recv transport (ready for consumers)
 * 5. SFU_PRODUCER_CREATED → resolve pending produce callback
 * 6. SFU_NEW_CONSUMER → consume on recv transport → assemble stream → E2EE decrypt
 * 7. TOGGLE_MUTE/VIDEO → producer pause/resume
 *
 * @module state/effects/sfu
 */

import { loadDevice, getDevice } from '../../sfu/device';
import {
  createSfuSendTransport,
  createSfuRecvTransport,
  type TransportParams,
} from '../../sfu/transport';
import { produceLocalTracks } from '../../sfu/producer';
import { createConsumer, assembleRemoteStream } from '../../sfu/consumer';
import {
  isE2eeSupported,
  createE2eeWorker,
  setupSenderTransform,
  setupReceiverTransform,
} from '../../e2ee/e2ee-transform';
import { sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen, getIceConfig } from './types';

/** Check if SFU mode is active in the current state. */
function isSfuMode(args: EffectArgs): boolean {
  return args.newState.phase === 'room' && args.newState.sfuMode;
}

/** Handle SFU-related side effects. Only runs when sfuMode is active. */
export function handleSfuEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;
  const newScreen = getScreen(newState);

  if (!isSfuMode(args)) return;

  // MEDIA_ACQUIRED → send join-call + sfu-join (first step: null caps to get router caps)
  if (action.type === 'MEDIA_ACQUIRED' && newScreen?.type === 'waiting-for-peer') {
    sendMessage(refs.ws.current, { type: 'join-call', v: 1 });
    refs.inCall.current = true;

    // Send sfu-join with null caps — server will respond with sfu-router-caps
    sendMessage(refs.ws.current, {
      type: 'sfu-join',
      v: 1,
      rtpCapabilities: null,
    });
    console.log('[SFU:Effects] Sent sfu-join (requesting router caps)');
  }

  // SFU_ROUTER_CAPS_RECEIVED → load Device, then re-join with real caps and request transports
  if (action.type === 'SFU_ROUTER_CAPS_RECEIVED') {
    const existingDevice = getDevice();
    if (existingDevice) {
      // Device already loaded (second sfu-router-caps from re-join) — ignore
      return;
    }

    void (async () => {
      try {
        const device = await loadDevice(action.rtpCapabilities);

        // Create E2EE worker if supported
        if (isE2eeSupported() && !refs.e2eeWorker.current) {
          refs.e2eeWorker.current = createE2eeWorker();
        }

        // Re-join with real RTP capabilities so server can create consumers for us
        sendMessage(refs.ws.current, {
          type: 'sfu-join',
          v: 1,
          rtpCapabilities: device.rtpCapabilities as unknown,
        });
        console.log('[SFU:Effects] Sent sfu-join (real caps)');

        // Request send + recv transports
        sendMessage(refs.ws.current, {
          type: 'sfu-create-transport',
          v: 1,
          direction: 'send',
        });
        sendMessage(refs.ws.current, {
          type: 'sfu-create-transport',
          v: 1,
          direction: 'recv',
        });
      } catch (error) {
        console.error('[SFU:Effects] Failed to load device:', error);
        dispatch({
          type: 'RTC_FAILED',
          reason: `SFU device load failed: ${error instanceof Error ? error.message : String(error)}`,
          peerId: 'sfu',
        });
      }
    })();
  }

  // SFU_TRANSPORT_CREATED → create local transport, produce if send
  if (action.type === 'SFU_TRANSPORT_CREATED') {
    const device = getDevice();
    if (!device) {
      console.error('[SFU:Effects] Device not loaded when transport created');
      return;
    }

    const iceConfig = getIceConfig(newState);
    if (!iceConfig || !iceConfig.iceServers) {
      console.error('[SFU:Effects] No ICE config available for transport creation');
      return;
    }

    const params: TransportParams = {
      id: action.id,
      iceParameters: action.iceParameters,
      iceCandidates: action.iceCandidates,
      dtlsParameters: action.dtlsParameters,
      ...(action.sctpParameters ? { sctpParameters: action.sctpParameters } : {}),
    };

    const transportIceConfig = {
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy,
    };

    if (action.direction === 'send') {
      const transport = createSfuSendTransport(
        device,
        refs.ws.current,
        params,
        refs.pendingProduceCallbacks,
        transportIceConfig,
      );
      refs.sfuSendTransport.current = transport;

      // Produce local tracks
      if (refs.localStream.current) {
        void (async () => {
          try {
            const producers = await produceLocalTracks(transport, refs.localStream.current!);
            for (const [kind, producer] of producers) {
              refs.sfuProducers.current.set(kind, producer);

              // Apply E2EE encrypt transform if available
              if (refs.e2eeWorker.current && refs.aesKey.current && producer.rtpSender) {
                setupSenderTransform(
                  producer.rtpSender,
                  refs.aesKey.current,
                  refs.e2eeWorker.current,
                );
              }
            }
          } catch (error) {
            console.error('[SFU:Effects] Failed to produce:', error);
            dispatch({
              type: 'RTC_FAILED',
              reason: `SFU produce failed: ${error instanceof Error ? error.message : String(error)}`,
              peerId: 'sfu',
            });
          }
        })();
      }
    } else {
      const transport = createSfuRecvTransport(device, refs.ws.current, params, transportIceConfig);
      refs.sfuRecvTransport.current = transport;
    }
  }

  // SFU_PRODUCER_CREATED → resolve next pending produce callback (FIFO)
  if (action.type === 'SFU_PRODUCER_CREATED') {
    const callback = refs.pendingProduceCallbacks.current.shift();
    if (callback) {
      callback(action.id);
    }
  }

  // SFU_NEW_CONSUMER → create consumer, assemble stream, apply E2EE, resume
  if (action.type === 'SFU_NEW_CONSUMER') {
    const recvTransport = refs.sfuRecvTransport.current;
    if (!recvTransport) {
      console.error('[SFU:Effects] No recv transport for new consumer');
      return;
    }

    void (async () => {
      try {
        const consumer = await createConsumer(recvTransport, {
          peerId: action.peerId,
          producerId: action.producerId,
          consumerId: action.consumerId,
          kind: action.kind,
          rtpParameters: action.rtpParameters,
          producerPaused: action.producerPaused,
        });

        refs.sfuConsumers.current.set(consumer.id, consumer);

        // Apply E2EE decrypt transform if available
        if (refs.e2eeWorker.current && refs.aesKey.current && consumer.rtpReceiver) {
          setupReceiverTransform(
            consumer.rtpReceiver,
            refs.aesKey.current,
            refs.e2eeWorker.current,
          );
        }

        // Assemble MediaStream per peer
        const existingStream = refs.remoteStreams.current.get(action.peerId) ?? null;
        const stream = assembleRemoteStream(existingStream, consumer);
        refs.remoteStreams.current.set(action.peerId, stream);

        // Mark peer as connected — triggers re-render AFTER the stream is in the
        // ref Map, so VideoTile picks it up. Mirrors the mesh flow where
        // RTC_CONNECTED fires after ontrack has already populated the stream.
        dispatch({
          type: 'RTC_CONNECTED',
          peerId: action.peerId,
        });

        // Resume the consumer (it was created paused on the server)
        sendMessage(refs.ws.current, {
          type: 'sfu-consume-resume',
          v: 1,
          consumerId: consumer.id,
        });
      } catch (error) {
        console.error(
          `[SFU:Effects] Failed to create consumer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  // TOGGLE_MUTE in SFU mode → pause/resume audio producer
  if (action.type === 'TOGGLE_MUTE' && newScreen && 'muted' in newScreen) {
    const audioProducer = refs.sfuProducers.current.get('audio');
    if (audioProducer) {
      if (newScreen.muted) {
        void audioProducer.pause();
        sendMessage(refs.ws.current, {
          type: 'sfu-producer-pause',
          v: 1,
          producerId: audioProducer.id,
        });
      } else {
        void audioProducer.resume();
        sendMessage(refs.ws.current, {
          type: 'sfu-producer-resume',
          v: 1,
          producerId: audioProducer.id,
        });
      }
    }
  }

  // TOGGLE_VIDEO in SFU mode → pause/resume video producer
  if (action.type === 'TOGGLE_VIDEO' && newScreen && 'videoOff' in newScreen) {
    const videoProducer = refs.sfuProducers.current.get('video');
    if (videoProducer) {
      if (newScreen.videoOff) {
        void videoProducer.pause();
        sendMessage(refs.ws.current, {
          type: 'sfu-producer-pause',
          v: 1,
          producerId: videoProducer.id,
        });
      } else {
        void videoProducer.resume();
        sendMessage(refs.ws.current, {
          type: 'sfu-producer-resume',
          v: 1,
          producerId: videoProducer.id,
        });
      }
    }
  }
}
