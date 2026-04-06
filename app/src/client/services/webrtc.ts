/**
 * WebRTC peer connection management
 * Handles RTCPeerConnection lifecycle, offer/answer negotiation, and ICE handling
 */

import type {
  IceServerConfig,
  IceTransportPolicy,
  ClientToServerMessage,
} from '../../shared/types';
import type { Action } from '../state/types';
import { sendMessage } from './websocket';

type Dispatch = (action: Action) => void;

/**
 * ICE candidates that arrived before setRemoteDescription completed.
 * Keyed by RTCPeerConnection so buffers are automatically eligible for GC
 * when the connection is discarded.
 */
const pendingCandidates = new WeakMap<RTCPeerConnection, RTCIceCandidateInit[]>();

/** Apply buffered ICE candidates after remote description has been set */
async function flushPendingCandidates(pc: RTCPeerConnection, pcRef: PcRef): Promise<void> {
  const candidates = pendingCandidates.get(pc);
  if (!candidates || candidates.length === 0) return;
  pendingCandidates.delete(pc);

  for (const candidate of candidates) {
    if (pcRef.current !== pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[RTC] Buffered ICE candidate added');
    } catch (error) {
      if (pcRef.current !== pc) return;
      console.warn('[RTC] Failed to add buffered ICE candidate (non-fatal):', error);
    }
  }
}

/**
 * Mutable ref to the active peer connection.
 * Used by async operations to detect staleness: if `pcRef.current !== pc`,
 * the call session changed during an await and the operation should abort.
 * This eliminates the entire class of race conditions where async WebRTC
 * operations from call N dispatch actions into call N+1.
 */
type PcRef = { current: RTCPeerConnection | null };

/** Configuration for creating a peer connection */
interface PeerConnectionConfig {
  iceServers: IceServerConfig[];
  iceTransportPolicy: IceTransportPolicy;
}

/**
 * Create and configure RTCPeerConnection.
 * Sets up event handlers to dispatch state machine actions.
 *
 * @param config - ICE server configuration
 * @param localStream - Local media stream to add as tracks
 * @param ws - WebSocket for sending ICE candidates
 * @param dispatch - State machine dispatch function
 * @returns Configured RTCPeerConnection instance
 */
export function createPeerConnection(
  config: PeerConnectionConfig,
  localStream: MediaStream | null,
  ws: WebSocket | null,
  dispatch: Dispatch,
): RTCPeerConnection {
  console.log('[RTC] Creating peer connection');
  console.log('[RTC] ICE transport policy:', config.iceTransportPolicy);

  const pc = new RTCPeerConnection({
    iceServers: config.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined && { username: s.username }),
      ...(s.credential !== undefined && { credential: s.credential }),
    })),
    iceTransportPolicy: config.iceTransportPolicy,
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
      console.log('[RTC] Added local track:', track.kind);
    });

    if (localStream.getVideoTracks().length === 0) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      console.log('[RTC] Added recvonly video transceiver (audio-only mode)');
    }
  }

  pc.ontrack = (event: RTCTrackEvent) => {
    console.log('[RTC] Received remote track:', event.track.kind);
    const stream = event.streams[0];
    if (stream) {
      dispatch({ type: 'RTC_TRACK_RECEIVED', stream });
    }
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      console.log('[RTC] Sending ICE candidate');
      const msg: ClientToServerMessage = {
        type: 'ice-candidate',
        v: 1,
        candidate: event.candidate,
      };
      sendMessage(ws, msg);
    } else {
      console.log('[RTC] ICE gathering complete');
    }
  };

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
    }
  };

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
 * Handle incoming offer (callee side), with glare resolution.
 *
 * **Glare** occurs when both peers send offers simultaneously (both clicked call
 * at the same time). Resolution uses the "perfect negotiation" pattern:
 * - **Polite** peer (lower peerId): rolls back own offer (if set), accepts
 *   remote offer, creates and sends answer. Also cancels any in-flight
 *   createOffer chain via `makingOfferRef`.
 * - **Impolite** peer (higher peerId): ignores the remote offer, waits for an
 *   answer to its own offer.
 *
 * Collision is detected by `makingOffer || signalingState !== 'stable'`.
 * The `makingOffer` flag catches the race where createOffer() is pending but
 * setLocalDescription hasn't run yet (signalingState is still 'stable').
 *
 * @param isPolite - Whether this peer yields during glare (true = rollback own offer)
 * @param makingOfferRef - Ref tracking in-flight offer creation; cleared by polite peer to abort the offer chain
 */
