/**
 * WebRTC peer connection management
 * Handles RTCPeerConnection lifecycle, offer/answer negotiation, and ICE handling
 */

import type { AppState, Action } from './state';
import { sendMessage } from './websocket';

/**
 * Dispatch function type - all modules receive this to trigger state transitions
 */
type Dispatch = (action: Action) => void;

/**
 * Create and configure RTCPeerConnection
 * Sets up all event handlers to dispatch state machine actions
 *
 * @param state - Current application state (for ICE servers and local stream)
 * @param dispatch - Function to dispatch state machine actions
 * @returns Configured RTCPeerConnection instance
 *
 * @throws Error if ICE servers not configured (should never happen due to state machine)
 *
 * @remarks
 * Event Handlers:
 * - ontrack → RTC_TRACK_RECEIVED (remote video/audio stream)
 * - onicecandidate → Send ICE candidate to peer via WebSocket
 * - onconnectionstatechange → RTC_CONNECTED | RTC_DISCONNECTED | RTC_FAILED
 * - oniceconnectionstatechange → RTC_FAILED on ICE failure
 *
 * Mobile Compatibility:
 * - Uses default config (works with hardware acceleration on Android)
 * - ICE candidate gathering may be slower on iOS Safari (normal behavior)
 */
export function createPeerConnection(state: AppState, dispatch: Dispatch): RTCPeerConnection {
  if (!state.iceServers) {
    throw new Error('ICE servers not configured');
  }

  console.log('[RTC] Creating peer connection');

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });

  // Add local tracks to peer connection
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      if (state.localStream) {
        pc.addTrack(track, state.localStream);
        console.log('[RTC] Added local track:', track.kind);
      }
    });

    // If no video track, add recvonly transceiver to receive peer's video
    // Without this, audio-only callers would create offers without video m-line,
    // preventing peers with cameras from sending their video
    if (state.localStream.getVideoTracks().length === 0) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      console.log('[RTC] Added recvonly video transceiver (audio-only mode)');
    }
  }

  /**
   * Handle incoming tracks from remote peer
   * Dispatches RTC_TRACK_RECEIVED with the remote stream
   */
  pc.ontrack = (event: RTCTrackEvent) => {
    console.log('[RTC] Received remote track:', event.track.kind);
    const stream = event.streams[0];
    if (stream) {
      dispatch({ type: 'RTC_TRACK_RECEIVED', stream });
    }
  };

  /**
   * Handle ICE candidates
   * Send each candidate to peer via WebSocket signaling
   *
   * @remarks
   * Trickle ICE: Candidates sent as discovered (not waiting for all)
   * Null candidate indicates gathering complete (informational only)
   */
  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      console.log('[RTC] Sending ICE candidate');
      sendMessage(state.ws, {
        type: 'ice-candidate',
        data: event.candidate,
      });
    } else {
      console.log('[RTC] ICE gathering complete');
    }
  };

  /**
   * Handle connection state changes
   * Monitors overall connection health
   *
   * States:
   * - new → Initial state
   * - connecting → Negotiation in progress
   * - connected → Media flowing! Dispatch RTC_CONNECTED
   * - disconnected → Temporary network issue (may recover)
   * - failed → Connection failed, dispatch RTC_FAILED
   * - closed → Connection closed (cleanup)
   */
  pc.onconnectionstatechange = () => {
    console.log('[RTC] Connection state:', pc.connectionState);

    switch (pc.connectionState) {
      case 'connected':
        dispatch({ type: 'RTC_CONNECTED' });
        break;

      case 'disconnected':
        dispatch({ type: 'RTC_DISCONNECTED' });
        break;

      case 'failed':
        dispatch({
          type: 'RTC_FAILED',
          reason: 'Connection failed. Please check your network and try again.',
        });
        break;

      case 'closed':
        // Normal cleanup, no action needed
        break;
    }
  };

  /**
   * Handle ICE connection state changes
   * More granular than connection state
   *
   * @remarks
   * ICE (Interactive Connectivity Establishment) tries:
   * 1. Direct P2P connection (best performance)
   * 2. STUN server to get public IP
   * 3. TURN relay server (fallback for restrictive NATs)
   *
   * Failed state means all attempts exhausted
   */
  pc.oniceconnectionstatechange = () => {
    console.log('[RTC] ICE connection state:', pc.iceConnectionState);

    if (pc.iceConnectionState === 'failed') {
      dispatch({
        type: 'RTC_FAILED',
        reason:
          'ICE connection failed. Your network may be blocking WebRTC. Try a different network or contact your IT admin.',
      });
    }
  };

  return pc;
}

