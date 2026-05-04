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

import type { types as msTypes } from 'mediasoup-client';
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
  normalizeCodec,
} from '../../e2ee/e2ee-transform';
import { sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen, getIceConfig } from './types';

/** Check if SFU mode is active in the current state. */
function isSfuMode(args: EffectArgs): boolean {
  return args.newState.phase === 'room' && args.newState.sfuMode;
}

/**
 * Check if the server requires E2EE for media. When false, we skip wiring
 * RTCRtpScriptTransform on producers/consumers and the call runs as plain
 * WebRTC (server-side mediasoup is fine with this — the script transform is
 * purely a client-side concern).
 */
function isE2eeRequired(args: EffectArgs): boolean {
  return args.newState.phase === 'room' && args.newState.e2eeMediaEnabled;
}

/** MEDIA_ACQUIRED → send join-call + sfu-join (first step: null caps to get router caps) */
function handleSfuMediaAcquired(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const newScreen = getScreen(args.newState);

  if (newScreen?.type !== 'waiting-for-peer') return;

  sendMessage(refs.ws.current, { type: 'join-call', v: 1 });
  refs.inCall.current = true;

  sendMessage(refs.ws.current, {
    type: 'sfu-join',
    v: 1,
    rtpCapabilities: null,
  });
  console.log('[SFU:Effects] Sent sfu-join (requesting router caps)');
}

