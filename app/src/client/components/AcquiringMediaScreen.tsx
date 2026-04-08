/**
 * Acquiring media screen — shown while requesting camera/microphone access.
 * Displays a spinner animation while waiting for permissions.
 *
 * @module components/AcquiringMediaScreen
 */

import { ArrowPathIcon } from '@heroicons/react/24/outline';

/** Acquiring media screen — spinner + message while camera/mic permissions are requested */
export function AcquiringMediaScreen() {
  return (
    <div class="flex flex-col items-center justify-center min-h-screen min-h-dvh p-4">
      <div class="bg-surface-light border border-surface-border rounded-2xl p-8 w-full max-w-md text-center">
        <ArrowPathIcon class="w-10 h-10 text-brand animate-spin mx-auto mb-4" />
        <h2 class="text-2xl font-bold mb-6">Starting call...</h2>
        <p class="mt-4 text-sm text-txt-muted">Requesting camera and microphone access</p>
      </div>
    </div>
  );
}