/**
 * Handle incoming offer from remote peer (we are the callee)
 * Sets remote description, creates answer, sets local description, sends answer
 *
 * @param pc - RTCPeerConnection instance
 * @param offer - SDP offer from remote peer
 * @param ws - WebSocket connection to send answer
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * WebRTC Negotiation Flow (Callee Side):
 * 1. Receive offer from caller
 * 2. setRemoteDescription(offer) → tells our PeerConnection what caller offers
 * 3. createAnswer() → generates our answer based on what we support
 * 4. setLocalDescription(answer) → commits our answer
 * 5. Send answer to caller via WebSocket
 *
 * Glare Prevention:
 * - Only caller creates offer (prevents both sides creating offers simultaneously)
 * - Server ensures first peer gets peer-joined, second peer gets offer
 */
export async function handleOffer(
  pc: RTCPeerConnection | null,
  offer: RTCSessionDescriptionInit,
  ws: WebSocket | null,
  dispatch: Dispatch,
): Promise<void> {
  if (!pc) {
    console.error('[RTC] No peer connection to handle offer');
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendMessage(ws, { type: 'answer', data: answer });
    console.log('[RTC] Sent answer');
  } catch (error) {
    console.error('[RTC] Failed to handle offer:', error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to answer call: ${(error as Error).message}`,
    });
  }
}

/**
 * Handle incoming answer from remote peer (we are the caller)
 * Sets remote description to complete negotiation
 *
 * @param pc - RTCPeerConnection instance
 * @param answer - SDP answer from remote peer
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * WebRTC Negotiation Flow (Caller Side):
 * 1. We created offer and sent it (handled in effects.ts)
 * 2. Receive answer from callee
 * 3. setRemoteDescription(answer) → completes negotiation
 * 4. ICE candidates exchange → connection establishes
 * 5. onconnectionstatechange fires 'connected' → RTC_CONNECTED
 */
export async function handleAnswer(
  pc: RTCPeerConnection | null,
  answer: RTCSessionDescriptionInit,
  dispatch: Dispatch,
): Promise<void> {
  if (!pc) {
    console.error('[RTC] No peer connection to handle answer');
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[RTC] Answer received and set');
  } catch (error) {
    console.error('[RTC] Failed to handle answer:', error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to establish connection: ${(error as Error).message}`,
    });
  }
}

/**
 * Handle incoming ICE candidate from remote peer
 * Adds candidate to peer connection for connectivity establishment
 *
 * @param pc - RTCPeerConnection instance
 * @param candidate - ICE candidate from remote peer
 * @param _dispatch - Function to dispatch state machine actions (unused for ICE candidates)
 *
 * @remarks
 * ICE Candidate Types:
 * - host: Direct connection to peer (best performance, may not work behind NAT)
 * - srflx: Server reflexive (via STUN, works through most NATs)
 * - relay: Relayed through TURN server (fallback, highest latency)
 *
 * All candidates are tried in parallel, best one wins
 * Don't fail connection on individual candidate errors (some may be incompatible)
 */
export async function handleIceCandidate(
  pc: RTCPeerConnection | null,
  candidate: RTCIceCandidateInit,
  _dispatch: Dispatch,
): Promise<void> {
  if (!pc) {
    console.error('[RTC] No peer connection for ICE candidate');
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    console.log('[RTC] ICE candidate added');
  } catch (error) {
    // Don't fail the whole connection on ICE candidate errors
    // Some candidates may be incompatible with our network config
    console.warn('[RTC] Failed to add ICE candidate (non-fatal):', error);
  }
}

/**
 * Close peer connection and release resources
 *
 * @param pc - RTCPeerConnection to close
 *
 * @remarks
 * Closes all peer connection state machines and releases resources
 * Should be called on hangup or connection failure
 * Idempotent - safe to call multiple times
 */
export function closePeerConnection(pc: RTCPeerConnection): void {
  if (pc.connectionState !== 'closed') {
    pc.close();
    console.log('[RTC] Peer connection closed');
  }
}
