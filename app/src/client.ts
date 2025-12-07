/**
 * tuturu WebRTC Client
 * Handles WebSocket signaling and WebRTC peer connection
 */

import type { Message, IceServerConfig } from './types';

// DOM Elements
const pinEntry = document.getElementById('pin-entry') as HTMLDivElement;
const callInterface = document.getElementById('call-interface') as HTMLDivElement;
const pinForm = document.getElementById('pin-form') as HTMLFormElement;
const pinInput = document.getElementById('pin-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const pinDisplay = document.getElementById('pin-display') as HTMLSpanElement;
const localVideo = document.getElementById('local-video') as HTMLVideoElement;
const remoteVideo = document.getElementById('remote-video') as HTMLVideoElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const videoBtn = document.getElementById('video-btn') as HTMLButtonElement;
const hangupBtn = document.getElementById('hangup-btn') as HTMLButtonElement;
const errorDisplay = document.getElementById('error-display') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLSpanElement;

// State
let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let currentPin: string | null = null;
let iceServers: IceServerConfig[] | null = null;
let isMuted = false;
let isVideoOff = false;
let isIntentionalClose = false; // Track intentional disconnections
let hasVideo = false; // Track if video is available

/**
 * FAIL FAST error display
 */
function showError(message: string): void {
  console.error('[ERROR]', message);
  errorMessage.textContent = message;
  errorDisplay.classList.remove('hidden');

  // Hide after 5 seconds
  setTimeout(() => {
    errorDisplay.classList.add('hidden');
  }, 5000);
}

/**
 * Show warning message (non-critical)
 */
function showWarning(message: string): void {
  console.warn('[WARNING]', message);
  updateStatus(message);
}

/**
 * Update status text
 */
function updateStatus(status: string): void {
  console.log('[STATUS]', status);
  statusText.textContent = status;
}

/**
 * Get WebSocket URL (handle both http and https)
 */
function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  console.log('[WS] Using protocol:', protocol);
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Connect to WebSocket server
 * FAILS if connection cannot be established
 */
function connectWebSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = getWebSocketUrl();
    console.log('[WS] Connecting to', wsUrl);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected');
      isIntentionalClose = false;
      resolve();
    };

    ws.onerror = (error) => {
      console.error('[WS] Connection error:', error);
      reject(new Error('WebSocket connection failed. Check server is running.'));
    };

    ws.onclose = (event: CloseEvent) => {
      console.log('[WS] Connection closed:', event.code, event.reason);

      // Only show error for unexpected closures (not intentional hangups)
      if (!isIntentionalClose && event.code !== 1000) {
        const errorReason = event.reason || getCloseCodeDescription(event.code);
        showError(`Connection closed: ${errorReason}`);
        cleanup();
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      const message: Message = JSON.parse(event.data);
      handleSignalingMessage(message);
    };
  });
}

/**
 * Get human-readable description for WebSocket close codes
 */
function getCloseCodeDescription(code: number): string {
  switch (code) {
    case 1000: return 'Normal closure';
    case 1001: return 'Server going away';
    case 1002: return 'Protocol error';
    case 1003: return 'Unsupported data type';
    case 1006: return 'Connection lost (no close frame)';
    case 1007: return 'Invalid message data';
    case 1008: return 'Policy violation';
    case 1009: return 'Message too large';
    case 1011: return 'Server error';
    default: return `Unexpected error (code ${code})`;
  }
}

/**
 * Send message via WebSocket
 * FAILS if WebSocket is not connected
 */
function sendMessage(message: Message): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not connected');
  }

  console.log('[WS] Sending:', message.type);
  ws.send(JSON.stringify(message));
}

/**
 * Get user media (camera and microphone)
 * Camera is optional, microphone is required
 * FAILS if microphone is unavailable or permission denied
 */
