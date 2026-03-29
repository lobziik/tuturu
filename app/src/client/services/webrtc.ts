/**
 * WebRTC peer connection management
 * Handles RTCPeerConnection lifecycle, offer/answer negotiation, and ICE handling
 */

import type { IceServerConfig, IceTransportPolicy } from '../../types';
import type { Action } from '../state/types';
import { sendMessage } from './websocket';

type Dispatch = (action: Action) => void;

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
    iceServers: config.iceServers,
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
      sendMessage(ws, { type: 'ice-candidate', data: event.candidate });
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

/** Handle incoming offer (callee side) */
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

/** Handle incoming answer (caller side) */
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

/** Handle incoming ICE candidate */
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
    console.warn('[RTC] Failed to add ICE candidate (non-fatal):', error);
  }
}

/** Close peer connection and release resources */
export function closePeerConnection(pc: RTCPeerConnection): void {
  if (pc.connectionState !== 'closed') {
    pc.close();
    console.log('[RTC] Peer connection closed');
  }
}
