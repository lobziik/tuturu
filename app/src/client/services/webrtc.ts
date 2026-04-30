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
import {
  setupSenderTransform,
  setupReceiverTransform,
  parseNegotiatedCodecs,
} from '../e2ee/e2ee-transform';

type Dispatch = (action: Action) => void;

/** E2EE configuration for frame-level encryption/decryption on RTP streams. */
export interface E2eeConfig {
  /** E2EE Web Worker that performs frame encryption/decryption */
  worker: Worker;
  /** AES-GCM CryptoKey shared by all peers in the room */
  key: CryptoKey;
}

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

/**
 * E2EE config stashed per RTCPeerConnection. Looked up by
 * {@link applyE2eeTransforms} once SDP negotiation finalizes the codec.
 * WeakMap means the entry vanishes when the PC is collected — no manual cleanup.
 */
const e2eeConfigs = new WeakMap<RTCPeerConnection, E2eeConfig>();

/**
 * Senders/receivers that already have an E2EE transform attached. Reassigning
 * `.transform` on an endpoint is undefined behavior across browsers, so we
 * skip on second pass (renegotiation, both call sites firing for one PC).
 */
const e2eeAppliedSenders = new WeakSet<RTCRtpSender>();
const e2eeAppliedReceivers = new WeakSet<RTCRtpReceiver>();

/**
 * Apply E2EE encrypt/decrypt transforms to every transceiver on `pc`, sourcing
 * the negotiated codec from an SDP. No-op when the PC has no E2EE config.
 *
 * Must be called BEFORE `setRemoteDescription` on the callee path (with the
 * incoming offer SDP). iOS Safari attaches its receive pipeline the moment
 * `setRemoteDescription` resolves and silently ignores any
 * `RTCRtpReceiver.transform` set after that point — the receiver's
 * decrypt path stays empty and 100% of frames look like they were never
 * decrypted. Wiring before that point installs the transform onto the
 * local-side transceivers (created by `addTrack`/`addTransceiver` in
 * `createPeerConnection`) before Safari locks them in.
 *
 * On the caller path (`handleAnswer`) the receivers were already created at
 * `createPeerConnection` time via `addTrack`, so timing relative to
 * `setRemoteDescription` matters less; we keep the call there post-SRD with
 * the answer SDP for codec accuracy.
 *
 * Codec source per call site: callee uses the offer's first PT per m-line,
 * caller uses the answer's. For mesh between two browsers running the same
 * codec preferences (typical case), both sides land on the same first PT,
 * so encrypt/decrypt header sizes match. If they didn't, AAD would fail and
 * the worker counters would show steady `crypto-failed` — easy to spot.
 *
 * Throws if a transceiver with an active sender track has no negotiated
 * codec for that kind — callers (acceptOfferAndAnswer / handleAnswer) sit
 * inside try/catch blocks that dispatch RTC_FAILED, so the throw propagates
 * as a proper failure.
 */
function applyE2eeTransforms(pc: RTCPeerConnection, sdp: string): void {
  const e2ee = e2eeConfigs.get(pc);
  if (!e2ee) return;

  const codecs = parseNegotiatedCodecs(sdp);

  for (const transceiver of pc.getTransceivers()) {
    const sender = transceiver.sender;
    if (sender.track && !e2eeAppliedSenders.has(sender)) {
      const kind = sender.track.kind;
      if (kind !== 'audio' && kind !== 'video') {
        throw new Error(
          `[E2EE] Sender has unexpected track kind: ${kind} (mid=${transceiver.mid ?? '?'})`,
        );
      }
      const codec = codecs[kind];
      if (!codec) {
        throw new Error(
          `[E2EE] Sender (mid=${transceiver.mid ?? '?'}, kind=${kind}) has no negotiated codec in answer SDP`,
        );
      }
      setupSenderTransform(sender, e2ee.key, e2ee.worker, codec);
      e2eeAppliedSenders.add(sender);
    }

    const receiver = transceiver.receiver;
    if (!e2eeAppliedReceivers.has(receiver)) {
      const kind = receiver.track.kind;
      if (kind !== 'audio' && kind !== 'video') continue;
      // Absent means the m-line was rejected (port=0) — typically a remote
      // peer declining recvonly video on an audio-only call. No media
      // flows, so skip wiring a transform that would never fire.
      const codec = codecs[kind];
      if (!codec) continue;
      setupReceiverTransform(receiver, e2ee.key, e2ee.worker, codec);
      e2eeAppliedReceivers.add(receiver);
    }
  }
}