/** SFU_ROUTER_CAPS_RECEIVED → load Device, then re-join with real caps and request transports */
function handleSfuRouterCaps(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action } = args;
  if (action.type !== 'SFU_ROUTER_CAPS_RECEIVED') return;

  const dm = refs.deviceManager.current;
  if (dm.getDevice()) return;

  void (async () => {
    try {
      const device = await dm.loadDevice(action.rtpCapabilities);

      if (isE2eeRequired(args) && !refs.e2eeWorker.current) {
        if (!isE2eeSupported()) {
          // refuseUnsupportedBrowser at JOINED_ROOM should have caught this.
          // Reaching here = the gate regressed. Mirror mesh's buildE2eeConfig
          // throw so we never silently produce/consume in plaintext while the
          // server policy says E2EE is required.
          throw new Error(
            '[E2EE] Server requires E2EE but RTCRtpScriptTransform is not available in this browser',
          );
        }
        refs.e2eeWorker.current = createE2eeWorker();
        if (!refs.e2eeWorker.current) {
          throw new Error('[E2EE] createE2eeWorker returned null despite feature detection');
        }
      }

      sendMessage(refs.ws.current, {
        type: 'sfu-join',
        v: 1,
        rtpCapabilities: device.recvRtpCapabilities as Record<string, unknown>,
      });
      console.log('[SFU:Effects] Sent sfu-join (real caps)');

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

/** SFU_TRANSPORT_CREATED → create local transport, produce if send */
function handleSfuTransportCreated(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;
  if (action.type !== 'SFU_TRANSPORT_CREATED') return;

  const device = refs.deviceManager.current.getDevice();
  if (!device) {
    console.error('[SFU:Effects] Device not loaded when transport created');
    return;
  }

  const iceConfig = getIceConfig(newState);
  if (!iceConfig?.iceServers) {
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
      isE2eeRequired(args),
    );
    refs.sfuSendTransport.current = transport;

    if (refs.localStream.current) {
      void (async () => {
        try {
          const producers = await produceLocalTracks(transport, refs.localStream.current!);
          for (const [kind, producer] of producers) {
            refs.sfuProducers.current.set(kind, producer);

            if (isE2eeRequired(args)) {
              // refuseUnsupportedBrowser + handleSfuRouterCaps already
              // guaranteed worker + key by the time we get here. A missing
              // rtpSender on a freshly-produced track would be a
              // mediasoup-client API regression. Treat all three as
              // assertion failures so the caller's catch surfaces them as
              // RTC_FAILED rather than silently producing in plaintext
              // while the server policy says E2EE is required.
              if (!refs.e2eeWorker.current || !refs.aesKey.current) {
                throw new Error(
                  '[E2EE] producer transform: worker/key missing despite isE2eeRequired',
                );
              }
              if (!producer.rtpSender) {
                throw new Error('[E2EE] producer.rtpSender missing after produce()');
              }
              // mediasoup contract: rtpParameters.codecs is non-empty after
              // produce(). Throws (caught below → RTC_FAILED) on any codec
              // outside what the SFU router negotiates.
              const codec = normalizeCodec(producer.rtpParameters.codecs[0]!.mimeType);
              setupSenderTransform(
                producer.rtpSender,
                refs.aesKey.current,
                refs.e2eeWorker.current,
                codec,
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
    const transport = createSfuRecvTransport(
      device,
      refs.ws.current,
      params,
      transportIceConfig,
      isE2eeRequired(args),
    );
    refs.sfuRecvTransport.current = transport;
  }
}

/** SFU_PRODUCER_CREATED → resolve next pending produce callback (FIFO) */
function handleSfuProducerCreated(ctx: EffectContext, args: EffectArgs): void {
  if (args.action.type !== 'SFU_PRODUCER_CREATED') return;

  const callback = ctx.refs.pendingProduceCallbacks.current.shift();
  if (callback) {
    callback(args.action.id);
  }
}

/** SFU_NEW_CONSUMER → create consumer, assemble stream, apply E2EE, resume */
function handleSfuNewConsumer(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action } = args;
  if (action.type !== 'SFU_NEW_CONSUMER') return;

  const recvTransport = refs.sfuRecvTransport.current;
  if (!recvTransport) {
    console.error('[SFU:Effects] No recv transport for new consumer');
    return;
  }

  void (async () => {
    let consumer: msTypes.Consumer | undefined;
    try {
      consumer = await createConsumer(recvTransport, {
        peerId: action.peerId,
        producerId: action.producerId,
        consumerId: action.consumerId,
        kind: action.kind,
        rtpParameters: action.rtpParameters,
        producerPaused: action.producerPaused,
      });

      refs.sfuConsumers.current.set(consumer.id, consumer);

      if (isE2eeRequired(args)) {
        // Mirrors the producer-side assertion — defense-in-depth for the
        // case where the JOINED_ROOM gate or handleSfuRouterCaps regressed.
        // Without these throws we'd silently consume in plaintext while
        // the server requires E2EE.
        if (!refs.e2eeWorker.current || !refs.aesKey.current) {
          throw new Error('[E2EE] consumer transform: worker/key missing despite isE2eeRequired');
        }
        if (!consumer.rtpReceiver) {
          throw new Error('[E2EE] consumer.rtpReceiver missing after consume()');
        }
        const codec = normalizeCodec(consumer.rtpParameters.codecs[0]!.mimeType);
        // SRD-timing note: transport.consume() does addTransceiver + SRD
        // under the hood, so we're attaching .transform AFTER SRD here.
        // applyE2eeTransforms (mesh callee path) must wire transforms
        // BEFORE SRD on iOS Safari to avoid losing 100% of decrypted
        // frames; that constraint does NOT bite here, empirically. If you
        // ever need to move this call site (or replace mediasoup-client),
        // verify on a real iOS device first — a regression in this path
        // looks like silent loss of incoming peer media.
        setupReceiverTransform(
          consumer.rtpReceiver,
          refs.aesKey.current,
          refs.e2eeWorker.current,
          codec,
        );
      }

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

      sendMessage(refs.ws.current, {
        type: 'sfu-consume-resume',
        v: 1,
        consumerId: consumer.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SFU:Effects] Failed to create consumer: ${message}`);
      // Drop the half-built consumer if we got that far — without this it sits
      // in sfuConsumers forever, the server-side consumer stays paused (we
      // never sent sfu-consume-resume), and the peer slot in the UI never
      // resolves.
      if (consumer) {
        refs.sfuConsumers.current.delete(consumer.id);
        try {
          consumer.close();
        } catch {
          // Already-closed / race during teardown — nothing to do.
        }
      }
      // Surface the failure on the SPECIFIC peer, not 'sfu': the producer
      // branch fails the SFU connection as a whole because produce()
      // failures imply our upstream is broken; consume() failures are
      // bound to one peer's track.
      dispatch({
        type: 'RTC_FAILED',
        reason: `SFU consume failed for peer ${action.peerId}: ${message}`,
        peerId: action.peerId,
      });
    }
  })();
}

/** TOGGLE_MUTE in SFU mode → pause/resume audio producer */
function handleSfuToggleMute(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const newScreen = getScreen(args.newState);

  if (!newScreen || !('muted' in newScreen)) return;

  const audioProducer = refs.sfuProducers.current.get('audio');
  if (!audioProducer) return;

  if (newScreen.muted) {
    audioProducer.pause();
    sendMessage(refs.ws.current, {
      type: 'sfu-producer-pause',
      v: 1,
      producerId: audioProducer.id,
    });
  } else {
    audioProducer.resume();
    sendMessage(refs.ws.current, {
      type: 'sfu-producer-resume',
      v: 1,
      producerId: audioProducer.id,
    });
  }
}

/** TOGGLE_VIDEO in SFU mode → pause/resume video producer */
function handleSfuToggleVideo(ctx: EffectContext, args: EffectArgs): void {
  const { refs } = ctx;
  const newScreen = getScreen(args.newState);

  if (!newScreen || !('videoOff' in newScreen)) return;

  const videoProducer = refs.sfuProducers.current.get('video');
  if (!videoProducer) return;

  if (newScreen.videoOff) {
    videoProducer.pause();
    sendMessage(refs.ws.current, {
      type: 'sfu-producer-pause',
      v: 1,
      producerId: videoProducer.id,
    });
  } else {
    videoProducer.resume();
    sendMessage(refs.ws.current, {
      type: 'sfu-producer-resume',
      v: 1,
      producerId: videoProducer.id,
    });
  }
}

/** Handle SFU-related side effects. Only runs when sfuMode is active. */
export function handleSfuEffects(ctx: EffectContext, args: EffectArgs): void {
  if (!isSfuMode(args)) return;

  if (args.action.type === 'MEDIA_ACQUIRED') handleSfuMediaAcquired(ctx, args);
  if (args.action.type === 'SFU_ROUTER_CAPS_RECEIVED') handleSfuRouterCaps(ctx, args);
  if (args.action.type === 'SFU_TRANSPORT_CREATED') handleSfuTransportCreated(ctx, args);
  if (args.action.type === 'SFU_PRODUCER_CREATED') handleSfuProducerCreated(ctx, args);
  if (args.action.type === 'SFU_NEW_CONSUMER') handleSfuNewConsumer(ctx, args);
  if (args.action.type === 'TOGGLE_MUTE') handleSfuToggleMute(ctx, args);
  if (args.action.type === 'TOGGLE_VIDEO') handleSfuToggleVideo(ctx, args);
}
