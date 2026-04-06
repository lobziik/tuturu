import type { Dispatch } from '../state/context';

interface ErrorBannerProps {
  message: string;
  dispatch: Dispatch;
}

/** Error banner — shows error message with dismiss button that returns to chat */
export function ErrorBanner({ message, dispatch }: Readonly<ErrorBannerProps>) {
  return (
    <div id="error-display" class="error">
      <strong>Error:</strong> <span id="error-message">{message}</span>
      <button type="button" class="back-btn" onClick={() => dispatch({ type: 'DISMISS_ERROR' })}>
        Back to chat
      </button>
    </div>
  );
}
