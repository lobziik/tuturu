/**
 * WebRTC side effects — peer connection lifecycle, offer/answer/ICE handling.
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

/** Handle WebRTC-related side effects */
export function handleWebRTCEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevScreen, newScreen } = args;
  const newState = args.newState;

  // Entering negotiating as caller → Create peer connection and send offer
  if (
    newScreen === 'negotiating' &&
    prevScreen !== 'negotiating' &&
    newState.screen.type === 'negotiating' &&
    newState.screen.role === 'caller'
  ) {
    const pc = createPeerConnection(
      {
        iceServers: newState.iceServers ?? [],
        iceTransportPolicy: newState.iceTransportPolicy,
      },
      refs.localStream.current,
      refs.ws.current,
      dispatch,
    );
    refs.pc.current = pc;

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendMessage(refs.ws.current, { type: 'offer', data: pc.localDescription! });
        console.log('[RTC] Sent offer');
      })
      .catch((error: Error) => {
        console.error('[RTC] Failed to create offer:', error);
        dispatch({
          type: 'RTC_FAILED',
          reason: `Failed to create offer: ${error.message}`,
        });
      });
  }

  // Received offer → Create peer connection (if needed) and handle as callee
  if (action.type === 'RECEIVED_OFFER') {
    if (!refs.pc.current) {
      const pc = createPeerConnection(
        {
          iceServers: newState.iceServers ?? [],
          iceTransportPolicy: newState.iceTransportPolicy,
        },
        refs.localStream.current,
        refs.ws.current,
        dispatch,
      );
      refs.pc.current = pc;
    }
    void handleOffer(refs.pc.current, action.offer, refs.ws.current, dispatch);
  }

  // Received answer → Set remote description
  if (action.type === 'RECEIVED_ANSWER') {
    void handleAnswer(refs.pc.current, action.answer, dispatch);
  }

  // Received ICE candidate → Add to peer connection
  if (action.type === 'RECEIVED_ICE_CANDIDATE') {
    void handleIceCandidate(refs.pc.current, action.candidate, dispatch);
  }
}
