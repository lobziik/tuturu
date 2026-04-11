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
import { sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen, getIceConfig } from './types';

/** Handle WebRTC-related side effects for mesh calls */
export function handleWebRTCEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;
  const newScreen = getScreen(newState);
  const iceConfig = getIceConfig(newState);
  const selfPeerId = newState.phase === 'room' ? newState.selfPeerId : null;

  // Guard: only process during call-related screens
  const callScreenActive = newScreen?.type === 'waiting-for-peer' || newScreen?.type === 'call';

  // ── CALL_PEERS_RECEIVED: diff connections, create/destroy PCs ──
  if (action.type === 'CALL_PEERS_RECEIVED' && callScreenActive && selfPeerId && iceConfig) {
    const remotePeers = new Set(action.callPeers.filter((id: string) => id !== selfPeerId));
    const currentPeers = new Set(refs.peerConnections.current.keys());

    // Create PCs for new peers
    for (const peerId of remotePeers) {
      if (currentPeers.has(peerId)) continue;

      const pc = createPeerConnection(
        {
          iceServers: iceConfig.iceServers ?? [],
          iceTransportPolicy: iceConfig.iceTransportPolicy,
        },
        refs.localStream.current,
        refs.ws.current,
        dispatch,
        peerId,
      );
      refs.peerConnections.current.set(peerId, pc);

      // Impolite peer (higher peerId) sends offer
      if (selfPeerId > peerId) {
        refs.makingOfferPeers.current.add(peerId);
        pc.createOffer()
          .then((offer) => {
            if (refs.peerConnections.current.get(peerId) !== pc) return;
            if (!refs.makingOfferPeers.current.has(peerId)) {
              console.log(`[RTC:${peerId}] Offer creation aborted (glare resolution yielded)`);
              return;
            }
            return pc.setLocalDescription(offer);
          })
          .then(() => {
            refs.makingOfferPeers.current.delete(peerId);
            if (refs.peerConnections.current.get(peerId) !== pc) return;
            if (pc.signalingState !== 'have-local-offer') return;
            const sdp = pc.localDescription?.sdp;
            if (!sdp) {
              throw new Error('localDescription has no SDP after setLocalDescription');
            }
            sendMessage(refs.ws.current, {
              type: 'offer',
              v: 1,
              sdp,
              targetPeerId: peerId,
            });
            console.log(`[RTC:${peerId}] Sent offer`);
          })
          .catch((error: Error) => {
            refs.makingOfferPeers.current.delete(peerId);
            if (refs.peerConnections.current.get(peerId) !== pc) return;
            console.error(`[RTC:${peerId}] Failed to create offer:`, error);
            dispatch({
              type: 'RTC_FAILED',
              reason: `Failed to create offer: ${error.message}`,
              peerId,
            });
          });
      }
      // Polite peer (lower peerId) waits for offer — PC is ready for incoming offer
    }

    // Close PCs for peers that left the call
    for (const peerId of currentPeers) {
      if (!remotePeers.has(peerId)) {
        const pc = refs.peerConnections.current.get(peerId);
        if (pc) closePeerConnection(pc);
        refs.peerConnections.current.delete(peerId);
        refs.remoteStreams.current.delete(peerId);
        refs.makingOfferPeers.current.delete(peerId);
        console.log(`[RTC:${peerId}] Peer left call, closed connection`);
      }
    }
  }

  // ── RECEIVED_OFFER: look up or create PC, handle as callee ──
  if (action.type === 'RECEIVED_OFFER' && callScreenActive && iceConfig && selfPeerId) {
    const fromPeerId = action.fromPeerId;
    let pc = refs.peerConnections.current.get(fromPeerId);
    if (!pc) {
      pc = createPeerConnection(
        {
          iceServers: iceConfig.iceServers ?? [],
          iceTransportPolicy: iceConfig.iceTransportPolicy,
        },
        refs.localStream.current,
        refs.ws.current,
        dispatch,
        fromPeerId,
      );
      refs.peerConnections.current.set(fromPeerId, pc);
    }

    const isPolite = selfPeerId < fromPeerId;
    void handleOffer(
      pc,
      action.offer,
      refs.ws.current,
      refs.peerConnections.current,
      fromPeerId,
      dispatch,
      isPolite,
      refs.makingOfferPeers.current,
    );
  }

  // ── RECEIVED_ANSWER: route to correct PC ──
  if (action.type === 'RECEIVED_ANSWER' && callScreenActive) {
    const pc = refs.peerConnections.current.get(action.fromPeerId);
    if (pc) {
      void handleAnswer(
        pc,
        action.answer,
        refs.peerConnections.current,
        action.fromPeerId,
        dispatch,
      );
    }
  }

  // ── RECEIVED_ICE_CANDIDATE: route to correct PC ──
  if (action.type === 'RECEIVED_ICE_CANDIDATE' && callScreenActive) {
    const pc = refs.peerConnections.current.get(action.fromPeerId);
    if (pc) {
      void handleIceCandidate(
        pc,
        action.candidate,
        refs.peerConnections.current,
        action.fromPeerId,
      );
    }
  }
}
