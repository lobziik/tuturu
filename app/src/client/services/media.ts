/**
 * Media stream management
 * Handles getUserMedia with mobile-friendly fallbacks
 */

import type { Action } from '../state/types';

type Dispatch = (action: Action) => void;

/**
 * Request user media (camera + microphone) with graceful fallbacks.
 * 1. Try video + audio
 * 2. Fallback to audio-only if camera unavailable
 * 3. FAIL if microphone unavailable
 */
export async function getUserMedia(dispatch: Dispatch): Promise<void> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
  };

  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints,
    });
    console.log('[MEDIA] Video + audio stream acquired');
    dispatch({ type: 'MEDIA_ACQUIRED', stream, audioOnly: false });
    return;
  } catch (error) {
    const err = error as DOMException;
    console.warn('[MEDIA] Failed to get video+audio:', err.name);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      console.log('[MEDIA] Audio-only stream acquired (camera unavailable)');
      dispatch({ type: 'MEDIA_ACQUIRED', stream, audioOnly: true });
      return;
    } catch (audioError) {
      const audioErr = audioError as DOMException;
      const errorMessage = categorizeMediaError(audioErr);
      dispatch({ type: 'MEDIA_ERROR', error: errorMessage });
    }
  }
}

function categorizeMediaError(error: DOMException): string {
  switch (error.name) {
    case 'NotAllowedError':
      return 'Microphone permission denied. Please allow access and try again.';
    case 'NotFoundError':
      return 'No microphone found. Please connect a microphone and try again.';
    case 'NotReadableError':
      return 'Microphone is already in use by another application.';
    case 'OverconstrainedError':
      return 'Camera/microphone does not meet requirements. Try a different device.';
    default:
      return `Failed to get microphone: ${error.message}`;
  }
}

/** Stop all tracks in a media stream (releases camera/mic hardware) */
export function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop();
    console.log('[MEDIA] Stopped track:', track.kind);
  });
  resetFacingMode();
}

/** Check if device has multiple video input devices (cameras) */
export async function hasMultipleCameras(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) return false;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === 'videoinput');
    return videoInputs.length > 1;
  } catch (error) {
    console.warn('[MEDIA] Failed to enumerate devices:', error);
    return false;
  }
}

let currentFacingMode: 'user' | 'environment' = 'user';

function resetFacingMode(): void {
  currentFacingMode = 'user';
}

/** Flip camera between front and back with applyConstraints fallback to getUserMedia */
export async function flipCamera(
  stream: MediaStream,
  pc: RTCPeerConnection | null,
  dispatch: Dispatch,
): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];

  if (!videoTrack) {
    dispatch({
      type: 'MEDIA_ERROR',
      error: 'Cannot flip camera: No video track available',
    });
    return;
  }

  const newFacingMode: 'user' | 'environment' =
    currentFacingMode === 'user' ? 'environment' : 'user';

  console.log('[MEDIA] Flipping camera to:', newFacingMode);

  try {
    await videoTrack.applyConstraints({ facingMode: { exact: newFacingMode } });
    currentFacingMode = newFacingMode;
    console.log('[MEDIA] Camera flipped via applyConstraints');
    return;
  } catch (constraintError) {
    console.warn('[MEDIA] applyConstraints failed, falling back to getUserMedia:', constraintError);
  }

  try {
    videoTrack.stop();
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: newFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) throw new Error('No video track in new stream');

    stream.removeTrack(videoTrack);
    stream.addTrack(newVideoTrack);

    if (pc) {
      const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(newVideoTrack);
        console.log('[MEDIA] Replaced track in peer connection');
      }
    }

    currentFacingMode = newFacingMode;
    console.log('[MEDIA] Camera flipped via getUserMedia fallback');
  } catch (error) {
    const err = error as DOMException;
    console.error('[MEDIA] Failed to flip camera:', err);
    dispatch({
      type: 'MEDIA_ERROR',
      error: `Failed to switch camera: ${err.message}. Try again or use current camera.`,
    });
  }
}
