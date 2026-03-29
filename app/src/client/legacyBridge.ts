/**
 * Legacy bridge — keeps v1 render.ts + events.ts + effects.ts working
 *
 * @remarks
 * This is the old index.ts logic, extracted so the v1 call flow continues
 * to work alongside the new Preact `<App />`.
 *
 * Will be removed in session 1c when all screens are Preact components.
 *
 * @module client/legacyBridge
 */

import type { Action } from './state/types';
import { initialState } from './state/types';
import { reducer } from './state/reducer';
import { render } from './render';
import { handleSideEffects } from './effects';
import { setupEventListeners } from './events';

/** Application state - single source of truth for the legacy system */
let state = initialState;

/** Dispatch function for the legacy v1 system */
export function dispatch(action: Action): void {
  console.log('[ACTION]', action.type, action);

  const prevState = state;
  state = reducer(state, action);

  handleSideEffects(prevState, state, action, dispatch);
  render(state);
}

/** Initialize legacy event listeners and render initial state */
function init(): void {
  console.log('[APP] tuturu WebRTC client initialized (legacy bridge)');
  setupEventListeners(dispatch);
  render(state);
}

/** Cleanup on page unload */
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

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', cleanup);
