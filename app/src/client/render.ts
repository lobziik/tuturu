/**
 * DOM rendering - single source of truth for UI synchronization
 * All DOM updates go through this module based on state
 */

import type { AppState } from './state';
import { hasMultipleCameras } from './media';
import { setupPipDrag, cleanupPipDrag } from './pip-drag';

/**
 * DOM element references
 * Queried once at module load for performance
 */
const elements = {
  pinEntry: document.getElementById('pin-entry') as HTMLDivElement,
  callInterface: document.getElementById('call-interface') as HTMLDivElement,
  statusText: document.getElementById('status-text') as HTMLSpanElement,
  statusBar: document.getElementById('status-bar') as HTMLDivElement,
  pinDisplay: document.getElementById('pin-display') as HTMLSpanElement,
  localVideo: document.getElementById('local-video') as HTMLVideoElement,
  remoteVideo: document.getElementById('remote-video') as HTMLVideoElement,
  muteBtn: document.getElementById('mute-btn') as HTMLButtonElement,
  videoBtn: document.getElementById('video-btn') as HTMLButtonElement,
  flipBtn: document.getElementById('flip-btn') as HTMLButtonElement,
  hangupBtn: document.getElementById('hangup-btn') as HTMLButtonElement,
  errorDisplay: document.getElementById('error-display') as HTMLDivElement,
  errorMessage: document.getElementById('error-message') as HTMLSpanElement,
  connectBtn: document.getElementById('connect-btn') as HTMLButtonElement,
  pinInput: document.getElementById('pin-input') as HTMLInputElement,
  pipToggleBtn: document.getElementById('pip-toggle-btn') as HTMLButtonElement,
  waitingOverlay: document.getElementById('waiting-overlay') as HTMLDivElement,
};

/**
 * Check if viewport is mobile size
 * Used for conditional rendering of mobile-specific UI
 */
function isMobileViewport(): boolean {
  return window.innerWidth < 768;
}

/**
 * Status bar auto-hide timeout ID
 * Cleared on state transition to prevent orphan timers
 */
let statusHideTimeoutId: number | null = null;

/**
 * Start auto-hide timer for status bar on mobile
 * Shows status for 3 seconds then fades out
 */
function startStatusAutoHide(): void {
  // Clear any existing timeout
  if (statusHideTimeoutId !== null) {
    clearTimeout(statusHideTimeoutId);
  }

  // Ensure visible initially
  elements.statusBar.classList.remove('hidden-overlay');

  // Hide after 3 seconds
  statusHideTimeoutId = window.setTimeout(() => {
    elements.statusBar.classList.add('hidden-overlay');
    statusHideTimeoutId = null;
  }, 3000);
}

/**
 * Update flip button visibility based on camera count
 * Called asynchronously since enumerateDevices is async
 *
 * @param state - Current app state
 */
async function updateFlipButtonVisibility(state: AppState): Promise<void> {
  const hasMultiple = await hasMultipleCameras();

  if (hasMultiple && state.screen.type === 'call' && !state.screen.videoOff) {
    elements.flipBtn.classList.add('visible');
    elements.flipBtn.disabled = false;
  } else {
    elements.flipBtn.classList.remove('visible');
    elements.flipBtn.disabled = true;
  }
}

/**
 * Handle viewport resize (orientation change, etc.)
 * Updates mobile/desktop layout accordingly
 */
function handleResize(): void {
  // Only matters during call or waiting-for-peer
  const callInterface = elements.callInterface;
  if (callInterface.classList.contains('hidden')) return;

  if (isMobileViewport()) {
    callInterface.classList.add('mobile-call');
    callInterface.classList.remove('desktop-call');
  } else {
    callInterface.classList.remove('mobile-call');
    callInterface.classList.add('desktop-call');
    elements.statusBar.classList.remove('hidden-overlay');
  }
}

// Add resize/orientation handlers
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);

/**
 * Main render function - synchronizes entire DOM to current state
 * Called after every state transition
 *
 * @param state - Current application state
 *
 * @remarks
 * Rendering Strategy:
 * 1. Hide all screens
 * 2. Render active screen based on state.screen.type
 * 3. Update video elements from state.localStream / state.remoteStream
 *
 * This approach ensures DOM always reflects state exactly
 * No manual DOM manipulation elsewhere in the codebase
 */
