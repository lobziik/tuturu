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
 * Logs every action and screen transitions to the console.
 */
export function createDebugReducer(
  reducerFn: (s: AppState, a: Action) => AppState,
): (s: AppState, a: Action) => AppState {
  return (state: AppState, action: Action): AppState => {
    console.log('[ACTION]', action.type, action);
    const newState = reducerFn(state, action);
    if (newState.screen.type !== state.screen.type) {
      console.log('[SCREEN]', state.screen.type, '\u2192', newState.screen.type);
    }
    return newState;
  };
}
