import type { Dispatch } from '../state/context';
import { PinEntryScreen } from './PinEntryScreen';

interface ErrorBannerProps {
  message: string;
  canRetry: boolean;
  dispatch: Dispatch;
}

/** Error banner — shows error message with optional retry via PinEntryScreen */
export function ErrorBanner({ message, canRetry, dispatch }: ErrorBannerProps) {
  return (
    <>
      <div id="error-display" class="error">
        <strong>Error:</strong> <span id="error-message">{message}</span>
      </div>
      {canRetry && <PinEntryScreen dispatch={dispatch} />}
    </>
  );
}
