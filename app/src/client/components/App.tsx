/**
 * Root Preact component
 * Owns useReducer state + provides AppContext to all children
 *
 * @remarks
 * In session 1a this only renders a debug phase indicator.
 * Screen components will be added in session 1b.
 *
 * @module components/App
 */

import { useReducer } from 'preact/hooks';
import { reducer } from '../state/reducer';
import { initialState } from '../state/types';
import { AppContext, createDebugReducer } from '../state/context';

const debugReducer = createDebugReducer(reducer);

/** Root application component with state provider */
export function App() {
  const [state, dispatch] = useReducer(debugReducer, initialState);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <div id="app">
        <p>Phase: {state.screen.type}</p>
      </div>
    </AppContext.Provider>
  );
}
