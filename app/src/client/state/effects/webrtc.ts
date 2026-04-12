/**
 * WebRTC side effects — mesh peer connection lifecycle, offer/answer/ICE handling.
 *
 * Connection management is driven by CALL_PEERS_RECEIVED: the effect diffs
 * current connections against the new peer list and creates/destroys PCs.
 *
 * For each peer pair, polite/impolite is determined by peerId comparison:
 * higher peerId = impolite (sends offer), lower = polite (waits for offer).
 *
 * Staleness is checked per-peer: if `peerConnections.get(peerId) !== pc`,
 * the connection was replaced or removed and the async operation aborts.
 *
 * @module state/effects/webrtc
 */

import {
  createPeerConnection,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  closePeerConnection,
} from '../../services/webrtc';
import type { MeshContext } from '../../services/webrtc';
import { sendMessage } from '../../services/websocket';
import type { Action } from '../types';
import {
  getScreen,
  getIceConfig,
  type EffectContext,
  type EffectArgs,
  type ResourceRefs,
  type IceConfig,
} from './types';

/** Build a MeshContext from ResourceRefs */
function buildMeshContext(refs: ResourceRefs, dispatch: (action: Action) => void): MeshContext {
  return {
    ws: refs.ws.current,
    peerConnections: refs.peerConnections.current,
    dispatch,
    makingOfferPeers: refs.makingOfferPeers.current,
  };
}

/**
 * Handle CALL_PEERS_RECEIVED: diff current connections vs new peer list.
 * Creates PCs for new peers (impolite sends offer), closes PCs for removed peers.
 */
function handleCallPeersEffect(
  action: Extract<Action, { type: 'CALL_PEERS_RECEIVED' }>,
  refs: ResourceRefs,
  meshCtx: MeshContext,
  selfPeerId: string,
  iceConfig: IceConfig,
): void {
  const { peerConnections, makingOfferPeers, dispatch } = meshCtx;
  const remotePeers = new Set(action.callPeers.filter((id: string) => id !== selfPeerId));
  const currentPeers = new Set(peerConnections.keys());

  // Create PCs for new peers
  for (const peerId of remotePeers) {
    if (currentPeers.has(peerId)) continue;

    const pc = createPeerConnection(
      {
        iceServers: iceConfig.iceServers ?? [],
        iceTransportPolicy: iceConfig.iceTransportPolicy,
      },
      refs.localStream.current,
      meshCtx.ws,
      dispatch,
      peerId,
    );
    peerConnections.set(peerId, pc);

    // Impolite peer (higher peerId) sends offer
    if (selfPeerId > peerId) {
      sendOfferToPeer(pc, peerId, meshCtx);
    }
    // Polite peer (lower peerId) waits for offer — PC is ready for incoming offer
  }

  // Close PCs for peers that left the call
  for (const peerId of currentPeers) {
    if (!remotePeers.has(peerId)) {
      const pc = peerConnections.get(peerId);
      if (pc) closePeerConnection(pc);
      peerConnections.delete(peerId);
      refs.remoteStreams.current.delete(peerId);
      makingOfferPeers.delete(peerId);
      console.log(`[RTC:${peerId}] Peer left call, closed connection`);
    }
  }
}

