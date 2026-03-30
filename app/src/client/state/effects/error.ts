/**
 * Error side effects — auto-dismiss timeout management.
 *
 * @module state/effects/error
 */

import type { EffectContext, EffectArgs } from './types';

/** Handle error timeout: start on entering error, clear on leaving */
export function handleErrorEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { prevState, newState } = args;

  // Entering error → Start 5-second auto-dismiss timeout
  if (newState.screen.type === 'error' && prevState.screen.type !== 'error') {
    if (refs.errorTimeout.current !== null) {
      clearTimeout(refs.errorTimeout.current);
    }
    refs.errorTimeout.current = window.setTimeout(() => {
      dispatch({ type: 'DISMISS_ERROR' });
      refs.errorTimeout.current = null;
    }, 5000);
  }

  // Leaving error → Clear any pending timeout
  if (prevState.screen.type === 'error' && newState.screen.type !== 'error') {
    if (refs.errorTimeout.current !== null) {
      clearTimeout(refs.errorTimeout.current);
      refs.errorTimeout.current = null;
    }
  }
}
