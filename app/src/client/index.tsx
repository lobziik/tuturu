/**
 * tuturu client entry point (Preact + legacy bridge)
 *
 * @remarks
 * Session 1a: Preact `<App />` renders alongside the legacy v1 system.
 * The legacy bridge (render.ts + events.ts + effects.ts) keeps the call
 * flow working. Preact currently only renders a phase indicator.
 *
 * In session 1b, screens will migrate to Preact components.
 * In session 1c, the legacy bridge will be removed entirely.
 *
 * @module client/index
 */

import { render } from 'preact';
import { App } from './components/App';

// Legacy v1 bridge — keeps render.ts + events.ts + effects.ts working
import './legacyBridge';

render(<App />, document.getElementById('root')!);
