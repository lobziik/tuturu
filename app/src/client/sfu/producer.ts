/**
 * SFU producer — produce audio/video tracks on the send transport.
 *
 * @module client/sfu/producer
 */

import type { types as msTypes } from 'mediasoup-client';

/**
 * Produce audio and video tracks from a local MediaStream on the send transport.
 *
 * @param sendTransport - The mediasoup-client send Transport.
 * @param localStream - The local MediaStream with audio/video tracks.
 * @returns Map of kind → Producer for the produced tracks.
 */
export async function produceLocalTracks(
  sendTransport: msTypes.Transport,
  localStream: MediaStream,
): Promise<Map<string, msTypes.Producer>> {
  const producers = new Map<string, msTypes.Producer>();

  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    const audioProducer = await sendTransport.produce({ track: audioTrack });
    producers.set('audio', audioProducer);
    console.log(`[SFU:Producer] Producing audio (producer ${audioProducer.id})`);
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    const videoProducer = await sendTransport.produce({ track: videoTrack });
    producers.set('video', videoProducer);
    console.log(`[SFU:Producer] Producing video (producer ${videoProducer.id})`);
  }

  return producers;
}
