/**
 * Unit tests for SFU consumer — remote track consumption and stream assembly.
 *
 * @module client/sfu/consumer.test
 */

import { describe, test, expect, mock } from 'bun:test';
import type { types as msTypes } from 'mediasoup-client';
import { createConsumer, assembleRemoteStream } from './consumer';

// ============================================================================
// Mock factories
// ============================================================================

function createMockTrack(kind: 'audio' | 'video', id: string): MediaStreamTrack {
  return { kind, id } as unknown as MediaStreamTrack;
}

function createMockConsumer(id: string, kind: 'audio' | 'video'): msTypes.Consumer {
  return {
    id,
    kind,
    track: createMockTrack(kind, `track-${id}`),
  } as unknown as msTypes.Consumer;
}

function createMockTransport(): msTypes.Transport & { consume: ReturnType<typeof mock> } {
  return {
    consume: mock(
      async (opts: {
        id: string;
        producerId: string;
        kind: msTypes.MediaKind;
        rtpParameters: msTypes.RtpParameters;
      }) => createMockConsumer(opts.id, opts.kind),
    ),
  } as unknown as msTypes.Transport & { consume: ReturnType<typeof mock> };
}

function createMockMediaStream(): MediaStream & {
  _tracks: MediaStreamTrack[];
} {
  const tracks: MediaStreamTrack[] = [];
  return {
    _tracks: tracks,
    getTracks: () => [...tracks],
    addTrack(track: MediaStreamTrack) {
      tracks.push(track);
    },
    removeTrack(track: MediaStreamTrack) {
      const idx = tracks.indexOf(track);
      if (idx !== -1) tracks.splice(idx, 1);
    },
  } as unknown as MediaStream & { _tracks: MediaStreamTrack[] };
}

// Stub global MediaStream constructor for assembleRemoteStream when no existing stream
const OriginalMediaStream = globalThis.MediaStream;
globalThis.MediaStream = createMockMediaStream as unknown as typeof MediaStream;

// Restore after all tests
import { afterAll } from 'bun:test';
afterAll(() => {
  globalThis.MediaStream = OriginalMediaStream;
});

const FAKE_RTP_PARAMS = { codecs: [] } as unknown as msTypes.RtpParameters;

// ============================================================================
// Tests
// ============================================================================

describe('createConsumer', () => {
  test('creates a consumer on the recv transport', async () => {
    const transport = createMockTransport();

    const consumer = await createConsumer(transport, {
      peerId: 'peer-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      kind: 'audio',
      rtpParameters: FAKE_RTP_PARAMS,
      producerPaused: false,
    });

    expect(consumer.id).toBe('consumer-1');
    expect(consumer.kind).toBe('audio');
    expect(transport.consume).toHaveBeenCalledTimes(1);
    expect(transport.consume).toHaveBeenCalledWith({
      id: 'consumer-1',
      producerId: 'producer-1',
      kind: 'audio',
      rtpParameters: FAKE_RTP_PARAMS,
    });
  });
});

describe('assembleRemoteStream', () => {
  test('creates new stream when no existing stream', () => {
    const consumer = createMockConsumer('c-1', 'audio');

    const stream = assembleRemoteStream(null, consumer);

    expect(stream.getTracks()).toHaveLength(1);
    expect(stream.getTracks()[0]!.kind).toBe('audio');
  });

  test('adds track to existing stream', () => {
    const existingStream = createMockMediaStream() as unknown as MediaStream;
    const audioConsumer = createMockConsumer('c-audio', 'audio');
    assembleRemoteStream(existingStream, audioConsumer);

    const videoConsumer = createMockConsumer('c-video', 'video');
    const stream = assembleRemoteStream(existingStream, videoConsumer);

    expect(stream).toBe(existingStream);
    expect(stream.getTracks()).toHaveLength(2);
  });

  test('replaces track of the same kind', () => {
    const existingStream = createMockMediaStream() as unknown as MediaStream;
    const audioConsumer1 = createMockConsumer('c-audio-1', 'audio');
    assembleRemoteStream(existingStream, audioConsumer1);
    expect(existingStream.getTracks()).toHaveLength(1);

    // Add a second audio consumer — should replace the first
    const audioConsumer2 = createMockConsumer('c-audio-2', 'audio');
    assembleRemoteStream(existingStream, audioConsumer2);

    expect(existingStream.getTracks()).toHaveLength(1);
    expect(existingStream.getTracks()[0]).toBe(audioConsumer2.track);
  });
});
