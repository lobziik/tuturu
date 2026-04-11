/**
 * Call screen — handles waiting-for-peer and call states for mesh video.
 * Renders full-screen video interface with responsive grid layout and controls.
 *
 * Grid layout by remote peer count:
 * - 1: single tile, full container
 * - 2: 1x2 vertical stack
 * - 3-4: 2x2 grid
 * - 5: 3x2 grid
 *
 * @module components/CallScreen
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Screen, PeerConnectionStatus } from '../state/types';
import type { PeerState } from '../../shared/types';
import type { Dispatch } from '../state/context';
import { hasMultipleCameras } from '../services/media';
import { setupPipDrag, cleanupPipDrag } from '../services/pip-drag';
import { VideoTile } from './VideoTile';

/** Screen types that this component handles */
type CallScreenState = Extract<Screen, { type: 'waiting-for-peer' } | { type: 'call' }>;

interface CallScreenProps {
  screen: CallScreenState;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  peerConnectionStates: Record<string, PeerConnectionStatus>;
  /** Room peers (for nickname resolution) */
  peers: Record<string, PeerState>;
  dispatch: Dispatch;
}

/** Derive the status bar text from call state */
function getStatusText(isWaiting: boolean, connectedCount: number): string {
  if (isWaiting) return 'Waiting for peers...';
  if (connectedCount === 0) return 'Connecting...';
  return `${connectedCount + 1} in call`;
}

/** Remote video grid or waiting overlay when no peers */
function VideoArea({
  remotePeerIds,
  remoteStreams,
  peerConnectionStates,
  peers,
}: Readonly<{
  remotePeerIds: string[];
  remoteStreams: Map<string, MediaStream>;
  peerConnectionStates: Record<string, PeerConnectionStatus>;
  peers: Record<string, PeerState>;
}>) {
  if (remotePeerIds.length === 0) {
    return (
      <div class="waiting-overlay">
        <span class="waiting-overlay-text">WAITING FOR PEERS</span>
      </div>
    );
  }

  return (
    <div class="video-grid" data-count={remotePeerIds.length}>
      {remotePeerIds.map((peerId) => (
        <VideoTile
          key={peerId}
          peerId={peerId}
          stream={remoteStreams.get(peerId) ?? null}
          connectionStatus={peerConnectionStates[peerId] ?? 'connecting'}
          nickname={peers[peerId]?.nickname}
        />
      ))}
    </div>
  );
}

/** Call control button bar */
function CallControls({
  screen,
  showFlip,
  dispatch,
}: Readonly<{
  screen: CallScreenState;
  showFlip: boolean;
  dispatch: Dispatch;
}>) {
  return (
    <div class="controls">
      <button
        id="mute-btn"
        class={`control-btn ${screen.muted ? 'active' : ''}`}
        title={screen.muted ? 'Unmute' : 'Mute'}
        onClick={() => dispatch({ type: 'TOGGLE_MUTE' })}
      >
        <span class="icon">{screen.muted ? '\uD83D\uDD07' : '\uD83C\uDF99'}</span>
        <span class="label">{screen.muted ? 'Unmute' : 'Mute'}</span>
      </button>

      <button
        id="video-btn"
        class={`control-btn ${screen.videoOff ? 'active' : ''}`}
        title="Video On/Off"
        onClick={() => dispatch({ type: 'TOGGLE_VIDEO' })}
      >
        <span class="icon">{screen.videoOff ? '\uD83D\uDEAB' : '\uD83D\uDCF9'}</span>
        <span class="label">{screen.videoOff ? 'Video On' : 'Video Off'}</span>
      </button>

      <button
        id="pip-toggle-btn"
        class="control-btn visible"
        title="Toggle Preview"
        onClick={() => dispatch({ type: 'TOGGLE_PIP_VISIBILITY' })}
      >
        <span class="icon">{screen.pipHidden ? '\uD83D\uDC41' : '\uD83D\uDC64'}</span>
        <span class="label">{screen.pipHidden ? 'Show' : 'Hide'}</span>
      </button>

      {showFlip && (
        <button
          id="flip-btn"
          class="control-btn visible"
          title="Flip Camera"
          onClick={() => dispatch({ type: 'FLIP_CAMERA' })}
        >
          <span class="icon">{'\uD83D\uDD04'}</span>
          <span class="label">Flip</span>
        </button>
      )}

      <button
        class="control-btn"
        title="Minimize to chat"
        onClick={() => dispatch({ type: 'SWITCH_TO_CHAT' })}
      >
        <span class="icon">{'\u2B07'}</span>
        <span class="label">Minimize</span>
      </button>

      <button
        id="hangup-btn"
        class="control-btn danger"
        title="Hang Up"
        onClick={() => dispatch({ type: 'HANGUP' })}
      >
        <span class="icon">{'\uD83D\uDCDE'}</span>
        <span class="label">Hang Up</span>
      </button>
    </div>
  );
}

