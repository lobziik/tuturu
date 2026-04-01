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

/** Floating circular button with down-arrow for jumping to latest messages */
export function ScrollToBottom({ visible, onClick }: ScrollToBottomProps) {
  return (
    <button
      class={`scroll-to-bottom ${visible ? 'visible' : ''}`}
      onClick={onClick}
      aria-label="Scroll to bottom"
      type="button"
    >
      ▼
    </button>
  );
}
