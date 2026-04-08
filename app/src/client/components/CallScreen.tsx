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
import {
  MicrophoneIcon,
  SpeakerXMarkIcon,
  VideoCameraIcon,
  VideoCameraSlashIcon,
  EyeIcon,
  EyeSlashIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  PhoneXMarkIcon,
} from '@heroicons/react/24/solid';

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
      if (bar) bar.classList.remove('status-hidden');
      statusHideTimeoutRef.current = window.setTimeout(() => {
        if (bar) bar.classList.add('status-hidden');
        statusHideTimeoutRef.current = null;
      }, 3000);
    } else {
      if (statusHideTimeoutRef.current !== null) {
        clearTimeout(statusHideTimeoutRef.current);
        statusHideTimeoutRef.current = null;
      }
      const bar = statusBarRef.current;
      if (bar) bar.classList.remove('status-hidden');
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

  // ── Shared elements ──────────────────────────────────────────────────

  const videoContainer = (
    <div class="absolute inset-0">
      {/* Remote video */}
      <video
        id="remote-video"
        ref={remoteVideoRef}
        autoplay
        playsinline
        class="w-full h-full object-cover"
      />

      {/* Local video (PiP) */}
      <video
        id="local-video"
        ref={localVideoRef}
        autoplay
        playsinline
        muted
        class={
          'absolute top-0 left-0 w-40 max-h-30 aspect-4/3 rounded-xl ' +
          'border-2 border-white/30 shadow-lg object-cover cursor-grab touch-none ' +
          'select-none will-change-[left,top] z-5' +
          (screen.pipHidden ? ' pip-hidden' : '')
        }
        style={isAudioOnly ? 'display: none' : ''}
      />

      {/* Waiting / negotiating overlay */}
      {(isWaiting || isNegotiating) && (
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-4">
          <span
            class="text-2xl font-bold text-white/90 uppercase tracking-wider bg-black/40 px-8 py-4 rounded-lg backdrop-blur-sm"
            style="text-shadow: 0 2px 8px rgba(0,0,0,0.6)"
          >
            {isWaiting ? 'WAITING FOR PEER' : 'CONNECTING TO PEER'}
          </span>
        </div>
      )}
    </div>
  );

  // ── Mobile layout ────────────────────────────────────────────────────

  if (isMobile) {
    return (
      <div
        id="call-interface"
        class="fixed inset-0 z-100 bg-black h-screen"
        style="height: 100svh; height: 100dvh"
      >
        {videoContainer}

        {/* Status bar — mobile */}
        <div
          id="status-bar"
          ref={statusBarRef}
          class={
            'absolute top-0 right-0 p-4 pt-safe pr-safe ' +
            'bg-linear-to-b from-black/70 to-transparent ' +
            'border-none rounded-none z-10 transition-opacity duration-300 text-right'
          }
        >
          <span id="status-text" class="font-semibold text-white">
            {statusText}
          </span>
        </div>

        {/* Controls — mobile circular buttons */}
        <div class="absolute bottom-safe-8 inset-x-0 flex justify-center gap-5 px-4 z-10 flex-nowrap">
          {/* Mute */}
          <button
            id="mute-btn"
            class={
              'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
              'backdrop-blur-md border border-white/20 ' +
              (screen.muted ? 'bg-red-500/80 text-white' : 'bg-slate-800/80 text-white')
            }
            title={screen.muted ? 'Unmute' : 'Mute'}
            onClick={() => dispatch({ type: 'TOGGLE_MUTE' })}
          >
            {screen.muted ? <SpeakerXMarkIcon class="size-5" /> : <MicrophoneIcon class="size-5" />}
          </button>

          {/* Video toggle */}
          <button
            id="video-btn"
            class={
              'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
              'backdrop-blur-md border border-white/20 ' +
              (screen.videoOff ? 'bg-red-500/80 text-white' : 'bg-slate-800/80 text-white')
            }
            title={isAudioOnly ? 'No camera available' : 'Video On/Off'}
            disabled={isAudioOnly}
            style={isAudioOnly ? 'opacity: 0.5' : ''}
            onClick={() => dispatch({ type: 'TOGGLE_VIDEO' })}
          >
            {screen.videoOff ? (
              <VideoCameraSlashIcon class="size-5" />
            ) : (
              <VideoCameraIcon class="size-5" />
            )}
          </button>

          {/* PiP toggle */}
          <button
            id="pip-toggle-btn"
            class={
              'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
              'bg-slate-800/80 backdrop-blur-md border border-white/20 text-white'
            }
            title="Toggle Preview"
            onClick={() => dispatch({ type: 'TOGGLE_PIP_VISIBILITY' })}
          >
            {screen.pipHidden ? <EyeIcon class="size-5" /> : <EyeSlashIcon class="size-5" />}
          </button>

          {/* Flip camera */}
          {showFlip && (
            <button
              id="flip-btn"
              class={
                'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
                'bg-slate-800/80 backdrop-blur-md border border-white/20 text-white'
              }
              title="Flip Camera"
              onClick={() => dispatch({ type: 'FLIP_CAMERA' })}
            >
              <ArrowPathIcon class="size-5" />
            </button>
          )}

          {/* Minimize */}
          <button
            class={
              'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
              'bg-slate-800/80 backdrop-blur-md border border-white/20 text-white'
            }
            title="Minimize to chat"
            onClick={() => dispatch({ type: 'SWITCH_TO_CHAT' })}
          >
            <ChevronDownIcon class="size-5" />
          </button>

          {/* Hang up */}
          <button
            id="hangup-btn"
            class={
              'size-14 rounded-full p-0 flex flex-col items-center justify-center ' +
              'bg-red-500/90 hover:bg-red-600/95 backdrop-blur-md border border-white/20 text-white'
            }
            title="Hang Up"
            onClick={() => dispatch({ type: 'HANGUP' })}
          >
            <PhoneXMarkIcon class="size-5" />
          </button>
        </div>
      </div>
    );
  }

  // ── Desktop layout ───────────────────────────────────────────────────

  return (
    <div id="call-interface" class="fixed inset-0 z-100 bg-black">
      {videoContainer}

      {/* Status bar — desktop */}
      <div
        id="status-bar"
        ref={statusBarRef}
        class={
          'absolute top-4 right-4 px-4 py-3 ' +
          'bg-slate-800/85 backdrop-blur-md border border-white/10 ' +
          'rounded-lg z-10 transition-opacity duration-300'
        }
      >
        <span id="status-text" class="font-semibold text-white">
          {statusText}
        </span>
      </div>

      {/* Controls bar — desktop */}
      <div
        class={
          'absolute bottom-8 left-1/2 -translate-x-1/2 ' +
          'bg-slate-800/85 backdrop-blur-md border border-white/10 ' +
          'rounded-2xl p-4 z-10 flex justify-center gap-4'
        }
      >
        {/* Mute */}
        <button
          id="mute-btn"
          class={
            'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
            'border min-w-25 rounded-lg cursor-pointer transition-colors ' +
            (screen.muted
              ? 'bg-danger border-danger hover:bg-danger-dark'
              : 'bg-surface-light border-surface-border hover:bg-surface-border')
          }
          title={screen.muted ? 'Unmute' : 'Mute'}
          onClick={() => dispatch({ type: 'TOGGLE_MUTE' })}
        >
          {screen.muted ? <SpeakerXMarkIcon class="size-6" /> : <MicrophoneIcon class="size-6" />}
          <span class="text-sm">{screen.muted ? 'Unmute' : 'Mute'}</span>
        </button>

        {/* Video toggle */}
        <button
          id="video-btn"
          class={
            'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
            'border min-w-25 rounded-lg cursor-pointer transition-colors ' +
            (screen.videoOff
              ? 'bg-danger border-danger hover:bg-danger-dark'
              : 'bg-surface-light border-surface-border hover:bg-surface-border')
          }
          title={isAudioOnly ? 'No camera available' : 'Video On/Off'}
          disabled={isAudioOnly}
          style={isAudioOnly ? 'opacity: 0.5' : ''}
          onClick={() => dispatch({ type: 'TOGGLE_VIDEO' })}
        >
          {screen.videoOff ? (
            <VideoCameraSlashIcon class="size-6" />
          ) : (
            <VideoCameraIcon class="size-6" />
          )}
          <span class="text-sm">{screen.videoOff ? 'Video On' : 'Video Off'}</span>
        </button>

        {/* PiP toggle */}
        <button
          id="pip-toggle-btn"
          class={
            'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
            'bg-surface-light border border-surface-border min-w-25 rounded-lg ' +
            'cursor-pointer transition-colors hover:bg-surface-border'
          }
          title="Toggle Preview"
          onClick={() => dispatch({ type: 'TOGGLE_PIP_VISIBILITY' })}
        >
          {screen.pipHidden ? <EyeIcon class="size-6" /> : <EyeSlashIcon class="size-6" />}
          <span class="text-sm">{screen.pipHidden ? 'Show' : 'Hide'}</span>
        </button>

        {/* Flip camera */}
        {showFlip && (
          <button
            id="flip-btn"
            class={
              'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
              'bg-surface-light border border-surface-border min-w-25 rounded-lg ' +
              'cursor-pointer transition-colors hover:bg-surface-border'
            }
            title="Flip Camera"
            onClick={() => dispatch({ type: 'FLIP_CAMERA' })}
          >
            <ArrowPathIcon class="size-6" />
            <span class="text-sm">Flip</span>
          </button>
        )}

        {/* Minimize */}
        <button
          class={
            'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
            'bg-surface-light border border-surface-border min-w-25 rounded-lg ' +
            'cursor-pointer transition-colors hover:bg-surface-border'
          }
          title="Minimize to chat"
          onClick={() => dispatch({ type: 'SWITCH_TO_CHAT' })}
        >
          <ChevronDownIcon class="size-6" />
          <span class="text-sm">Minimize</span>
        </button>

        {/* Hang up */}
        <button
          id="hangup-btn"
          class={
            'flex flex-col items-center gap-2 px-6 py-4 text-txt ' +
            'bg-danger border border-danger min-w-25 rounded-lg ' +
            'cursor-pointer transition-colors hover:bg-danger-dark'
          }
          title="Hang Up"
          onClick={() => dispatch({ type: 'HANGUP' })}
        >
          <PhoneXMarkIcon class="size-6" />
          <span class="text-sm">Hang Up</span>
        </button>
      </div>
    </div>
  );
}
