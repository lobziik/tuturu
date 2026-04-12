/**
 * SFU consumer — consume remote tracks from the recv transport.
 *
 * Assembles one MediaStream per remote peer by combining audio and video
 * consumer tracks. This stream is then stored in remoteStreams for rendering.
 *
 * @module client/sfu/consumer
 */

import type { types as msTypes } from 'mediasoup-client';

/** Parameters received from server for consumer creation. */
interface ConsumerParams {
  peerId: string;
  producerId: string;
  consumerId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
  producerPaused: boolean;
}

/**
 * Create a consumer on the recv transport and return it.
 *
 * @param recvTransport - The mediasoup-client recv Transport.
 * @param params - Consumer parameters from the server's `sfu-new-consumer` message.
 * @returns The created Consumer.
 */
export async function createConsumer(
  recvTransport: msTypes.Transport,
  params: ConsumerParams,
): Promise<msTypes.Consumer> {
  const consumer = await recvTransport.consume({
    id: params.consumerId,
    producerId: params.producerId,
    kind: params.kind,
    rtpParameters: params.rtpParameters,
  });

  console.log(
    `[SFU:Consumer] Created consumer ${consumer.id} (${consumer.kind}) from peer ${params.peerId}`,
  );

  return consumer;
}

/**
 * Assemble a MediaStream for a remote peer from their consumer tracks.
 *
 * If an existing stream is provided, adds/replaces the track of the given kind.
 * Otherwise creates a new stream.
 *
 * @param existingStream - Existing MediaStream for this peer, or null.
 * @param consumer - The new consumer whose track to add.
 * @returns The assembled MediaStream.
 */
export function assembleRemoteStream(
  existingStream: MediaStream | null,
  consumer: msTypes.Consumer,
): MediaStream {
  const stream = existingStream ?? new MediaStream();
  stream.addTrack(consumer.track);
  return stream;
}