export async function handleOffer(
  pc: RTCPeerConnection | null,
  offer: RTCSessionDescriptionInit,
  ws: WebSocket | null,
  pcRef: PcRef,
  dispatch: Dispatch,
  isPolite: boolean,
  makingOfferRef: { current: boolean },
): Promise<void> {
  if (!pc || pcRef.current !== pc) return;

  // Collision = we're creating or have created our own offer
  const offerCollision = makingOfferRef.current || pc.signalingState !== 'stable';

  if (offerCollision) {
    if (!isPolite) {
      console.log('[RTC] Glare: impolite peer ignoring remote offer, waiting for answer');
      return;
    }

    // Polite peer: cancel pending offer chain and yield to remote offer
    console.log('[RTC] Glare: polite peer yielding to remote offer');
    makingOfferRef.current = false;

    if (pc.signalingState === 'have-local-offer') {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
        if (pcRef.current !== pc) return;
      } catch (error) {
        if (pcRef.current !== pc) return;
        console.error('[RTC] Failed to rollback during glare:', error);
        dispatch({
          type: 'RTC_FAILED',
          reason: `Glare rollback failed: ${(error as Error).message}`,
        });
        return;
      }
    }
    // Fall through to normal offer handling (now in stable state)
  }

  if (pc.signalingState !== 'stable') {
    console.warn('[RTC] Ignoring offer: expected stable, got', pc.signalingState);
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (pcRef.current !== pc) return;
    await flushPendingCandidates(pc, pcRef);
    if (pcRef.current !== pc) return;
    const answer = await pc.createAnswer();
    if (pcRef.current !== pc) return;
    await pc.setLocalDescription(answer);
    if (pcRef.current !== pc) return;
    if (!answer.sdp) {
      throw new Error('Created answer has no SDP');
    }
    sendMessage(ws, { type: 'answer', v: 1, sdp: answer.sdp });
    console.log('[RTC] Sent answer');
  } catch (error) {
    if (pcRef.current !== pc) return;
    console.error('[RTC] Failed to handle offer:', error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to answer call: ${(error as Error).message}`,
    });
  }
}

/** Handle incoming answer (caller side) */
export async function handleAnswer(
  pc: RTCPeerConnection | null,
  answer: RTCSessionDescriptionInit,
  pcRef: PcRef,
  dispatch: Dispatch,
): Promise<void> {
  if (!pc || pcRef.current !== pc) return;

  if (pc.signalingState !== 'have-local-offer') {
    console.warn('[RTC] Ignoring stale answer: expected have-local-offer, got', pc.signalingState);
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    if (pcRef.current !== pc) return;
    await flushPendingCandidates(pc, pcRef);
    if (pcRef.current !== pc) return;
    console.log('[RTC] Answer received and set');
  } catch (error) {
    if (pcRef.current !== pc) return;
    console.error('[RTC] Failed to handle answer:', error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to establish connection: ${(error as Error).message}`,
    });
  }
}

/** Handle incoming ICE candidate, buffering if remote description is not yet set */
export async function handleIceCandidate(
  pc: RTCPeerConnection | null,
  candidate: RTCIceCandidateInit,
  pcRef: PcRef,
): Promise<void> {
  if (!pc || pcRef.current !== pc) return;

  if (!pc.remoteDescription) {
    let queue = pendingCandidates.get(pc);
    if (!queue) {
      queue = [];
      pendingCandidates.set(pc, queue);
    }
    queue.push(candidate);
    console.log('[RTC] Buffered ICE candidate (remote description not set yet)');
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    console.log('[RTC] ICE candidate added');
  } catch (error) {
    if (pcRef.current !== pc) return;
    console.warn('[RTC] Failed to add ICE candidate (non-fatal):', error);
  }
}

/**
 * Close peer connection and release resources.
 * Nulls all event handlers BEFORE close() to prevent callbacks from
 * in-flight async operations (handleAnswer, ICE gathering) from
 * dispatching actions after cleanup.
 */
export function closePeerConnection(pc: RTCPeerConnection): void {
  pendingCandidates.delete(pc);
  pc.ontrack = null;
  pc.onicecandidate = null;
  pc.onconnectionstatechange = null;
  pc.oniceconnectionstatechange = null;

  if (pc.connectionState !== 'closed') {
    pc.close();
  }
  console.log('[RTC] Peer connection closed');
}
