/**
 * Floating scroll-to-bottom button — shown when user scrolls up in chat feed.
 *
 * @module components/ScrollToBottom
 */

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
      class={`scroll-to-bottom ${visible ? 'visible' : ''}`}
      onMouseDown={preventFocusSteal}
      onClick={onClick}
      aria-label="Scroll to bottom"
      type="button"
    >
      ▼
    </button>
  );
}