export function render(state: AppState): void {
  // Clean up when leaving call screen
  if (
    state.screen.type !== 'call' &&
    state.screen.type !== 'waiting-for-peer' &&
    state.screen.type !== 'negotiating'
  ) {
    // Clear status bar timeout
    if (statusHideTimeoutId !== null) {
      clearTimeout(statusHideTimeoutId);
      statusHideTimeoutId = null;
    }
    elements.statusBar.classList.remove('hidden-overlay');
    elements.callInterface.classList.remove('mobile-call');
    elements.callInterface.classList.remove('desktop-call');
    elements.waitingOverlay.classList.add('hidden');
    elements.pipToggleBtn.classList.remove('visible');
    elements.localVideo.classList.remove('pip-hidden');
    // Clean up PiP drag handlers
    cleanupPipDrag();
  }

  // Hide all screens first
  elements.pinEntry.classList.add('hidden');
  elements.callInterface.classList.add('hidden');
  elements.errorDisplay.classList.add('hidden');

  // Render active screen
  switch (state.screen.type) {
    case 'pin-entry':
      renderPinEntry();
      break;

    case 'connecting':
      renderConnecting(state.screen.pin);
      break;

    case 'acquiring-media':
      renderAcquiringMedia(state.screen.pin);
      break;

    case 'waiting-for-peer':
      renderWaitingForPeer(
        state.screen.pin,
        state.screen.muted,
        state.screen.videoOff,
        state.screen.pipHidden,
      );
      break;

    case 'negotiating':
      renderNegotiating(
        state.screen.pin,
        state.screen.role,
        state.screen.muted,
        state.screen.videoOff,
        state.screen.pipHidden,
      );
      break;

    case 'call':
      renderCall(state);
      break;

    case 'error':
      renderError(state.screen.message, state.screen.canRetry);
      break;
  }

  // Update video elements based on state
  updateVideoElements(state);
}

/**
 * Render PIN entry screen
 * Shows form with enabled connect button
 */
function renderPinEntry(): void {
  elements.pinEntry.classList.remove('hidden');
  elements.connectBtn.disabled = false;
  elements.connectBtn.textContent = 'Connect';
  elements.pinInput.value = ''; // Clear input for next connection
}

/**
 * Render connecting screen
 * Shows PIN entry with disabled button and "Connecting..." text
 *
 * @param _pin - PIN being used for connection (not currently displayed)
 */
function renderConnecting(_pin: string): void {
  elements.pinEntry.classList.remove('hidden');
  elements.connectBtn.disabled = true;
  elements.connectBtn.textContent = 'Connecting...';
  updateStatus('Connecting to server...');
}

/**
 * Render acquiring media screen
 * Shows PIN entry with disabled button and "Getting camera..." text
 *
 * @param _pin - PIN being used for connection
 */
function renderAcquiringMedia(_pin: string): void {
  elements.pinEntry.classList.remove('hidden');
  elements.connectBtn.disabled = true;
  elements.connectBtn.textContent = 'Getting camera...';
  updateStatus('Requesting camera access...');
}

/**
 * Render waiting for peer screen
 * Shows call interface with status "Waiting for peer..."
 *
 * @param pin - PIN to display (user shares this with peer)
 * @param muted - Whether audio is muted
 * @param videoOff - Whether video is off
 * @param pipHidden - Whether PiP preview is hidden
 */
function renderWaitingForPeer(
  pin: string,
  muted: boolean,
  videoOff: boolean,
  pipHidden: boolean,
): void {
  elements.callInterface.classList.remove('hidden');
  elements.pinDisplay.textContent = `PIN: ${pin}`;
  updateStatus('Waiting for peer...');

  // Apply full-screen layout for both mobile and desktop
  if (isMobileViewport()) {
    elements.callInterface.classList.add('mobile-call');
    elements.callInterface.classList.remove('desktop-call');
  } else {
    elements.callInterface.classList.add('desktop-call');
    elements.callInterface.classList.remove('mobile-call');
  }

  // Show waiting overlay
  elements.waitingOverlay.classList.remove('hidden');

  // Update mute/video button states
  updateMuteVideoButtons(muted, videoOff);

  // Handle PiP visibility toggle
  updatePipToggleButton(pipHidden);

  // Initialize PiP drag behavior for waiting screen (idempotent)
  setupPipDrag(elements.localVideo);
}

