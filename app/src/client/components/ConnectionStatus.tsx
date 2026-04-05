/**
 * Connection status banner — shows when WebSocket is not connected.
 *
 * Displays "Connecting...", "Reconnecting...", or "Disconnected" based on wsStatus.
 * Hidden when connected.
 *
 * @module components/ConnectionStatus
 */

import type { WsStatus } from '../state/types';

interface ConnectionStatusProps {
  wsStatus: WsStatus;
}

const STATUS_LABELS: Record<Exclude<WsStatus, 'connected'>, string> = {
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
};

/** Thin banner below header showing connection status when not connected */
export function ConnectionStatus({ wsStatus }: Readonly<ConnectionStatusProps>) {
  if (wsStatus === 'connected') return null;

  return (
    <div class={`connection-status connection-status-${wsStatus}`}>{STATUS_LABELS[wsStatus]}</div>
  );
}