/** Full-screen call interface for waiting and active call states */
export function CallScreen({
  screen,
  localStream,
  remoteStreams,
  peerConnectionStates,
  peers,
  dispatch,
}: Readonly<CallScreenProps>) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const statusBarRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [hasMultiCams, setHasMultiCams] = useState(false);
  const statusHideTimeoutRef = useRef<number | null>(null);

  const isCall = screen.type === 'call';
  const isWaiting = screen.type === 'waiting-for-peer';

  const remotePeerIds = Object.keys(peerConnectionStates);
  const connectedCount = Object.values(peerConnectionStates).filter(
    (s) => s === 'connected',
  ).length;

  // Responsive layout
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  // Check camera count
  useEffect(() => {
    void hasMultipleCameras().then(setHasMultiCams);
  }, []);

  // Set local video srcObject
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // PiP drag
  useEffect(() => {
    if (localVideoRef.current) {
      setupPipDrag(localVideoRef.current);
    }
    return () => cleanupPipDrag();
  }, []);

  // Status bar auto-hide on mobile during call
  useEffect(() => {
    if (isCall && isMobile) {
      if (statusHideTimeoutRef.current !== null) clearTimeout(statusHideTimeoutRef.current);
      const bar = statusBarRef.current;
      if (bar) bar.classList.remove('hidden-overlay');
      statusHideTimeoutRef.current = window.setTimeout(() => {
        if (bar) bar.classList.add('hidden-overlay');
        statusHideTimeoutRef.current = null;
      }, 3000);
    } else {
      if (statusHideTimeoutRef.current !== null) {
        clearTimeout(statusHideTimeoutRef.current);
        statusHideTimeoutRef.current = null;
      }
      const bar = statusBarRef.current;
      if (bar) bar.classList.remove('hidden-overlay');
    }
    return () => {
      if (statusHideTimeoutRef.current !== null) {
        clearTimeout(statusHideTimeoutRef.current);
        statusHideTimeoutRef.current = null;
      }
    };
  }, [isCall, isMobile]);

  const statusText = getStatusText(isWaiting, connectedCount);
  const isAudioOnly = localStream !== null && localStream.getVideoTracks().length === 0;
  const showFlip = isCall && hasMultiCams && !screen.videoOff && !isAudioOnly;
  const layoutClass = isMobile ? 'mobile-call' : 'desktop-call';

  return (
    <div id="call-interface" class={layoutClass}>
      <div class="status-bar" id="status-bar" ref={statusBarRef}>
        <span id="status-text">{statusText}</span>
      </div>

      <div class="video-container">
        <VideoArea
          remotePeerIds={remotePeerIds}
          remoteStreams={remoteStreams}
          peerConnectionStates={peerConnectionStates}
          peers={peers}
        />

        {/* Local video PiP overlay */}
        <video
          id="local-video"
          ref={localVideoRef}
          autoplay
          playsinline
          muted
          class={screen.pipHidden ? 'pip-hidden' : ''}
          style={isAudioOnly ? 'display: none' : ''}
        />
      </div>

      <CallControls screen={screen} showFlip={showFlip} dispatch={dispatch} />
    </div>
  );
}
