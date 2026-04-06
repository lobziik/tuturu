/**
 * Connection status banner — shows when WebSocket is not connected.
 *
 * Displays "Connecting...", "Reconnecting (N/20)...", or "Disconnected" + Reconnect button.
 * Hidden when connected.
 *
 * @module components/ConnectionStatus
 */

import { useCallback } from 'preact/hooks';
import type { WsStatus } from '../state/types';
import type { Dispatch } from '../state/context';
import { MAX_RECONNECT_ATTEMPTS } from '../../shared/constants';

interface ConnectionStatusProps {
  /** Current WebSocket connection status */
  wsStatus: WsStatus;
  /** Current reconnect attempt number (0 = not reconnecting) */
  reconnectAttempt: number;
  /** State dispatch function (for reconnect button) */
  dispatch: Dispatch;
}

/** Format the status label based on wsStatus and reconnect progress */
function formatStatusLabel(wsStatus: Exclude<WsStatus, 'connected'>, attempt: number): string {
  switch (wsStatus) {
    case 'connecting':
      return 'Connecting...';
    case 'reconnecting':
      return attempt > 0
        ? `Reconnecting (${attempt}/${MAX_RECONNECT_ATTEMPTS})...`
        : 'Reconnecting...';
    case 'disconnected':
      return 'Disconnected';
  }
}

/** Thin banner below header showing connection status when not connected */
export function ConnectionStatus({
  wsStatus,
  reconnectAttempt,
  dispatch,
}: Readonly<ConnectionStatusProps>) {
  if (wsStatus === 'connected') return null;

  const handleReconnect = useCallback(() => {
    dispatch({ type: 'RECONNECT_REQUESTED' });
  }, [dispatch]);

  return (
    <div class={`connection-status connection-status-${wsStatus}`}>
      <span>{formatStatusLabel(wsStatus, reconnectAttempt)}</span>
      {wsStatus === 'disconnected' && (
        <button type="button" class="reconnect-btn" onClick={handleReconnect}>
          Reconnect
        </button>
      )}
    </div>
  );
}
