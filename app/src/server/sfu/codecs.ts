/**
 * Media codec configuration for SFU routers.
 *
 * Opus for audio, VP8 for video. H264 is intentionally excluded — see the
 * commented-out entry below for why.
 *
 * @module server/sfu/codecs
 */

import type { types as mediasoupTypes } from 'mediasoup';

/** Media codecs supported by SFU routers. */
export const MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  // H264 deliberately omitted from the SFU. iOS Safari's H264 path
  // misbehaves under E2EE — RTCEncodedVideoFrame.type classification is
  // not consistent with Chrome's, which breaks AAD validation and drops
  // every frame as crypto-failed (see e2ee-worker.ts H264 branch). VP8
  // is reliable across all browsers we care about; the battery cost on
  // iOS without hardware H264 is the trade-off we take. The mesh path
  // still has to handle H264 because two iPhones will negotiate it
  // peer-to-peer, but the SFU router gets to pick the safer codec set.
  // {
  //   kind: 'video',
  //   mimeType: 'video/H264',
  //   clockRate: 90000,
  //   parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  // },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];
