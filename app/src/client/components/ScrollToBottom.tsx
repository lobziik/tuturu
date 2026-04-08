/**
 * Floating scroll-to-bottom button — shown when user scrolls up in chat feed.
 *
 * @module components/ScrollToBottom
 */

import { ChevronDownIcon } from '@heroicons/react/24/solid';

interface ScrollToBottomProps {
  /** Whether the button should be visible */
  visible: boolean;
  /** Callback when the button is clicked */
  onClick: () => void;
}

/**
 * Prevent mousedown default to stop the button from stealing focus from the
 * textarea. This keeps the iOS keyboard open when tapping scroll-to-bottom.
 */
function preventFocusSteal(e: MouseEvent): void {
  e.preventDefault();
}

/** Floating circular button with down-arrow for jumping to latest messages */
export function ScrollToBottom({ visible, onClick }: Readonly<ScrollToBottomProps>) {
  return (
    <button
      class={`absolute bottom-4 right-4 size-10 rounded-full bg-surface-light border border-surface-border text-txt flex items-center justify-center cursor-pointer p-0 transition-all z-10 shadow-lg hover:bg-surface-border${
        visible
          ? ' opacity-100 scale-100 pointer-events-auto'
          : ' opacity-0 scale-75 pointer-events-none'
      }`}
      data-scroll-btn
      onMouseDown={preventFocusSteal}
      onClick={onClick}
      aria-label="Scroll to bottom"
      type="button"
    >
      <ChevronDownIcon class="size-5" />
    </button>
  );
}
