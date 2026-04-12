/**
 * Media codec configuration for SFU routers.
 *
 * Defines the codecs that mediasoup routers will support.
 * Opus for audio, VP8 for video — widest browser compatibility.
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
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];
