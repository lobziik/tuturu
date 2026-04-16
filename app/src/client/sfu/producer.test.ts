/**
 * Unit tests for SFU producer — local track production on send transport.
 *
 * @module client/sfu/producer.test
 */

import { describe, test, expect, mock } from 'bun:test';
import type { types as msTypes } from 'mediasoup-client';
import { produceLocalTracks } from './producer';

// ============================================================================
// Mock factories
// ============================================================================

function createMockProducer(id: string, kind: string): msTypes.Producer {
  return { id, kind } as unknown as msTypes.Producer;
}

function createMockTransport(): msTypes.Transport & { produce: ReturnType<typeof mock> } {
  let callCount = 0;
  return {
    produce: mock(async (opts: { track: MediaStreamTrack }) => {
      return createMockProducer(`producer-${callCount++}`, opts.track.kind);
    }),
  } as unknown as msTypes.Transport & { produce: ReturnType<typeof mock> };
}

function createMockMediaStream(tracks: Array<{ kind: 'audio' | 'video' }>): MediaStream {
  const audioTracks = tracks
    .filter((t) => t.kind === 'audio')
    .map((_, i) => ({ kind: 'audio', id: `audio-${i}` }) as unknown as MediaStreamTrack);
  const videoTracks = tracks
    .filter((t) => t.kind === 'video')
    .map((_, i) => ({ kind: 'video', id: `video-${i}` }) as unknown as MediaStreamTrack);

  return {
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
  } as unknown as MediaStream;
}

// ============================================================================
// Tests
// ============================================================================

describe('produceLocalTracks', () => {
  test('produces both audio and video', async () => {
    const transport = createMockTransport();
    const stream = createMockMediaStream([{ kind: 'audio' }, { kind: 'video' }]);

    const producers = await produceLocalTracks(transport, stream);

    expect(producers.size).toBe(2);
    expect(producers.has('audio')).toBe(true);
    expect(producers.has('video')).toBe(true);
    expect(transport.produce).toHaveBeenCalledTimes(2);
  });

  test('produces only audio when no video track', async () => {
    const transport = createMockTransport();
    const stream = createMockMediaStream([{ kind: 'audio' }]);

    const producers = await produceLocalTracks(transport, stream);

    expect(producers.size).toBe(1);
    expect(producers.has('audio')).toBe(true);
    expect(producers.has('video')).toBe(false);
    expect(transport.produce).toHaveBeenCalledTimes(1);
  });

  test('produces only video when no audio track', async () => {
    const transport = createMockTransport();
    const stream = createMockMediaStream([{ kind: 'video' }]);

    const producers = await produceLocalTracks(transport, stream);

    expect(producers.size).toBe(1);
    expect(producers.has('video')).toBe(true);
    expect(producers.has('audio')).toBe(false);
  });

  test('returns empty map when no tracks', async () => {
    const transport = createMockTransport();
    const stream = createMockMediaStream([]);

    const producers = await produceLocalTracks(transport, stream);

    expect(producers.size).toBe(0);
    expect(transport.produce).toHaveBeenCalledTimes(0);
  });
});
