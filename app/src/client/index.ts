/**
 * tuturu WebRTC Client - Entry Point
 * State machine architecture with unidirectional data flow
 */

import type { Action } from './state';
import { initialState, reducer } from './state';
import { render } from './render';
import { handleSideEffects } from './effects';
import { setupEventListeners } from './events';

/**
 * Application state - single source of truth
 * Mutated only by dispatch function
 */
let state = initialState;

/**
 * Dispatch function - central hub for all state changes
 * Implements unidirectional data flow: Action → Reducer → Side Effects → Render
 *
 * @param action - Action describing what happened
 *
 * @remarks
 * Data Flow:
 * 1. Log action for debugging (time-travel debugging possible)
 * 2. Run reducer to get new state (pure function)
 * 3. Execute side effects based on state transition
 * 4. Render DOM to match new state
 *
 * Every state change goes through this function, making the app predictable:
 * - User clicks button → dispatch(action)
 * - WebSocket message arrives → dispatch(action)
 * - WebRTC event fires → dispatch(action)
 *
 * Benefits:
 * - Debuggable: Log shows complete action history
 * - Testable: Reducer is pure function
 * - Predictable: All transitions explicit
 */
export function dispatch(action: Action): void {
  console.log('[ACTION]', action.type, action);

  const prevState = state;
  state = reducer(state, action);

  // Side effects based on state transition
  handleSideEffects(prevState, state, action, dispatch);

  // Update DOM to match new state
  render(state);
}

/**
 * Initialize application
 * Sets up event listeners and renders initial state
 */
function init(): void {
  console.log('[APP] tuturu WebRTC client initialized (state machine architecture)');

  // Wire up DOM event listeners
  setupEventListeners(dispatch);

  // Render initial state (PIN entry screen)
  render(state);
}

/**
 * Cleanup on page unload
 * Ensures resources are properly released
 *
 * @remarks
 * Important for:
 * - Turning off camera/microphone
 * - Closing network connections
 * - Notifying server of disconnect
 */
function cleanup(): void {
  if (state.ws) {
    state.ws.close(1000, 'User closed page');
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }

  if (state.pc) {
    state.pc.close();
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', init);

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