/**
 * Render negotiating screen
 * Shows call interface with different status based on role
 *
 * @param pin - PIN for this call
 * @param role - 'caller' (we created offer) or 'callee' (we received offer)
 * @param muted - Whether audio is muted
 * @param videoOff - Whether video is off
 * @param pipHidden - Whether PiP preview is hidden
 *
 * @remarks
 * Role affects status text:
 * - Caller: "Calling peer..." (we're initiating)
 * - Callee: "Answering call..." (we're responding)
 */
function renderNegotiating(
  pin: string,
  role: 'caller' | 'callee',
  muted: boolean,
  videoOff: boolean,
  pipHidden: boolean,
): void {
  elements.callInterface.classList.remove('hidden');
  elements.pinDisplay.textContent = `PIN: ${pin}`;
  updateStatus(role === 'caller' ? 'Calling peer...' : 'Answering call...');

  // Maintain full-screen layout during negotiation
  if (isMobileViewport()) {
    elements.callInterface.classList.add('mobile-call');
    elements.callInterface.classList.remove('desktop-call');
  } else {
    elements.callInterface.classList.add('desktop-call');
    elements.callInterface.classList.remove('mobile-call');
  }

  // Keep waiting overlay visible during negotiation
  elements.waitingOverlay.classList.remove('hidden');

  // Update mute/video button states
  updateMuteVideoButtons(muted, videoOff);

  // Handle PiP visibility toggle
  updatePipToggleButton(pipHidden);

  // Maintain PiP drag during negotiation (idempotent)
  setupPipDrag(elements.localVideo);
}

/**
 * Render active call screen
 * Shows call interface with controls, updates button states
 *
 * @param state - Full app state (need access to localStream for audio-only detection)
 *
 * @remarks
 * Button State Logic:
 * - Mute button: Active when muted, shows "Unmute" / 🔇
 * - Video button: Active when video off, shows "Video On" / 🚫
 * - Video button: Disabled in audio-only mode (no video track)
 *
 * Audio-Only Mode:
 * - Detected when localStream has no video tracks
 * - Video button disabled with opacity 0.5
 * - Local video element hidden
 */
function renderCall(state: AppState): void {
  if (state.screen.type !== 'call') return;

  elements.callInterface.classList.remove('hidden');
  elements.pinDisplay.textContent = `PIN: ${state.screen.pin}`;
  updateStatus('Connected');

  // Hide waiting overlay when call is connected
  elements.waitingOverlay.classList.add('hidden');

  // Toggle mobile/desktop full-screen mode
  if (isMobileViewport()) {
    elements.callInterface.classList.add('mobile-call');
    elements.callInterface.classList.remove('desktop-call');
    startStatusAutoHide();
  } else {
    elements.callInterface.classList.remove('mobile-call');
    elements.callInterface.classList.add('desktop-call');
    elements.statusBar.classList.remove('hidden-overlay');
  }

  // Update mute/video button states
  updateMuteVideoButtons(state.screen.muted, state.screen.videoOff);

  // Handle PiP visibility toggle
  updatePipToggleButton(state.screen.pipHidden);

  // Handle audio-only mode
  const isAudioOnly = state.localStream && state.localStream.getVideoTracks().length === 0;

  if (isAudioOnly) {
    elements.localVideo.style.display = 'none';
    elements.videoBtn.disabled = true;
    elements.videoBtn.style.opacity = '0.5';
    elements.videoBtn.title = 'No camera available';
    // Hide flip button in audio-only mode
    elements.flipBtn.classList.remove('visible');
    elements.flipBtn.disabled = true;
  } else {
    elements.localVideo.style.display = '';
    elements.videoBtn.disabled = false;
    elements.videoBtn.style.opacity = '';
    elements.videoBtn.title = 'Video On/Off';
    // Update flip button visibility based on camera count (async)
    void updateFlipButtonVisibility(state);
    // Initialize PiP drag behavior (idempotent - safe to call multiple times)
    setupPipDrag(elements.localVideo);
  }
}

