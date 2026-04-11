/**
 * WebRTC peer connection management for mesh calls (up to 6 participants).
 *
 * Each remote peer has its own RTCPeerConnection, stored in a Map<peerId, PC>.
 * Staleness is checked via `peerConnections.get(peerId) !== pc` — if the map
 * entry changed (or was deleted), the async operation silently aborts.
 *
 * @module services/webrtc
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
 * Shared mesh state passed to signaling handlers.
 * Groups per-call mutable state to reduce parameter count.
 */
export interface MeshContext {
  /** WebSocket for sending signaling messages */
  ws: WebSocket | null;
  /** Map of all active peer connections (used for staleness checks) */
  peerConnections: Map<string, RTCPeerConnection>;
  /** State machine dispatch function */
  dispatch: Dispatch;
  /** Set tracking peers with in-flight offer creation (for glare detection) */
  makingOfferPeers: Set<string>;
}

/**
 * ICE candidates that arrived before setRemoteDescription completed.
 * Keyed by RTCPeerConnection so buffers are automatically eligible for GC
 * when the connection is discarded.
 */
const pendingCandidates = new WeakMap<RTCPeerConnection, RTCIceCandidateInit[]>();

/** Apply buffered ICE candidates after remote description has been set */
async function flushPendingCandidates(
  pc: RTCPeerConnection,
  peerConnections: Map<string, RTCPeerConnection>,
  peerId: string,
): Promise<void> {
  const candidates = pendingCandidates.get(pc);
  if (!candidates || candidates.length === 0) return;
  pendingCandidates.delete(pc);

  for (const candidate of candidates) {
    if (peerConnections.get(peerId) !== pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`[RTC:${peerId}] Buffered ICE candidate added`);
    } catch (error) {
      if (peerConnections.get(peerId) !== pc) return;
      console.warn(`[RTC:${peerId}] Failed to add buffered ICE candidate (non-fatal):`, error);
    }
  }
}

/** Configuration for creating a peer connection */
interface PeerConnectionConfig {
  iceServers: IceServerConfig[];
  iceTransportPolicy: IceTransportPolicy;
}

/**
 * Create and configure RTCPeerConnection for a specific remote peer.
 * Sets up event handlers to dispatch state machine actions with peerId.
 *
 * @param config - ICE server configuration
 * @param localStream - Local media stream to add as tracks
 * @param ws - WebSocket for sending ICE candidates
 * @param dispatch - State machine dispatch function
 * @param targetPeerId - Remote peer this connection is for (used in signaling and actions)
 * @returns Configured RTCPeerConnection instance
 */
export function createPeerConnection(
  config: PeerConnectionConfig,
  localStream: MediaStream | null,
  ws: WebSocket | null,
  dispatch: Dispatch,
  targetPeerId: string,
): RTCPeerConnection {
  console.log(`[RTC:${targetPeerId}] Creating peer connection`);
  console.log(`[RTC:${targetPeerId}] ICE transport policy:`, config.iceTransportPolicy);

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
      console.log(`[RTC:${targetPeerId}] Added local track:`, track.kind);
    });

    if (localStream.getVideoTracks().length === 0) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      console.log(`[RTC:${targetPeerId}] Added recvonly video transceiver (audio-only mode)`);
    }
  }

  pc.ontrack = (event: RTCTrackEvent) => {
    console.log(`[RTC:${targetPeerId}] Received remote track:`, event.track.kind);
    const stream = event.streams[0];
    if (stream) {
      dispatch({ type: 'RTC_TRACK_RECEIVED', stream, peerId: targetPeerId });
    }
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      console.log(`[RTC:${targetPeerId}] Sending ICE candidate`);
      const msg: ClientToServerMessage = {
        type: 'ice-candidate',
        v: 1,
        candidate: event.candidate,
        targetPeerId,
      };
      sendMessage(ws, msg);
    } else {
      console.log(`[RTC:${targetPeerId}] ICE gathering complete`);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[RTC:${targetPeerId}] Connection state:`, pc.connectionState);
    switch (pc.connectionState) {
      case 'connected':
        dispatch({ type: 'RTC_CONNECTED', peerId: targetPeerId });
        break;
      case 'disconnected':
        dispatch({ type: 'RTC_DISCONNECTED', peerId: targetPeerId });
        break;
      case 'failed':
        dispatch({
          type: 'RTC_FAILED',
          reason: 'Connection failed. Please check your network and try again.',
          peerId: targetPeerId,
        });
        break;
      case 'new':
      case 'connecting':
      case 'closed':
        // Transient/terminal states — no action needed
        break;
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[RTC:${targetPeerId}] ICE connection state:`, pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      dispatch({
        type: 'RTC_FAILED',
        reason:
          'ICE connection failed. Your network may be blocking WebRTC. Try a different network or contact your IT admin.',
        peerId: targetPeerId,
      });
    }
  };

  return pc;
}

