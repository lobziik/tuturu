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
import type { MeshContext, E2eeConfig } from '../../services/webrtc';
import { sendMessage } from '../../services/websocket';
import { isE2eeSupported, createE2eeWorker } from '../../e2ee/e2ee-transform';
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
 * Build E2EE config from refs, lazily creating the worker if needed.
 *
 * When the server has E2EE disabled (`e2eeMediaEnabled === false`) we skip
 * wiring the script transform entirely — the call runs as plain WebRTC. When
 * the server requires E2EE but the browser cannot provide it, throw rather
 * than silently downgrading: the call cannot proceed without breaking server
 * policy, and {@link refuseUnsupportedBrowser} should have caught this at
 * `JOINED_ROOM` time. Reaching here means a feature-detection regression.
 */
function buildE2eeConfig(refs: ResourceRefs, e2eeMediaEnabled: boolean): E2eeConfig | undefined {
  if (!e2eeMediaEnabled) return undefined;
  if (!refs.aesKey.current) return undefined;

  if (!refs.e2eeWorker.current && isE2eeSupported()) {
    refs.e2eeWorker.current = createE2eeWorker();
  }

  if (!refs.e2eeWorker.current) {
    throw new Error(
      '[E2EE] Server requires E2EE but RTCRtpScriptTransform is not available in this browser',
    );
  }

  return { worker: refs.e2eeWorker.current, key: refs.aesKey.current };
}

/**
 * Wrap PC construction so a throw from `buildE2eeConfig` (server requires E2EE
 * but the browser doesn't support RTCRtpScriptTransform) or from
 * `applyVp8VideoPreference` (browser doesn't advertise VP8) surfaces as
 * RTC_FAILED on the specific peer instead of bubbling into the App.tsx
 * dispatch loop and tearing the app down. Returns null on failure; callers
 * skip the rest of their per-peer setup when null.
 */
function safeCreatePeerConnection(
  refs: ResourceRefs,
  iceConfig: IceConfig,
  meshCtx: MeshContext,
  peerId: string,
  e2eeMediaEnabled: boolean,
): RTCPeerConnection | null {
  try {
    const e2ee = buildE2eeConfig(refs, e2eeMediaEnabled);
    return createPeerConnection(
      {
        iceServers: iceConfig.iceServers ?? [],
        iceTransportPolicy: iceConfig.iceTransportPolicy,
      },
      refs.localStream.current,
      meshCtx.ws,
      meshCtx.dispatch,
      peerId,
      e2ee,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[RTC:${peerId}] Failed to create peer connection:`, error);
    meshCtx.dispatch({
      type: 'RTC_FAILED',
      reason: `Failed to create peer connection: ${message}`,
      peerId,
    });
    return null;
  }
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
  e2eeMediaEnabled: boolean,
): void {
  const { peerConnections, makingOfferPeers } = meshCtx;
  const remotePeers = new Set(action.callPeers.filter((id: string) => id !== selfPeerId));
  const currentPeers = new Set(peerConnections.keys());

  // Create PCs for new peers
  for (const peerId of remotePeers) {
    if (currentPeers.has(peerId)) continue;

    const pc = safeCreatePeerConnection(refs, iceConfig, meshCtx, peerId, e2eeMediaEnabled);
    if (!pc) continue;
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
  e2eeMediaEnabled: boolean,
): void {
  const { fromPeerId } = action;
  let pc = meshCtx.peerConnections.get(fromPeerId);
  if (!pc) {
    const created = safeCreatePeerConnection(
      refs,
      iceConfig,
      meshCtx,
      fromPeerId,
      e2eeMediaEnabled,
    );
    if (!created) return;
    pc = created;
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

/**
 * Refuse to enter the room when the server requires E2EE but the browser
 * cannot deliver it. Surfaces a clear error rather than letting the call
 * silently proceed without encryption (which would violate server policy) or
 * fail later inside `applyE2eeTransforms()` with a less obvious message.
 */
function refuseUnsupportedBrowser(ctx: EffectContext, args: EffectArgs): void {
  const { dispatch } = ctx;
  const { action, newState } = args;
  if (action.type !== 'JOINED_ROOM') return;
  if (newState.phase !== 'room') return;
  if (!newState.e2eeMediaEnabled) return;
  if (isE2eeSupported()) return;

  dispatch({
    type: 'SERVER_ERROR',
    error:
      'This browser does not support end-to-end encryption (RTCRtpScriptTransform). ' +
      'Use Chrome, Edge, or Safari 16+, or ask the operator to disable E2EE.',
  });
}

/** Handle WebRTC-related side effects for mesh calls */
export function handleWebRTCEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;
  const newScreen = getScreen(newState);
  const iceConfig = getIceConfig(newState);
  const selfPeerId = newState.phase === 'room' ? newState.selfPeerId : null;

  // Run before the call-screen guard — JOINED_ROOM fires while still in idle.
  refuseUnsupportedBrowser(ctx, args);

  // Guard: only process during call-related screens, and not in SFU mode
  const callScreenActive = newScreen?.type === 'waiting-for-peer' || newScreen?.type === 'call';
  if (!callScreenActive) return;
  const sfuMode = newState.phase === 'room' && newState.sfuMode;
  if (sfuMode) return;
  const e2eeMediaEnabled = newState.phase === 'room' && newState.e2eeMediaEnabled;

  const meshCtx = buildMeshContext(refs, dispatch);

  if (action.type === 'CALL_PEERS_RECEIVED' && selfPeerId && iceConfig) {
    handleCallPeersEffect(action, refs, meshCtx, selfPeerId, iceConfig, e2eeMediaEnabled);
  }

  if (action.type === 'RECEIVED_OFFER' && iceConfig && selfPeerId) {
    handleReceivedOfferEffect(action, refs, meshCtx, selfPeerId, iceConfig, e2eeMediaEnabled);
  }

  if (action.type === 'RECEIVED_ANSWER') {
    handleReceivedAnswerEffect(action, meshCtx);
  }

  if (action.type === 'RECEIVED_ICE_CANDIDATE') {
    handleReceivedIceCandidateEffect(action, meshCtx);
  }
}
