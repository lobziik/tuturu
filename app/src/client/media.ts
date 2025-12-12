/**
 * Media stream management
 * Handles getUserMedia with mobile-friendly fallbacks
 */

import type { Action } from './state';

/**
 * Dispatch function type - all modules receive this to trigger state transitions
 */
type Dispatch = (action: Action) => void;

/**
 * Request user media (camera and microphone) with graceful fallbacks
 * Implements mobile-friendly constraint strategy:
 * 1. Try video (with ideal constraints) + audio
 * 2. Fallback to audio-only if camera unavailable
 * 3. FAIL if microphone unavailable (required for calls)
 *
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * Mobile Compatibility:
 * - iOS Safari: Uses "ideal" constraints (not "exact") to avoid OverconstrainedError
 * - Android Chrome: Hardware acceleration works with default constraints
 * - Audio-only fallback: Shows warning, disables video toggle button (handled in render)
 *
 * Error Handling:
 * - NotAllowedError → "Permission denied" (user clicked "Block")
 * - NotFoundError → "No microphone found" (hardware missing)
 * - NotReadableError → "Already in use" (another app using microphone)
 * - Other errors → Generic message with error details
 *
 * Dispatches:
 * - MEDIA_ACQUIRED on success (with audioOnly flag)
 * - MEDIA_ERROR on failure (with actionable error message)
 */
export async function getUserMedia(dispatch: Dispatch): Promise<void> {
  /**
   * Audio constraints optimized for voice calls
   * Echo cancellation and noise suppression improve call quality
   */
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
  };

  /**
   * Video constraints using "ideal" instead of "exact"
   * iOS Safari fails with exact constraints - ideal allows fallback
   */
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  // Try video + audio first
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

    // Try audio-only fallback
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      console.log('[MEDIA] Audio-only stream acquired (camera unavailable)');
      dispatch({ type: 'MEDIA_ACQUIRED', stream, audioOnly: true });
      return;
    } catch (audioError) {
      const audioErr = audioError as DOMException;

      // FAIL FAST with actionable error message
      const errorMessage = categorizeMediaError(audioErr);
      dispatch({ type: 'MEDIA_ERROR', error: errorMessage });
    }
  }
}

/**
 * Categorize getUserMedia errors into actionable user-facing messages
 * Follows FAIL FAST principle - errors are specific and tell user what to do
 *
 * @param error - DOMException from getUserMedia failure
 * @returns Human-readable error message with action items
 *
 * @remarks
 * Error types:
 * - NotAllowedError: User denied permission or browser blocked access
 * - NotFoundError: No microphone/camera hardware detected
 * - NotReadableError: Hardware exists but is in use by another app
 * - OverconstrainedError: Constraints too specific (shouldn't happen with "ideal")
 * - Other: Generic message with technical details for debugging
 */
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

/**
 * Stop all tracks in a media stream
 * Releases camera/microphone hardware
 *
 * @param stream - MediaStream to stop
 *
 * @remarks
 * Calling stop() on each track:
 * - Turns off camera LED indicator
 * - Releases hardware for other apps
 * - Prevents resource leaks
 * - Required for proper cleanup on hangup
 */
export function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop();
    console.log('[MEDIA] Stopped track:', track.kind);
  });

  // Reset facing mode for next call
  resetFacingMode();
}

/**
 * Check if device has multiple video input devices (cameras)
 * Used to determine whether to show flip camera button
 *
 * @returns Promise<boolean> - true if multiple cameras available
 *
 * @remarks
 * Edge Cases:
 * - Returns false if mediaDevices API unavailable
 * - Returns false if permission not yet granted (devices enumerated as empty labels)
 * - Mobile devices typically have 2+ cameras (front/back)
 * - Desktop may have external webcam + built-in
 */
export async function hasMultipleCameras(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return false;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === 'videoinput');
    return videoInputs.length > 1;
  } catch (error) {
    console.warn('[MEDIA] Failed to enumerate devices:', error);
    return false;
  }
}

/**
 * Current facing mode tracker
 * Needed because applyConstraints doesn't have a getter for facingMode
 */
let currentFacingMode: 'user' | 'environment' = 'user';

/**
 * Reset facing mode tracker
 * Called when media stream is stopped (on hangup)
 */
export function resetFacingMode(): void {
  currentFacingMode = 'user';
}

/**
 * Flip camera between front and back
 * Uses MediaStreamTrack.applyConstraints() for efficient switching with getUserMedia fallback
 *
 * @param stream - Current MediaStream with video track
 * @param pc - RTCPeerConnection to update with new track (optional)
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * Implementation Strategy:
 * 1. Try applyConstraints() first (fastest, no re-acquisition)
 * 2. Fall back to getUserMedia() if applyConstraints() fails
 *
 * iOS Safari Compatibility:
 * - Some iOS versions don't support applyConstraints() with facingMode
 * - Fallback to full getUserMedia() re-acquisition
 *
 * Track Replacement:
 * - Must replace track in RTCPeerConnection for peer to see new camera
 * - Uses RTCRtpSender.replaceTrack() (no renegotiation needed)
 *
 * Error Handling:
 * - Dispatch MEDIA_ERROR with actionable message on failure
 * - Log warnings for expected failures (device doesn't support constraint)
 */
export async function flipCamera(
  stream: MediaStream,
  pc: RTCPeerConnection | null,
  dispatch: Dispatch,
): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];

  if (!videoTrack) {
    // Audio-only mode - this should never be called, but fail fast if it is
    dispatch({
      type: 'MEDIA_ERROR',
      error: 'Cannot flip camera: No video track available',
    });
    return;
  }

  const newFacingMode: 'user' | 'environment' =
    currentFacingMode === 'user' ? 'environment' : 'user';

  console.log('[MEDIA] Flipping camera to:', newFacingMode);

  // Strategy 1: Try applyConstraints (efficient, no re-acquisition)
  try {
    await videoTrack.applyConstraints({
      facingMode: { exact: newFacingMode },
    });

    currentFacingMode = newFacingMode;
    console.log('[MEDIA] Camera flipped via applyConstraints');
    return;
  } catch (constraintError) {
    console.warn('[MEDIA] applyConstraints failed, falling back to getUserMedia:', constraintError);
  }

  // Strategy 2: Fallback to full getUserMedia re-acquisition
  try {
    // Stop current video track before acquiring new one
    videoTrack.stop();

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: newFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false, // Keep existing audio track
    });

    const newVideoTrack = newStream.getVideoTracks()[0];

    if (!newVideoTrack) {
      throw new Error('No video track in new stream');
    }

    // Replace track in original stream
    stream.removeTrack(videoTrack);
    stream.addTrack(newVideoTrack);

    // Replace track in peer connection (if connected)
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