/**
 * Restrict every video transceiver on `pc` to VP8 (plus the RTX/red/ulpfec
 * helpers some Safari versions expect to see alongside).
 *
 * Mesh-only — the SFU server router caps already enforce VP8-only. Throws
 * when VP8 is missing from the browser's codec list: failing here is far
 * better than letting the call set up only to negotiate an E2EE-incompatible
 * codec. Must be called before any `createOffer`/`createAnswer`.
 */
function applyVp8VideoPreference(pc: RTCPeerConnection): void {
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps) {
    throw new Error('[E2EE] RTCRtpReceiver.getCapabilities("video") returned null');
  }
  const vp8 = caps.codecs.filter((c) => /^video\/vp8$/i.test(c.mimeType));
  if (vp8.length === 0) {
    throw new Error('[E2EE] Browser does not advertise VP8 — cannot enforce E2EE-safe codec');
  }
  const helpers = caps.codecs.filter((c) => /^video\/(rtx|red|ulpfec)$/i.test(c.mimeType));
  const ordered = [...vp8, ...helpers];

  for (const t of pc.getTransceivers()) {
    const kind = t.sender.track?.kind ?? t.receiver.track?.kind ?? null;
    if (kind !== 'video') continue;
    t.setCodecPreferences(ordered);
  }
}

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
 * @param e2ee - Optional E2EE config for frame-level encryption on RTP streams
 * @returns Configured RTCPeerConnection instance
 */
export function createPeerConnection(
  config: PeerConnectionConfig,
  localStream: MediaStream | null,
  ws: WebSocket | null,
  dispatch: Dispatch,
  targetPeerId: string,
  e2ee?: E2eeConfig,
): RTCPeerConnection {
  console.log(`[RTC:${targetPeerId}] Creating peer connection`);
  console.log(`[RTC:${targetPeerId}] ICE transport policy:`, config.iceTransportPolicy);

  // Chrome requires `encodedInsertableStreams: true` on the underlying
  // RTCPeerConnection for `RTCRtpScriptTransform` to actually deliver
  // frames to the worker — without it, the rtctransform event fires but
  // the readable stream stays empty (frames bypass the worker entirely,
  // and stats show 0 packets through the transform). Standard
  // RTCConfiguration doesn't declare it; cast through Partial. Safari
  // accepts and ignores the flag; harmless when E2EE is off. Matches
  // the SFU path's `additionalSettings` in `sfu/transport.ts`.
  const pcConfig: RTCConfiguration = {
    iceServers: config.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined && { username: s.username }),
      ...(s.credential !== undefined && { credential: s.credential }),
    })),
    iceTransportPolicy: config.iceTransportPolicy,
    ...({ encodedInsertableStreams: true } as Partial<RTCConfiguration>),
  };
  const pc = new RTCPeerConnection(pcConfig);

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

  // Stash the E2EE config; applyE2eeTransforms wires up the actual sender/
  // receiver transforms once SDP negotiation has settled the codec on this
  // side (see applyE2eeTransforms — codec is unknown in mesh until the
  // answer SDP is applied, so we can't set transforms here).
  if (e2ee) {
    e2eeConfigs.set(pc, e2ee);
    // Restrict video to VP8 before any offer/answer is created. Safari's
    // H264 path produces frame metadata that's incompatible with Chrome's
    // E2EE pipeline, so we keep mesh on VP8 whenever E2EE is on. SFU side
    // already enforces VP8 via mediasoup router caps.
    applyVp8VideoPreference(pc);
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
    if (!offer.sdp) {
      dispatch({
        type: 'RTC_FAILED',
        reason: 'Received offer has no SDP',
        peerId: fromPeerId,
      });
      return;
    }
    // Wire E2EE transforms BEFORE setRemoteDescription. iOS Safari attaches
    // its receive pipeline the moment SRD resolves; transforms set after
    // that point are silently ignored on the receiver, so 0 frames ever
    // get decrypted. Codec source is the offer's first PT — see
    // applyE2eeTransforms doc-block for the codec-agreement assumption.
    applyE2eeTransforms(pc, offer.sdp);

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
    if (!answer.sdp) {
      dispatch({
        type: 'RTC_FAILED',
        reason: 'Received answer has no SDP',
        peerId: fromPeerId,
      });
      return;
    }
    // Remote answer just locked in the codec on this side — wire E2EE transforms
    // before ICE/DTLS open the data path.
    applyE2eeTransforms(pc, answer.sdp);
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
