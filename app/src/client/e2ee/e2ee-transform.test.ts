/**
 * Unit tests for {@link parseNegotiatedCodecs}.
 *
 * Validates that the SDP-driven codec source — used to wire E2EE transforms
 * because iOS Safari leaves `RTCRtpReceiver.getParameters().codecs` empty
 * right after SDP apply — picks the right codec per m-line.
 *
 * @module client/e2ee/e2ee-transform.test
 */

import { describe, test, expect } from 'bun:test';
import { parseNegotiatedCodecs } from './e2ee-transform';

/** Build a minimal SDP body around a given list of m-section blocks. */
function sdp(...mSections: string[]): string {
  return ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0', ...mSections].join('\r\n');
}

describe('parseNegotiatedCodecs', () => {
  test('opus + VP8 answer', () => {
    const result = parseNegotiatedCodecs(
      sdp(
        'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
        'a=rtpmap:111 opus/48000/2',
        'a=rtpmap:63 red/48000/2',
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
        'a=rtpmap:96 VP8/90000',
        'a=rtpmap:97 rtx/90000',
      ),
    );
    expect(result).toEqual({ audio: 'opus', video: 'vp8' });
  });

  test('H264 video throws (unsupported under E2EE; mesh enforces VP8)', () => {
    expect(() =>
      parseNegotiatedCodecs(
        sdp(
          'm=audio 9 UDP/TLS/RTP/SAVPF 111',
          'a=rtpmap:111 opus/48000/2',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'a=rtpmap:96 H264/90000',
        ),
      ),
    ).toThrow(/Unsupported codec mimeType/);
  });

  test('audio-only answer (no video m-line)', () => {
    const result = parseNegotiatedCodecs(
      sdp('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'),
    );
    expect(result).toEqual({ audio: 'opus' });
  });

  test('rejected video m-line (port=0) is ignored', () => {
    const result = parseNegotiatedCodecs(
      sdp(
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=rtpmap:111 opus/48000/2',
        'm=video 0 UDP/TLS/RTP/SAVPF 96',
        'a=rtpmap:96 VP8/90000',
      ),
    );
    expect(result).toEqual({ audio: 'opus' });
  });

  test('takes first PT in m-line, ignores subsequent rtpmap entries', () => {
    // First PT 96 → VP8. The 97/H264 line must not overwrite.
    const result = parseNegotiatedCodecs(
      sdp('m=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 H264/90000'),
    );
    expect(result).toEqual({ video: 'vp8' });
  });

  test('LF-only line endings (no CR) parse the same as CRLF', () => {
    const lf = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
    ].join('\n');
    expect(parseNegotiatedCodecs(lf)).toEqual({ audio: 'opus' });
  });

  test('throws on unsupported codec', () => {
    expect(() =>
      parseNegotiatedCodecs(sdp('m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 AV1/90000')),
    ).toThrow(/Unsupported codec mimeType/);
  });

  test('m=application (data channel) is ignored', () => {
    const result = parseNegotiatedCodecs(
      sdp(
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=rtpmap:111 opus/48000/2',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      ),
    );
    expect(result).toEqual({ audio: 'opus' });
  });
});
