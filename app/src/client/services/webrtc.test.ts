/**
 * Unit tests for WebRTC service helpers.
 *
 * Currently focused on `applyE2eeTransformsWithConfig` and its handling of
 * rejected (port=0) m-lines — the critical case where a sender carries a
 * track but won't actually emit media. The function must not throw on that
 * path or the call fails on a perfectly legitimate audio-only-from-remote
 * scenario; AND must still throw on a genuine codec-mismatch.
 *
 * @module client/services/webrtc.test
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { applyE2eeTransformsWithConfig } from './webrtc';

// ============================================================================
// Test fixtures
// ============================================================================

/**
 * RTCRtpScriptTransform is a Web API not present in Bun's test runtime. The
 * sender/receiver wiring code does `new RTCRtpScriptTransform(worker, opts)`
 * and assigns the result to a `.transform` property — a no-op constructor
 * is enough to let those lines run without exercising the real transform.
 */
beforeAll(() => {
  (globalThis as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform =
    function MockRTCRtpScriptTransform(this: unknown, worker: unknown, options: unknown): unknown {
      return { worker, options };
    };
});

/** Build an SDP with audio + (optionally) video. Port=0 marks rejected. */
function buildSdp(opts: { audio?: 'opus' | null; video?: 'vp8' | null | 'rejected' }): string {
  const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0'];
  if (opts.audio === 'opus') {
    lines.push('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2');
  }
  if (opts.video === 'vp8') {
    lines.push('m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000');
  } else if (opts.video === 'rejected') {
    lines.push('m=video 0 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000');
  }
  return lines.join('\r\n');
}

interface MockTransceiver {
  mid: string | null;
  sender: { track: { kind: 'audio' | 'video' } | null };
  receiver: { track: { kind: 'audio' | 'video' } };
  currentDirection: RTCRtpTransceiverDirection | null;
}

function buildTransceiver(
  kind: 'audio' | 'video',
  currentDirection: RTCRtpTransceiverDirection | null,
  hasSenderTrack = true,
): MockTransceiver {
  return {
    mid: kind === 'audio' ? '0' : '1',
    sender: { track: hasSenderTrack ? { kind } : null },
    receiver: { track: { kind } },
    currentDirection,
  };
}

function buildPc(transceivers: MockTransceiver[]): RTCPeerConnection {
  // Cast through unknown — we only exercise getTransceivers() in this code
  // path and the mock supplies just enough of the WebRTC shape.
  return {
    getTransceivers: () => transceivers,
  } as unknown as RTCPeerConnection;
}

// ============================================================================
// Tests
// ============================================================================

describe('applyE2eeTransformsWithConfig', () => {
  const e2ee = {
    worker: {} as unknown as Worker,
    key: {} as unknown as CryptoKey,
  };

  test('audio sender + rejected video sender: audio wired, video silently skipped', () => {
    const audioTx = buildTransceiver('audio', 'sendrecv');
    const videoTx = buildTransceiver('video', 'inactive');
    const pc = buildPc([audioTx, videoTx]);

    expect(() =>
      applyE2eeTransformsWithConfig(pc, buildSdp({ audio: 'opus', video: 'rejected' }), e2ee),
    ).not.toThrow();

    // Audio sender got a transform attached, video sender did not.
    expect((audioTx.sender as { transform?: unknown }).transform).toBeDefined();
    expect((videoTx.sender as { transform?: unknown }).transform).toBeUndefined();
  });

  test('video sender with track but currentDirection=sendrecv and no codec: throws', () => {
    // Genuine SDP defect: m=video present and active, but no rtpmap match.
    // The function should fail loud rather than silently skip — the call
    // can't proceed without the codec on a sending transceiver.
    const audioTx = buildTransceiver('audio', 'sendrecv');
    const videoTx = buildTransceiver('video', 'sendrecv');
    const pc = buildPc([audioTx, videoTx]);

    expect(() =>
      applyE2eeTransformsWithConfig(pc, buildSdp({ audio: 'opus', video: null }), e2ee),
    ).toThrow(/no negotiated codec/);
  });

  test('audio-only call (no video m-line at all): does not throw', () => {
    const audioTx = buildTransceiver('audio', 'sendrecv');
    const pc = buildPc([audioTx]);

    expect(() =>
      applyE2eeTransformsWithConfig(pc, buildSdp({ audio: 'opus', video: null }), e2ee),
    ).not.toThrow();
    expect((audioTx.sender as { transform?: unknown }).transform).toBeDefined();
  });

  test('rejected video receiver-only transceiver (no sender track): no throw', () => {
    // Recvonly transceiver with no local sender track + remote rejected
    // m-line. Receiver branch already handled this correctly; lock it in
    // alongside the sender-side fix.
    const recvOnlyVideo = buildTransceiver('video', 'inactive', /* hasSenderTrack */ false);
    const pc = buildPc([recvOnlyVideo]);

    expect(() =>
      applyE2eeTransformsWithConfig(pc, buildSdp({ video: 'rejected' }), e2ee),
    ).not.toThrow();
  });
});
