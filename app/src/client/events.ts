/**
 * DOM event listeners
 * Wires up UI interactions to dispatch state machine actions
 */

import type { Action } from './state';

/**
 * Dispatch function type - all modules receive this to trigger state transitions
 */
type Dispatch = (action: Action) => void;

/**
 * Setup all DOM event listeners
 * Should be called once on application initialization
 *
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * Event listeners:
 * - PIN form submission → SUBMIT_PIN (with validation)
 * - Mute button → TOGGLE_MUTE
 * - Video button → TOGGLE_VIDEO
 * - Hangup button → HANGUP
 *
 * All handlers dispatch actions instead of modifying state directly
 * This makes the data flow unidirectional and predictable
 */
export function setupEventListeners(dispatch: Dispatch): void {
  const pinForm = document.getElementById('pin-form') as HTMLFormElement;
  const pinInput = document.getElementById('pin-input') as HTMLInputElement;
  const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
  const videoBtn = document.getElementById('video-btn') as HTMLButtonElement;
  const hangupBtn = document.getElementById('hangup-btn') as HTMLButtonElement;

  /**
   * PIN form submission handler
   * Validates PIN format (6 digits) before dispatching action
   *
   * @remarks
   * Validation:
   * - Must be exactly 6 digits
   * - No letters or special characters
   * - Server also validates (defense in depth)
   *
   * Error handling:
   * - Invalid PIN → Dispatches MEDIA_ERROR (reuses error mechanism)
   * - Valid PIN → Dispatches SUBMIT_PIN (triggers connection flow)
   */
  pinForm.addEventListener('submit', (e: SubmitEvent) => {
    e.preventDefault();

    const pin = pinInput.value.trim();

    // Validate PIN format
    if (!/^\d{6}$/.test(pin)) {
      dispatch({
        type: 'MEDIA_ERROR', // Reuse error mechanism
        error: 'PIN must be exactly 6 digits',
      });
      return;
    }

    dispatch({ type: 'SUBMIT_PIN', pin });
  });

  /**
   * Mute/unmute button handler
   * Toggles audio track enabled state
   *
   * @remarks
   * State machine handles:
   * - Ignoring toggle in non-call states
   * - Updating muted flag in state
   * Effects module handles:
   * - Actually enabling/disabling audio track
   * Render module handles:
   * - Updating button appearance (icon, label)
   */
  muteBtn.addEventListener('click', () => {
    dispatch({ type: 'TOGGLE_MUTE' });
  });

  /**
   * Video on/off button handler
   * Toggles video track enabled state
   *
   * @remarks
   * State machine handles:
   * - Ignoring toggle in non-call states
   * - Updating videoOff flag in state
   * Effects module handles:
   * - Actually enabling/disabling video track
   * Render module handles:
   * - Updating button appearance (icon, label)
   * - Disabling button in audio-only mode
   */
  videoBtn.addEventListener('click', () => {
    dispatch({ type: 'TOGGLE_VIDEO' });
  });

  /**
   * Hangup button handler
   * Ends call and returns to PIN entry screen
   *
   * @remarks
   * State machine handles:
   * - Transitioning to pin-entry screen
   * Effects module handles:
   * - Sending leave message to server
   * - Closing WebSocket with intentional flag
   * - Closing peer connection
   * - Stopping media streams
   */
  hangupBtn.addEventListener('click', () => {
    dispatch({ type: 'HANGUP' });
  });
}
