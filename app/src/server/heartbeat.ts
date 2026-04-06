/**
 * Per-connection heartbeat with ping/pong.
 *
 * Server sends pings at regular intervals.
 * If no pong is received within the timeout, the connection is considered dead.
 *
 * @module server/heartbeat
 */

import { WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS } from '../shared/constants';

/** Heartbeat controller for a single WebSocket connection */
export interface Heartbeat {
  /** Begin sending periodic pings and start pong deadline. */
  start(): void;
  /** Reset the pong deadline timer (called when pong is received). */
  receivedPong(): void;
  /** Stop all timers. Safe to call multiple times. */
  stop(): void;
}

/**
 * Create a heartbeat controller for a WebSocket connection.
 *
 * @param sendPing - Callback to send a ping message to the client
 * @param onTimeout - Called when the client fails to respond with pong in time
 * @param options - Override default intervals (useful for testing)
 */
export function createHeartbeat(
  sendPing: () => void,
  onTimeout: () => void,
  options?: { pingIntervalMs?: number; pongTimeoutMs?: number },
): Heartbeat {
  const pingInterval = options?.pingIntervalMs ?? WS_PING_INTERVAL_MS;
  const pongTimeout = options?.pongTimeoutMs ?? WS_PONG_TIMEOUT_MS;

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongDeadline: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function resetPongDeadline(): void {
    if (stopped) return;
    if (pongDeadline !== null) clearTimeout(pongDeadline);
    pongDeadline = setTimeout(() => {
      if (!stopped) {
        stopped = true;
        cleanup();
        onTimeout();
      }
    }, pongTimeout);
  }

  function cleanup(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (pongDeadline !== null) {
      clearTimeout(pongDeadline);
      pongDeadline = null;
    }
  }

  function start(): void {
    if (stopped) return;
    pingTimer = setInterval(() => {
      if (!stopped) sendPing();
    }, pingInterval);
    resetPongDeadline();
  }

  function receivedPong(): void {
    if (stopped) return;
    resetPongDeadline();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cleanup();
  }

  return { start, receivedPong, stop };
}
