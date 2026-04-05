/**
 * WebSocket connection management
 * Handles WebSocket lifecycle and message routing
 *
 * Translates between v2 wire format (from server) and v1 client actions.
 */

import type { ServerToClientMessage, ClientToServerMessage } from '../../shared/types';
import type { Action } from '../state/types';

type Dispatch = (action: Action) => void;

/** Create WebSocket connection to signaling server */
export function createWebSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  console.log('[WS] Creating connection to', wsUrl);
  return new WebSocket(wsUrl);
}

/** Set up WebSocket event handlers that dispatch state machine actions */
export function setupWebSocketHandlers(dispatch: Dispatch, ws: WebSocket): void {
  ws.onopen = () => {
    console.log('[WS] Connected');
    dispatch({ type: 'WS_CONNECTED' });
  };

  ws.onerror = (error) => {
    console.error('[WS] Connection error:', error);
    dispatch({
      type: 'WS_ERROR',
      error: 'WebSocket connection failed. Check server is running.',
    });
  };

  ws.onclose = (event: CloseEvent) => {
    console.log('[WS] Connection closed:', event.code, event.reason);
    const intentional = event.code === 1000 && event.reason === 'User ended call';
    dispatch({
      type: 'WS_CLOSED',
      code: event.code,
      reason: event.reason,
      intentional,
    });
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as ServerToClientMessage;
    handleServerMessage(message, dispatch);
  };
}

/** Map incoming v2 server messages to state machine actions */
function handleServerMessage(message: ServerToClientMessage, dispatch: Dispatch): void {
  console.log('[WS] Received:', message.type);

  switch (message.type) {
    case 'join':
      dispatch({
        type: 'JOINED_ROOM',
        iceServers: message.iceServers,
        iceTransportPolicy: message.iceTransportPolicy,
      });
      break;

    case 'peer-joined':
      dispatch({ type: 'PEER_JOINED' });
      break;

    case 'offer':
      dispatch({
        type: 'RECEIVED_OFFER',
        offer: { type: 'offer', sdp: message.sdp },
      });
      break;

    case 'answer':
      dispatch({
        type: 'RECEIVED_ANSWER',
        answer: { type: 'answer', sdp: message.sdp },
      });
      break;

    case 'ice-candidate':
      dispatch({
        type: 'RECEIVED_ICE_CANDIDATE',
        candidate: message.candidate as RTCIceCandidateInit,
      });
      break;

    case 'peer-left':
      dispatch({ type: 'PEER_LEFT' });
      break;

    case 'error':
      dispatch({
        type: 'SERVER_ERROR',
        error: message.message,
      });
      break;
  }
}

/** Send typed v2 message to server via WebSocket */
export function sendMessage(ws: WebSocket | null, message: ClientToServerMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[WS] Cannot send message, WebSocket not connected');
    return;
  }
  console.log('[WS] Sending:', message.type);
  ws.send(JSON.stringify(message));
}

/** Close WebSocket with proper close code */
export function closeWebSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000, 'User ended call');
  }
}