/** Create and send an SDP offer for a specific peer (impolite side) */
function sendOfferToPeer(pc: RTCPeerConnection, peerId: string, meshCtx: MeshContext): void {
  const { peerConnections, makingOfferPeers, ws, dispatch } = meshCtx;
  makingOfferPeers.add(peerId);
  pc.createOffer()
    .then((offer) => {
      if (peerConnections.get(peerId) !== pc) return;
      if (!makingOfferPeers.has(peerId)) {
        console.log(`[RTC:${peerId}] Offer creation aborted (glare resolution yielded)`);
        return;
      }
      return pc.setLocalDescription(offer);
    })
    .then(() => {
      makingOfferPeers.delete(peerId);
      if (peerConnections.get(peerId) !== pc) return;
      if (pc.signalingState !== 'have-local-offer') return;
      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        throw new Error('localDescription has no SDP after setLocalDescription');
      }
      sendMessage(ws, {
        type: 'offer',
        v: 1,
        sdp,
        targetPeerId: peerId,
      });
      console.log(`[RTC:${peerId}] Sent offer`);
    })
    .catch((error: Error) => {
      makingOfferPeers.delete(peerId);
      if (peerConnections.get(peerId) !== pc) return;
      console.error(`[RTC:${peerId}] Failed to create offer:`, error);
      dispatch({
        type: 'RTC_FAILED',
        reason: `Failed to create offer: ${error.message}`,
        peerId,
      });
    });
}

/** Handle RECEIVED_OFFER: look up or create PC, handle as callee */
function handleReceivedOfferEffect(
  action: Extract<Action, { type: 'RECEIVED_OFFER' }>,
  refs: ResourceRefs,
  meshCtx: MeshContext,
  selfPeerId: string,
  iceConfig: IceConfig,
): void {
  const { fromPeerId } = action;
  let pc = meshCtx.peerConnections.get(fromPeerId);
  if (!pc) {
    pc = createPeerConnection(
      {
        iceServers: iceConfig.iceServers ?? [],
        iceTransportPolicy: iceConfig.iceTransportPolicy,
      },
      refs.localStream.current,
      meshCtx.ws,
      meshCtx.dispatch,
      fromPeerId,
    );
    meshCtx.peerConnections.set(fromPeerId, pc);
  }

  const isPolite = selfPeerId < fromPeerId;
  void handleOffer(pc, action.offer, meshCtx, fromPeerId, isPolite);
}

/** Handle RECEIVED_ANSWER: route to correct PC */
function handleReceivedAnswerEffect(
  action: Extract<Action, { type: 'RECEIVED_ANSWER' }>,
  meshCtx: MeshContext,
): void {
  const pc = meshCtx.peerConnections.get(action.fromPeerId);
  if (!pc) return;

  void handleAnswer(pc, action.answer, meshCtx, action.fromPeerId);
}

/** Handle RECEIVED_ICE_CANDIDATE: route to correct PC */
function handleReceivedIceCandidateEffect(
  action: Extract<Action, { type: 'RECEIVED_ICE_CANDIDATE' }>,
  meshCtx: MeshContext,
): void {
  const pc = meshCtx.peerConnections.get(action.fromPeerId);
  if (!pc) return;

  void handleIceCandidate(pc, action.candidate, meshCtx, action.fromPeerId);
}

/** Handle WebRTC-related side effects for mesh calls */
export function handleWebRTCEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;
  const newScreen = getScreen(newState);
  const iceConfig = getIceConfig(newState);
  const selfPeerId = newState.phase === 'room' ? newState.selfPeerId : null;

  // Guard: only process during call-related screens, and not in SFU mode
  const callScreenActive = newScreen?.type === 'waiting-for-peer' || newScreen?.type === 'call';
  if (!callScreenActive) return;
  const sfuMode = newState.phase === 'room' && newState.sfuMode;
  if (sfuMode) return;

  const meshCtx = buildMeshContext(refs, dispatch);

  if (action.type === 'CALL_PEERS_RECEIVED' && selfPeerId && iceConfig) {
    handleCallPeersEffect(action, refs, meshCtx, selfPeerId, iceConfig);
  }

  if (action.type === 'RECEIVED_OFFER' && iceConfig && selfPeerId) {
    handleReceivedOfferEffect(action, refs, meshCtx, selfPeerId, iceConfig);
  }

  if (action.type === 'RECEIVED_ANSWER') {
    handleReceivedAnswerEffect(action, meshCtx);
  }

  if (action.type === 'RECEIVED_ICE_CANDIDATE') {
    handleReceivedIceCandidateEffect(action, meshCtx);
  }
}