/**
 * Resolve glare collision using the "perfect negotiation" pattern.
 *
 * **Glare** occurs when both peers send offers simultaneously. Resolution:
 * - **Polite** peer (lower peerId): rolls back own offer (if set), yields to remote.
 *   Also cancels any in-flight createOffer chain via `makingOfferPeers`.
 * - **Impolite** peer (higher peerId): ignores remote offer, waits for answer.
 *
 * @returns `true` if offer processing should continue, `false` to abort
 */
async function resolveGlareCollision(
  pc: RTCPeerConnection,
  ctx: MeshContext,
  fromPeerId: string,
  isPolite: boolean,
): Promise<boolean> {
  if (!isPolite) {
    console.log(
      `[RTC:${fromPeerId}] Glare: impolite peer ignoring remote offer, waiting for answer`,
    );
    return false;
  }

  // Polite peer: cancel pending offer chain and yield to remote offer
  console.log(`[RTC:${fromPeerId}] Glare: polite peer yielding to remote offer`);
  ctx.makingOfferPeers.delete(fromPeerId);

  if (pc.signalingState === 'have-local-offer') {
    try {
      await pc.setLocalDescription({ type: 'rollback' });
      if (ctx.peerConnections.get(fromPeerId) !== pc) return false;
    } catch (error) {
      if (ctx.peerConnections.get(fromPeerId) !== pc) return false;
      console.error(`[RTC:${fromPeerId}] Failed to rollback during glare:`, error);
      ctx.dispatch({
        type: 'RTC_FAILED',
        reason: `Glare rollback failed: ${(error as Error).message}`,
        peerId: fromPeerId,
      });
      return false;
    }
  }

  return true;
}

/**
 * Accept a remote offer and send an answer back.
 * Handles setRemoteDescription -> flush ICE -> createAnswer -> setLocalDescription -> send.
 */
