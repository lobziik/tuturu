/**
 * Chat room header — title, call button, settings button.
 *
 * @module components/Header
 */

interface HeaderProps {
  /** Callback when phone button is clicked */
  onCallClick: () => void;
}

/** Room header bar with title and action buttons */
export function Header({ onCallClick }: HeaderProps) {
  return (
    <div class="chat-header">
      <span class="chat-header-title">tuturu</span>
      <div class="chat-header-actions">
        <button class="chat-header-btn" type="button" onClick={onCallClick} aria-label="Start call">
          📞
        </button>
        <button class="chat-header-btn" type="button" aria-label="Settings" disabled>
          ⚙️
        </button>
      </div>
    </div>
  );
}
