/**
 * WebSocket connection management
 * Handles WebSocket lifecycle and message routing
 */

import type { ServerToClientMessage, ClientToServerMessage } from '../types';
import type { Action } from './state';

/**
 * Dispatch function type - all modules receive this to trigger state transitions
 */
type Dispatch = (action: Action) => void;

/**
 * Connect to WebSocket server
 * Creates connection, sets up event handlers, and dispatches appropriate actions
 *
 * @param dispatch - Function to dispatch state machine actions
 * @param ws - WebSocket instance to configure (created externally to track in state)
 *
 * @remarks
 * Event handlers dispatch actions instead of mutating state directly:
 * - onopen → WS_CONNECTED
 * - onerror → WS_ERROR
 * - onclose → WS_CLOSED (with intentional flag)
 * - onmessage → Various signaling actions (PEER_JOINED, RECEIVED_OFFER, etc.)
 */
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

    // Intentional close has code 1000 and specific reason
    const intentional = event.code === 1000 && event.reason === 'User ended call';

    dispatch({
      type: 'WS_CLOSED',
      code: event.code,
      reason: event.reason,
      intentional,
    });
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    const message: ServerToClientMessage = JSON.parse(event.data);
    handleServerMessage(message, dispatch);
  };
}

/**
 * Create WebSocket connection to signaling server
 * Automatically determines protocol (ws: or wss:) based on page protocol
 *
 * @returns WebSocket instance (not yet opened - handlers should be set up first)
 *
 * @remarks
 * Use https: → wss: for secure connection (required for WebRTC in production)
 * Use http: → ws: for local development
 */
export function createWebSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  console.log('[WS] Creating connection to', wsUrl);

  return new WebSocket(wsUrl);
}

/**
 * Handle incoming server messages and dispatch corresponding actions
 * Maps WebSocket messages to state machine actions
 *
 * @param message - Parsed message from server (type-safe union)
 * @param dispatch - Function to dispatch state machine actions
 *
 * @remarks
 * Message routing:
 * - join-pin → JOINED_ROOM (with ICE servers)
 * - peer-joined → PEER_JOINED (first peer creates offer)
 * - offer → RECEIVED_OFFER (second peer creates answer)
 * - answer → RECEIVED_ANSWER (first peer sets remote description)
 * - ice-candidate → RECEIVED_ICE_CANDIDATE (both peers exchange candidates)
 * - peer-left → PEER_LEFT
 * - error → SERVER_ERROR
 */
function handleServerMessage(message: ServerToClientMessage, dispatch: Dispatch): void {
  console.log('[WS] Received:', message.type);

  switch (message.type) {
    case 'join-pin':
      dispatch({
        type: 'JOINED_ROOM',
        iceServers: message.data.iceServers,
        iceTransportPolicy: message.data.iceTransportPolicy,
      });
      break;

    case 'peer-joined':
      dispatch({ type: 'PEER_JOINED' });
      break;

    case 'offer':
      dispatch({ type: 'RECEIVED_OFFER', offer: message.data });
      break;

    case 'answer':
      dispatch({ type: 'RECEIVED_ANSWER', answer: message.data });
      break;

    case 'ice-candidate':
      dispatch({ type: 'RECEIVED_ICE_CANDIDATE', candidate: message.data });
      break;

    case 'peer-left':
      dispatch({ type: 'PEER_LEFT' });
      break;

    case 'error':
      dispatch({ type: 'SERVER_ERROR', error: message.error });
      break;
  }
}

/**
 * Send message to server via WebSocket
 * Safely handles disconnected state (logs error instead of throwing)
 *
 * @param ws - WebSocket connection (may be null or closed)
 * @param message - Type-safe message to send (ClientToServerMessage union)
 *
 * @remarks
 * FAIL FAST: Logs error if WebSocket not connected but doesn't throw.
 * This prevents crashes when cleanup happens in wrong order.
 */
export function sendMessage(ws: WebSocket | null, message: ClientToServerMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[WS] Cannot send message, WebSocket not connected');
    return;
  }

  console.log('[WS] Sending:', message.type);
  ws.send(JSON.stringify(message));
}

/**
 * Close WebSocket connection with proper close code
 *
 * @param ws - WebSocket to close
 *
 * @remarks
 * Uses code 1000 (normal closure) with reason "User ended call"
 * This allows distinguishing intentional disconnects from errors
 */
export function closeWebSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000, 'User ended call');
  }
}