async function acceptOfferAndAnswer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
  ctx: MeshContext,
  fromPeerId: string,
): Promise<void> {
  const { peerConnections, dispatch } = ctx;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (peerConnections.get(fromPeerId) !== pc) return;
    await flushPendingCandidates(pc, peerConnections, fromPeerId);
    if (peerConnections.get(fromPeerId) !== pc) return;
    const answer = await pc.createAnswer();
    if (peerConnections.get(fromPeerId) !== pc) return;
    await pc.setLocalDescription(answer);
    if (peerConnections.get(fromPeerId) !== pc) return;
    if (!answer.sdp) {
      dispatch({
        type: 'RTC_FAILED',
        reason: 'Created answer has no SDP',
        peerId: fromPeerId,
      });
      return;
    }
    sendMessage(ctx.ws, { type: 'answer', v: 1, sdp: answer.sdp, targetPeerId: fromPeerId });
    console.log(`[RTC:${fromPeerId}] Sent answer`);
  } catch (error) {
    if (peerConnections.get(fromPeerId) !== pc) return;
    console.error(`[RTC:${fromPeerId}] Failed to handle offer:`, error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to answer call: ${(error as Error).message}`,
      peerId: fromPeerId,
    });
  }
}

/**
 * Handle incoming offer (callee side), with glare resolution.
 *
 * Collision is detected by `makingOfferPeers.has(fromPeerId) || signalingState !== 'stable'`.
 * The `makingOfferPeers` set catches the race where createOffer() is pending but
 * setLocalDescription hasn't run yet (signalingState is still 'stable').
 *
 * @param pc - Peer connection for the remote peer
 * @param offer - Remote SDP offer to process
 * @param ctx - Shared mesh state (WebSocket, peer connections, dispatch, offer tracking)
 * @param fromPeerId - ID of the peer that sent the offer
 * @param isPolite - Whether this peer yields during glare (true = rollback own offer)
 */
export async function handleOffer(
  pc: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
  ctx: MeshContext,
  fromPeerId: string,
  isPolite: boolean,
): Promise<void> {
  if (ctx.peerConnections.get(fromPeerId) !== pc) return;

  // Collision = we're creating or have created our own offer for this peer
  const offerCollision = ctx.makingOfferPeers.has(fromPeerId) || pc.signalingState !== 'stable';

  if (offerCollision) {
    const shouldProceed = await resolveGlareCollision(pc, ctx, fromPeerId, isPolite);
    if (!shouldProceed || ctx.peerConnections.get(fromPeerId) !== pc) return;
  }

  if (pc.signalingState !== 'stable') {
    console.warn(`[RTC:${fromPeerId}] Ignoring offer: expected stable, got`, pc.signalingState);
    return;
  }

  await acceptOfferAndAnswer(pc, offer, ctx, fromPeerId);
}

/**
 * Handle incoming answer (caller side).
 * Sets the remote description and flushes any buffered ICE candidates.
 *
 * @param pc - Peer connection that sent the offer
 * @param answer - Remote SDP answer to apply
 * @param ctx - Shared mesh state (peer connections map, dispatch)
 * @param fromPeerId - ID of the peer that sent the answer
 */
export async function handleAnswer(
  pc: RTCPeerConnection,
  answer: RTCSessionDescriptionInit,
  ctx: MeshContext,
  fromPeerId: string,
): Promise<void> {
  const { peerConnections, dispatch } = ctx;
  if (peerConnections.get(fromPeerId) !== pc) return;

  if (pc.signalingState !== 'have-local-offer') {
    console.warn(
      `[RTC:${fromPeerId}] Ignoring stale answer: expected have-local-offer, got`,
      pc.signalingState,
    );
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    if (peerConnections.get(fromPeerId) !== pc) return;
    await flushPendingCandidates(pc, peerConnections, fromPeerId);
    if (peerConnections.get(fromPeerId) !== pc) return;
    console.log(`[RTC:${fromPeerId}] Answer received and set`);
  } catch (error) {
    if (peerConnections.get(fromPeerId) !== pc) return;
    console.error(`[RTC:${fromPeerId}] Failed to handle answer:`, error);
    dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to establish connection: ${(error as Error).message}`,
      peerId: fromPeerId,
    });
  }
}

/**
 * Handle incoming ICE candidate, buffering if remote description is not yet set.
 *
 * @param pc - Peer connection to add the candidate to
 * @param candidate - ICE candidate from the remote peer
 * @param ctx - Shared mesh state (peer connections map for staleness checks)
 * @param fromPeerId - ID of the peer that sent the candidate
 */
export async function handleIceCandidate(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInit,
  ctx: MeshContext,
  fromPeerId: string,
): Promise<void> {
  const { peerConnections } = ctx;
  if (peerConnections.get(fromPeerId) !== pc) return;

  if (!pc.remoteDescription) {
    let queue = pendingCandidates.get(pc);
    if (!queue) {
      queue = [];
      pendingCandidates.set(pc, queue);
    }
    queue.push(candidate);
    console.log(`[RTC:${fromPeerId}] Buffered ICE candidate (remote description not set yet)`);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    console.log(`[RTC:${fromPeerId}] ICE candidate added`);
  } catch (error) {
    if (peerConnections.get(fromPeerId) !== pc) return;
    console.warn(`[RTC:${fromPeerId}] Failed to add ICE candidate (non-fatal):`, error);
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
