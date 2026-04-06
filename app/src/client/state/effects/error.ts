/**
 * Error side effects — auto-dismiss timeout management.
 *
 * @module state/effects/error
 */

import type { EffectContext, EffectArgs } from './types';
import { getScreen } from './types';

/** Handle error timeout: start on entering error, clear on leaving */
export function handleErrorEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { prevState, newState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);

  // Entering error → Start 5-second auto-dismiss timeout
  if (newScreen?.type === 'error' && prevScreen?.type !== 'error') {
    if (refs.errorTimeout.current !== null) {
      clearTimeout(refs.errorTimeout.current);
    }
    refs.errorTimeout.current = window.setTimeout(() => {
      dispatch({ type: 'DISMISS_ERROR' });
      refs.errorTimeout.current = null;
    }, 5000);
  }

  // Leaving error → Clear any pending timeout
  if (prevScreen?.type === 'error' && newScreen?.type !== 'error') {
    if (refs.errorTimeout.current !== null) {
      clearTimeout(refs.errorTimeout.current);
      refs.errorTimeout.current = null;
    }
  }
}