async function getUserMedia(): Promise<MediaStream> {
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
  };

  const videoConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  // Try to get both video and audio first
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints,
    });

    localStream = stream;
    localVideo.srcObject = stream;
    hasVideo = true;
    console.log('[MEDIA] Video + audio stream acquired');

    return stream;
  } catch (error) {
    const err = error as DOMException;

    // If video+audio failed, try audio-only
    console.warn('[MEDIA] Failed to get video+audio:', err.name);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      localStream = stream;
      hasVideo = false;

      // Hide local video element since we don't have video
      localVideo.style.display = 'none';

      // Disable video toggle button
      videoBtn.disabled = true;
      videoBtn.style.opacity = '0.5';
      videoBtn.title = 'No camera available';

      showWarning('Audio-only mode (no camera detected)');
      console.log('[MEDIA] Audio-only stream acquired');

      return stream;
    } catch (audioError) {
      const audioErr = audioError as DOMException;

      // FAIL FAST: Audio is required
      if (audioErr.name === 'NotAllowedError') {
        throw new Error('Microphone permission denied. Please allow access and try again.');
      } else if (audioErr.name === 'NotFoundError') {
        throw new Error('No microphone found. Please connect a microphone and try again.');
      } else if (audioErr.name === 'NotReadableError') {
        throw new Error('Microphone is already in use by another application.');
      } else {
        throw new Error(`Failed to get microphone: ${audioErr.message}`);
      }
    }
  }
}

/**
 * Create RTCPeerConnection
 * FAILS if ICE servers not configured
 */
function createPeerConnection(): RTCPeerConnection {
  if (!iceServers) {
    throw new Error('ICE servers not configured');
  }

  console.log('[RTC] Creating peer connection');

  pc = new RTCPeerConnection({ iceServers });

  // Add local tracks to peer connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc!.addTrack(track, localStream!);
      console.log('[RTC] Added local track:', track.kind);
    });
  }

  // Handle incoming tracks
  pc.ontrack = (event: RTCTrackEvent) => {
    console.log('[RTC] Received remote track:', event.track.kind);
    remoteVideo.srcObject = event.streams[0];
    updateStatus('Connected');
  };

  // Handle ICE candidates
  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      console.log('[RTC] Sending ICE candidate');
      sendMessage({
        type: 'ice-candidate',
        data: event.candidate,
      });
    }
  };

  // Handle connection state changes
  pc.onconnectionstatechange = () => {
    console.log('[RTC] Connection state:', pc!.connectionState);

    switch (pc!.connectionState) {
      case 'connected':
        updateStatus('Connected');
        break;
      case 'disconnected':
        updateStatus('Disconnected');
        break;
      case 'failed':
        showError('Connection failed. Please check your network and try again.');
        cleanup();
        break;
      case 'closed':
        updateStatus('Call ended');
        break;
    }
  };

  // Handle ICE connection state
  pc.oniceconnectionstatechange = () => {
    console.log('[RTC] ICE connection state:', pc!.iceConnectionState);

    if (pc!.iceConnectionState === 'failed') {
      showError('ICE connection failed. Your network may be blocking WebRTC. Try a different network or contact your IT admin.');
    }
  };

  return pc;
}

/**
 * Handle signaling messages from server
 */
async function handleSignalingMessage(message: Message): Promise<void> {
  console.log('[WS] Received:', message.type);

  try {
    switch (message.type) {
      case 'join-pin':
        // Store ICE servers configuration
        iceServers = message.data.iceServers;
        console.log('[RTC] ICE servers configured:', iceServers);
        updateStatus('Waiting for peer...');
        break;

      case 'peer-joined':
        updateStatus('Peer joined. Connecting...');

        // Create peer connection if not exists
        if (!pc) {
          createPeerConnection();
        }

        // Create and send offer
        const offer = await pc!.createOffer();
        await pc!.setLocalDescription(offer);

        sendMessage({
          type: 'offer',
          data: offer,
        });

        console.log('[RTC] Sent offer');
        break;

      case 'offer':
        updateStatus('Received offer. Answering...');

        // Create peer connection if not exists
        if (!pc) {
          createPeerConnection();
        }

        // Set remote description and create answer
        await pc!.setRemoteDescription(new RTCSessionDescription(message.data));

        const answer = await pc!.createAnswer();
        await pc!.setLocalDescription(answer);

        sendMessage({
          type: 'answer',
          data: answer,
        });

        console.log('[RTC] Sent answer');
        break;

      case 'answer':
        // Set remote description
        await pc!.setRemoteDescription(new RTCSessionDescription(message.data));
        console.log('[RTC] Answer received');
        break;

      case 'ice-candidate':
        // Add ICE candidate
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(message.data));
          console.log('[RTC] ICE candidate added');
        }
        break;

      case 'peer-left':
        updateStatus('Peer left the call');
        showError('The other person left the call');
        setTimeout(() => cleanup(), 2000);
        break;

      case 'error':
        // Server sent error - FAIL LOUD
        throw new Error(message.error);

      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  } catch (error) {
    const err = error as Error;
    showError(err.message);
    console.error('[ERROR] Signaling error:', error);
  }
}

