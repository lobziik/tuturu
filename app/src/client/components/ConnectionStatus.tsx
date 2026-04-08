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

  const statusColors =
    wsStatus === 'disconnected' ? 'bg-red-900 text-red-200' : 'bg-amber-900 text-amber-100';

  return (
    <div
      class={`flex items-center justify-center gap-2 px-4 py-1.5 text-center text-sm font-medium shrink-0 ${statusColors}`}
    >
      <span>{formatStatusLabel(wsStatus, reconnectAttempt)}</span>
      {wsStatus === 'disconnected' && (
        <button
          type="button"
          class="bg-transparent text-inherit border border-current rounded px-2 py-0.5 text-xs font-semibold cursor-pointer opacity-90 hover:opacity-100 hover:bg-white/10"
          onClick={handleReconnect}
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
