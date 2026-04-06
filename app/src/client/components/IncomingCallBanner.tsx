/**
 * Incoming call notification banner — appears over chat when a call offer arrives on idle screen.
 *
 * @module components/IncomingCallBanner
 */

import type { Dispatch } from '../state/context';

interface IncomingCallBannerProps {
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Banner overlay showing incoming call with Accept/Decline buttons */
export function IncomingCallBanner({ dispatch }: Readonly<IncomingCallBannerProps>) {
  return (
    <div class="incoming-call-banner">
      <span class="incoming-call-text">Incoming call...</span>
      <div class="incoming-call-actions">
        <button
          class="incoming-call-btn accept"
          type="button"
          onClick={() => dispatch({ type: 'ACCEPT_CALL' })}
        >
          Accept
        </button>
        <button
          class="incoming-call-btn decline"
          type="button"
          onClick={() => dispatch({ type: 'DECLINE_CALL' })}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
