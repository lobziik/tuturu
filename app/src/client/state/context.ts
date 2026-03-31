/**
 * Preact context for state management
 * Provides AppState + dispatch to all components via context
 *
 * @module state/context
 */

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { AppState, Action } from './types';

/** Dispatch function type */
export type Dispatch = (action: Action) => void;

/** App context shape: current state + dispatch function */
interface AppContextValue {
  state: AppState;
  dispatch: Dispatch;
}

/**
 * Preact context for accessing state and dispatch from any component.
 * Must be provided by `<App />` via `AppContext.Provider`.
 */
export const AppContext = createContext<AppContextValue>(null!);

/** Hook to access state and dispatch from the nearest AppContext.Provider */
export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}

/**
 * Wraps a reducer with debug logging.
 * Logs every action, phase transitions, and screen transitions to the console.
 */
export function createDebugReducer(
  reducerFn: (s: AppState, a: Action) => AppState,
): (s: AppState, a: Action) => AppState {
  return (state: AppState, action: Action): AppState => {
    console.log('[ACTION]', action.type, action);
    const newState = reducerFn(state, action);

    // Log phase transitions
    if (newState.phase !== state.phase) {
      console.log('[PHASE]', state.phase, '\u2192', newState.phase);
    }

    // Log screen transitions within room phase
    const prevScreen = state.phase === 'room' ? state.screen.type : null;
    const newScreen = newState.phase === 'room' ? newState.screen.type : null;
    if (prevScreen !== newScreen) {
      console.log('[SCREEN]', prevScreen, '\u2192', newScreen);
    }

    return newState;
  };
}
