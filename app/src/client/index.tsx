/**
 * tuturu client entry point
 * Renders the Preact application into the DOM
 *
 * @module client/index
 */

import { render } from 'preact';
import { App } from './components/App';

render(<App />, document.getElementById('root')!);
