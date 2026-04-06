/**
 * WebRTC side effects — peer connection lifecycle, offer/answer/ICE handling.
 *
 * All async operations use `refs.pc` as a staleness guard: if `refs.pc.current`
 * no longer points to the PC the operation started with, the call session changed
 * (hangup, peer-left, error) and the operation silently aborts. This eliminates
 * the class of race conditions where async work from call N leaks into call N+1.
 *
 * @module state/effects/webrtc
 */

import {
  createPeerConnection,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
} from '../../services/webrtc';
import { sendMessage } from '../../services/websocket';
import type { EffectContext, EffectArgs } from './types';
import { getScreen, getIceConfig } from './types';

/** Handle WebRTC-related side effects */
export function handleWebRTCEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);
  const iceConfig = getIceConfig(newState);

  // Entering negotiating as caller → Create peer connection and send offer
  if (
    prevScreen?.type !== 'negotiating' &&
    newScreen?.type === 'negotiating' &&
    newScreen.role === 'caller' &&
    iceConfig
  ) {
    const pc = createPeerConnection(
      {
        iceServers: iceConfig.iceServers ?? [],
        iceTransportPolicy: iceConfig.iceTransportPolicy,
      },
      refs.localStream.current,
      refs.ws.current,
      dispatch,
    );
    refs.pc.current = pc;

    // makingOffer guards against glare: if RECEIVED_OFFER arrives while
    // createOffer is in flight (signalingState still 'stable'), handleOffer
    // can detect the collision via this flag.
    refs.makingOffer.current = true;
    pc.createOffer()
      .then((offer) => {
        if (refs.pc.current !== pc) return;
        // Polite glare resolution may have cleared makingOffer → abort
        if (!refs.makingOffer.current) {
          console.log('[RTC] Offer creation aborted (glare resolution yielded)');
          return;
        }
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        refs.makingOffer.current = false;
        if (refs.pc.current !== pc) return;
        // After polite glare rollback, signalingState won't be have-local-offer
        if (pc.signalingState !== 'have-local-offer') return;
        const sdp = pc.localDescription?.sdp;
        if (!sdp) {
          throw new Error('localDescription has no SDP after setLocalDescription');
        }
        sendMessage(refs.ws.current, { type: 'offer', v: 1, sdp });
        console.log('[RTC] Sent offer');
      })
      .catch((error: Error) => {
        refs.makingOffer.current = false;
        if (refs.pc.current !== pc) return;
        console.error('[RTC] Failed to create offer:', error);
        dispatch({
          type: 'RTC_FAILED',
          reason: `Failed to create offer: ${error.message}`,
        });
      });
  }

  // Received offer → Create peer connection (if needed) and handle as callee.
  // Includes glare resolution: if both peers sent offers simultaneously,
  // the polite peer (lower peerId) rolls back its own offer and accepts.
  // Guard: only process during call-related screens (waiting-for-peer, negotiating).
  // Without this, a stale offer on idle screen would create an orphaned PC.
  const offerScreenValid =
    newScreen?.type === 'waiting-for-peer' || newScreen?.type === 'negotiating';
  if (action.type === 'RECEIVED_OFFER' && iceConfig && offerScreenValid) {
    if (!refs.pc.current) {
      const pc = createPeerConnection(
        {
          iceServers: iceConfig.iceServers ?? [],
          iceTransportPolicy: iceConfig.iceTransportPolicy,
        },
        refs.localStream.current,
        refs.ws.current,
        dispatch,
      );
      refs.pc.current = pc;
    }

    const selfPeerId = newState.phase === 'room' ? newState.selfPeerId : null;
    const isPolite =
      selfPeerId != null && action.fromPeerId != null && selfPeerId < action.fromPeerId;

    void handleOffer(
      refs.pc.current,
      action.offer,
      refs.ws.current,
      refs.pc,
      dispatch,
      isPolite,
      refs.makingOffer,
    );
  }

  // Received answer → Set remote description (only during active negotiation)
  if (action.type === 'RECEIVED_ANSWER' && newScreen?.type === 'negotiating') {
    void handleAnswer(refs.pc.current, action.answer, refs.pc, dispatch);
  }

  // Received ICE candidate → Add to peer connection (only during call-related screens)
  if (action.type === 'RECEIVED_ICE_CANDIDATE' && newScreen && 'muted' in newScreen) {
    void handleIceCandidate(refs.pc.current, action.candidate, refs.pc);
  }
}