/**
 * Start call with PIN
 */
async function startCall(pin: string): Promise<void> {
  try {
    updateStatus('Connecting...');

    // Connect to WebSocket
    await connectWebSocket();

    // Get user media
    await getUserMedia();

    // Join room with PIN
    sendMessage({
      type: 'join-pin',
      pin: pin,
    });

    currentPin = pin;

    // Show call interface
    pinEntry.classList.add('hidden');
    callInterface.classList.remove('hidden');
    pinDisplay.textContent = `PIN: ${pin}`;

  } catch (error) {
    const err = error as Error;
    showError(err.message);
    cleanup();
    throw error;
  }
}

/**
 * Cleanup and reset state
 */
function cleanup(): void {
  console.log('[CLEANUP] Cleaning up resources');

  // Mark as intentional close to prevent error messages
  isIntentionalClose = true;

  // Close peer connection
  if (pc) {
    pc.close();
    pc = null;
  }

  // Stop local media tracks
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  // Close WebSocket
  if (ws) {
    ws.close(1000, 'User ended call'); // 1000 = normal closure
    ws = null;
  }

  // Reset video elements
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  localVideo.style.display = ''; // Restore video element visibility

  // Reset UI
  callInterface.classList.add('hidden');
  pinEntry.classList.remove('hidden');
  pinInput.value = '';
  currentPin = null;
  iceServers = null;
  isMuted = false;
  isVideoOff = false;
  hasVideo = false;

  // Re-enable video button
  videoBtn.disabled = false;
  videoBtn.style.opacity = '';
  videoBtn.title = 'Video On/Off';

  updateMuteButtonState();
  updateVideoButtonState();

  // Reset close flag after a short delay
  setTimeout(() => {
    isIntentionalClose = false;
  }, 100);
}

/**
 * Toggle mute
 */
function toggleMute(): void {
  if (!localStream) return;

  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    isMuted = !audioTrack.enabled;
    updateMuteButtonState();
    console.log('[MEDIA] Audio', isMuted ? 'muted' : 'unmuted');
  }
}

/**
 * Toggle video
 */
function toggleVideo(): void {
  if (!localStream) return;

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    isVideoOff = !videoTrack.enabled;
    updateVideoButtonState();
    console.log('[MEDIA] Video', isVideoOff ? 'off' : 'on');
  }
}

/**
 * Update mute button state
 */
function updateMuteButtonState(): void {
  muteBtn.classList.toggle('active', isMuted);
  const label = muteBtn.querySelector('.label');
  const icon = muteBtn.querySelector('.icon');
  if (label) label.textContent = isMuted ? 'Unmute' : 'Mute';
  if (icon) icon.textContent = isMuted ? '🔇' : '🎤';
}

/**
 * Update video button state
 */
function updateVideoButtonState(): void {
  videoBtn.classList.toggle('active', isVideoOff);
  const label = videoBtn.querySelector('.label');
  const icon = videoBtn.querySelector('.icon');
  if (label) label.textContent = isVideoOff ? 'Video On' : 'Video Off';
  if (icon) icon.textContent = isVideoOff ? '🚫' : '📹';
}

/**
 * Hang up call
 */
function hangup(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMessage({ type: 'leave' });
  }
  cleanup();
}

// Event Listeners
pinForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();

  const pin = pinInput.value.trim();

  // Validate PIN format
  if (!/^\d{6}$/.test(pin)) {
    showError('PIN must be exactly 6 digits');
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';

  try {
    await startCall(pin);
  } catch (error) {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

muteBtn.addEventListener('click', toggleMute);
videoBtn.addEventListener('click', toggleVideo);
hangupBtn.addEventListener('click', hangup);

// Handle page unload
window.addEventListener('beforeunload', () => {
  cleanup();
});

console.log('[APP] tuturu WebRTC client initialized');
