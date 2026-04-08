/**
 * Error banner — shows error message with dismiss button that returns to chat.
 * Uses ExclamationTriangleIcon from Heroicons for visual emphasis.
 *
 * @module components/ErrorBanner
 */

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { Dispatch } from '../state/context';

interface ErrorBannerProps {
  message: string;
  dispatch: Dispatch;
}

/** Error banner — shows error message with dismiss button that returns to chat */
export function ErrorBanner({ message, dispatch }: Readonly<ErrorBannerProps>) {
  return (
    <div class="flex flex-col items-center justify-center min-h-screen min-h-dvh p-4">
      <div
        id="error-display"
        class="bg-danger text-white p-4 rounded-lg max-w-xl text-center animate-slide-in"
      >
        <ExclamationTriangleIcon class="mx-auto mb-2 h-8 w-8" />
        <strong>Error:</strong> <span id="error-message">{message}</span>
        <button
          type="button"
          class="mt-3 bg-transparent border-none text-white/70 text-sm cursor-pointer hover:text-white block mx-auto"
          onClick={() => dispatch({ type: 'DISMISS_ERROR' })}
        >
          Back to chat
        </button>
      </div>
    </div>
  );
}
