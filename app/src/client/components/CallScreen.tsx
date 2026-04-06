/**
 * Call screen — handles waiting-for-peer, negotiating, and call states.
 * Renders full-screen video interface with controls.
 *
 * @module components/CallScreen
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Screen } from '../state/types';
import type { Dispatch } from '../state/context';
import { hasMultipleCameras } from '../services/media';
import { setupPipDrag, cleanupPipDrag } from '../services/pip-drag';

/** Screen types that this component handles */
type CallScreenState = Extract<
  Screen,
  { type: 'waiting-for-peer' } | { type: 'negotiating' } | { type: 'call' }
>;

interface CallScreenProps {
  screen: CallScreenState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  dispatch: Dispatch;
}

/** Full-screen call interface for waiting, negotiating, and active call states */
export function CallScreen({ screen, localStream, remoteStream, dispatch }: CallScreenProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const statusBarRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [hasMultiCams, setHasMultiCams] = useState(false);
  const statusHideTimeoutRef = useRef<number | null>(null);

  const isCall = screen.type === 'call';
  const isNegotiating = screen.type === 'negotiating';
  const isWaiting = screen.type === 'waiting-for-peer';

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

  // Set remote video srcObject
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

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

  const statusText = isWaiting
    ? 'Waiting for peer...'
    : isNegotiating
      ? (screen as Extract<Screen, { type: 'negotiating' }>).role === 'caller'
        ? 'Calling peer...'
        : 'Answering call...'
      : 'Connected';

  const isAudioOnly = localStream !== null && localStream.getVideoTracks().length === 0;
  const showFlip = isCall && hasMultiCams && !screen.videoOff && !isAudioOnly;
  const layoutClass = isMobile ? 'mobile-call' : 'desktop-call';

  return (
    <div id="call-interface" class={layoutClass}>
      <div class="status-bar" id="status-bar" ref={statusBarRef}>
        <span id="status-text">{statusText}</span>
      </div>

      <div class="video-container">
        <video id="remote-video" ref={remoteVideoRef} autoplay playsinline />
        <video
          id="local-video"
          ref={localVideoRef}
          autoplay
          playsinline
          muted
          class={screen.pipHidden ? 'pip-hidden' : ''}
          style={isAudioOnly ? 'display: none' : ''}
        />
        {(isWaiting || isNegotiating) && (
          <div class="waiting-overlay">
            <span class="waiting-overlay-text">
              {isWaiting ? 'WAITING FOR PEER' : 'CONNECTING TO PEER'}
            </span>
          </div>
        )}
      </div>

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
          title={isAudioOnly ? 'No camera available' : 'Video On/Off'}
          disabled={isAudioOnly}
          style={isAudioOnly ? 'opacity: 0.5' : ''}
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
    </div>
  );
}
