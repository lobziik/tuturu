/**
 * Chat room header — title, online indicator, call button, settings button.
 *
 * @module components/Header
 */

import { PhoneIcon } from '@heroicons/react/24/solid';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';

interface HeaderProps {
  /** Callback when phone button is clicked */
  onCallClick: () => void;
  /** Total number of people in the room (including self) */
  peerCount: number;
  /** Whether the call button should be disabled */
  callDisabled: boolean;
  /** Whether a call is currently in progress */
  inCall: boolean;
}

/** Room header bar with title, online indicator, and action buttons */
export function Header({ onCallClick, peerCount, callDisabled, inCall }: Readonly<HeaderProps>) {
  return (
    <div class="flex items-center justify-between px-4 py-3 pt-safe bg-surface-light border-b border-surface-border shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-lg font-semibold">tuturu</span>
        <span class="flex items-center gap-1 text-sm text-txt-muted">
          <span class="size-2 rounded-full bg-online" />
          <span class="tabular-nums">{peerCount}</span>
        </span>
      </div>
      <div class="flex gap-2">
        <button
          class={`size-9 rounded-full bg-transparent text-txt border border-surface-border flex items-center justify-center cursor-pointer p-0 transition-colors hover:bg-surface-border disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent${inCall ? ' !bg-green-700 !border-green-700 !text-white animate-pulse-call hover:!bg-green-800' : ''}`}
          type="button"
          onClick={onCallClick}
          aria-label={inCall ? 'Return to call' : 'Start call'}
          disabled={callDisabled && !inCall}
        >
          <PhoneIcon class="size-4" />
        </button>
        <button
          class="size-9 rounded-full bg-transparent text-txt border border-surface-border flex items-center justify-center cursor-pointer p-0 transition-colors hover:bg-surface-border disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          type="button"
          aria-label="Settings"
          disabled
        >
          <Cog6ToothIcon class="size-4" />
        </button>
      </div>
    </div>
  );
}