/**
 * Render error screen
 * Shows error message with optional retry capability
 *
 * @param message - Human-readable error message
 * @param canRetry - Whether user can retry (shows PIN entry in background)
 *
 * @remarks
 * Error Display Strategy:
 * - Always shows error message in red banner
 * - If canRetry=true: Shows PIN entry in background for retry
 * - If canRetry=false: Only shows error (user must refresh page)
 *
 * Auto-Dismiss:
 * - Handled by effects.ts (5-second timeout)
 * - Timeout is managed there to prevent race conditions
 */
function renderError(message: string, canRetry: boolean): void {
  console.error('[ERROR]', message);
  elements.errorMessage.textContent = message;
  elements.errorDisplay.classList.remove('hidden');

  // Show PIN entry in background if retry is possible
  if (canRetry) {
    elements.pinEntry.classList.remove('hidden');
    elements.connectBtn.disabled = false;
    elements.connectBtn.textContent = 'Connect';
  }
}

/**
 * Update status text
 * Helper function used by multiple render functions
 *
 * @param status - Status text to display
 */
function updateStatus(status: string): void {
  console.log('[STATUS]', status);
  elements.statusText.textContent = status;
}

/**
 * Update mute and video button states
 * Used on waiting-for-peer, negotiating, and call screens
 *
 * @param muted - Whether audio is muted
 * @param videoOff - Whether video is off
 */
function updateMuteVideoButtons(muted: boolean, videoOff: boolean): void {
  // Update mute button state
  elements.muteBtn.classList.toggle('active', muted);
  const muteLabel = elements.muteBtn.querySelector('.label');
  const muteIcon = elements.muteBtn.querySelector('.icon');
  if (muteLabel) muteLabel.textContent = muted ? 'Unmute' : 'Mute';
  if (muteIcon) muteIcon.textContent = muted ? '🔇' : '🎤';

  // Update video button state
  elements.videoBtn.classList.toggle('active', videoOff);
  const videoLabel = elements.videoBtn.querySelector('.label');
  const videoIcon = elements.videoBtn.querySelector('.icon');
  if (videoLabel) videoLabel.textContent = videoOff ? 'Video On' : 'Video Off';
  if (videoIcon) videoIcon.textContent = videoOff ? '🚫' : '📹';
}

/**
 * Update PiP toggle button state
 * Shows/hides local video and updates button icon/label
 *
 * @param pipHidden - Whether PiP preview is currently hidden
 */
function updatePipToggleButton(pipHidden: boolean): void {
  const pipIcon = elements.pipToggleBtn.querySelector('.icon');
  const pipLabel = elements.pipToggleBtn.querySelector('.label');

  if (pipHidden) {
    elements.localVideo.classList.add('pip-hidden');
    if (pipIcon) pipIcon.textContent = '👁';
    if (pipLabel) pipLabel.textContent = 'Show';
  } else {
    elements.localVideo.classList.remove('pip-hidden');
    if (pipIcon) pipIcon.textContent = '👤';
    if (pipLabel) pipLabel.textContent = 'Hide';
  }
  elements.pipToggleBtn.classList.add('visible');
}

/**
 * Update video elements based on state
 * Sets srcObject for local and remote video elements
 *
 * @param state - Application state with stream references
 *
 * @remarks
 * Video Element Setup:
 * - Local video: Always muted (prevent echo)
 * - Remote video: Not muted (hear peer)
 * - Both have autoplay and playsinline attributes (set in HTML)
 *
 * Mobile Compatibility:
 * - playsinline prevents iOS fullscreen takeover
 * - autoplay works because permission already granted
 */
function updateVideoElements(state: AppState): void {
  if (state.localStream) {
    elements.localVideo.srcObject = state.localStream;
  }

  if (state.remoteStream) {
    elements.remoteVideo.srcObject = state.remoteStream;
  }
}
