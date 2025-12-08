/**
 * DOM rendering - single source of truth for UI synchronization
 * All DOM updates go through this module based on state
 */

import type { AppState } from './state';

/**
 * DOM element references
 * Queried once at module load for performance
 */
const elements = {
  pinEntry: document.getElementById('pin-entry') as HTMLDivElement,
  callInterface: document.getElementById('call-interface') as HTMLDivElement,
  statusText: document.getElementById('status-text') as HTMLSpanElement,
  pinDisplay: document.getElementById('pin-display') as HTMLSpanElement,
  localVideo: document.getElementById('local-video') as HTMLVideoElement,
  remoteVideo: document.getElementById('remote-video') as HTMLVideoElement,
  muteBtn: document.getElementById('mute-btn') as HTMLButtonElement,
  videoBtn: document.getElementById('video-btn') as HTMLButtonElement,
  hangupBtn: document.getElementById('hangup-btn') as HTMLButtonElement,
  errorDisplay: document.getElementById('error-display') as HTMLDivElement,
  errorMessage: document.getElementById('error-message') as HTMLSpanElement,
  connectBtn: document.getElementById('connect-btn') as HTMLButtonElement,
  pinInput: document.getElementById('pin-input') as HTMLInputElement,
};

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
      renderWaitingForPeer(state.screen.pin);
      break;

    case 'negotiating':
      renderNegotiating(state.screen.pin, state.screen.role);
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
 */
function renderWaitingForPeer(pin: string): void {
  elements.callInterface.classList.remove('hidden');
  elements.pinDisplay.textContent = `PIN: ${pin}`;
  updateStatus('Waiting for peer...');
}

/**
 * Render negotiating screen
 * Shows call interface with different status based on role
 *
 * @param pin - PIN for this call
 * @param role - 'caller' (we created offer) or 'callee' (we received offer)
 *
 * @remarks
 * Role affects status text:
 * - Caller: "Calling peer..." (we're initiating)
 * - Callee: "Answering call..." (we're responding)
 */
function renderNegotiating(pin: string, role: 'caller' | 'callee'): void {
  elements.callInterface.classList.remove('hidden');
  elements.pinDisplay.textContent = `PIN: ${pin}`;
  updateStatus(role === 'caller' ? 'Calling peer...' : 'Answering call...');
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

  // Update mute button state
  elements.muteBtn.classList.toggle('active', state.screen.muted);
  const muteLabel = elements.muteBtn.querySelector('.label');
  const muteIcon = elements.muteBtn.querySelector('.icon');
  if (muteLabel) muteLabel.textContent = state.screen.muted ? 'Unmute' : 'Mute';
  if (muteIcon) muteIcon.textContent = state.screen.muted ? '🔇' : '🎤';

  // Update video button state
  elements.videoBtn.classList.toggle('active', state.screen.videoOff);
  const videoLabel = elements.videoBtn.querySelector('.label');
  const videoIcon = elements.videoBtn.querySelector('.icon');
  if (videoLabel) videoLabel.textContent = state.screen.videoOff ? 'Video On' : 'Video Off';
  if (videoIcon) videoIcon.textContent = state.screen.videoOff ? '🚫' : '📹';

  // Handle audio-only mode
  if (state.localStream && state.localStream.getVideoTracks().length === 0) {
    elements.localVideo.style.display = 'none';
    elements.videoBtn.disabled = true;
    elements.videoBtn.style.opacity = '0.5';
    elements.videoBtn.title = 'No camera available';
  } else {
    elements.localVideo.style.display = '';
    elements.videoBtn.disabled = false;
    elements.videoBtn.style.opacity = '';
    elements.videoBtn.title = 'Video On/Off';
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
