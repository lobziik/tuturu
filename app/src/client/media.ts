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
}
