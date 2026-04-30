/**
 * Video tile — renders a single peer's video stream with connection status overlay.
 * Used in the video grid for mesh calls.
 *
 * @module components/VideoTile
 */

import { useEffect, useRef } from 'preact/hooks';
import type { PeerConnectionStatus } from '../state/types';

interface VideoTileProps {
  /** Remote peer's ID */
  peerId: string;
  /** Remote peer's media stream (null if not yet received) */
  stream: MediaStream | null;
  /** WebRTC connection status for this peer */
  connectionStatus: PeerConnectionStatus;
  /** Decrypted display name (undefined if not yet resolved) */
  nickname: string | undefined;
  /** Whether this peer is the current active speaker (SFU mode) */
  isActiveSpeaker?: boolean;
}

/** Single peer video tile with connection status overlay and nickname label */
export function VideoTile({
  peerId,
  stream,
  connectionStatus,
  nickname,
  isActiveSpeaker,
}: Readonly<VideoTileProps>) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      // iOS Safari does not auto-start playback of MediaStreams assembled
      // outside RTCPeerConnection.ontrack (SFU path uses new MediaStream() +
      // addTrack). Explicit play() kicks it off; autoplay-policy rejection
      // is expected and benign, but other rejections (decode errors, lost
      // permission) deserve at least a console breadcrumb.
      void videoRef.current.play().catch((err: unknown) => {
        console.debug('[VideoTile] play() rejected:', err);
      });
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  const isConnected = connectionStatus === 'connected';
  const hasVideo = stream !== null && stream.getVideoTracks().length > 0;
  const displayName = nickname ?? peerId.slice(0, 8);

  return (
    <div class={`video-tile${isActiveSpeaker ? ' active-speaker' : ''}`}>
      <video
        ref={videoRef}
        autoplay
        playsinline
        class={`video-tile-video ${!isConnected || !hasVideo ? 'hidden-video' : ''}`}
      />
      {!isConnected && (
        <div class="video-tile-status">
          <span class="video-tile-status-text">
            {connectionStatus === 'connecting' && 'Connecting...'}
            {connectionStatus === 'disconnected' && 'Reconnecting...'}
            {connectionStatus === 'failed' && 'Connection failed'}
          </span>
        </div>
      )}
      <div class="video-tile-label">
        <span class="video-tile-name">{displayName}</span>
      </div>
    </div>
  );
}
