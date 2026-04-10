/**
 * Chat room header — title, online indicator, call button, settings button.
 *
 * @module components/Header
 */

interface HeaderProps {
  /** Callback when phone button is clicked */
  onCallClick: () => void;
  /** Callback when online indicator is clicked */
  onPeersClick: () => void;
  /** Callback when settings button is clicked */
  onSettingsClick: () => void;
  /** Total number of people in the room (including self) */
  peerCount: number;
  /** Whether the call button should be disabled */
  callDisabled: boolean;
  /** Whether a call is currently in progress */
  inCall: boolean;
}

/** Room header bar with title, online indicator, and action buttons */
export function Header({
  onCallClick,
  onPeersClick,
  onSettingsClick,
  peerCount,
  callDisabled,
  inCall,
}: Readonly<HeaderProps>) {
  return (
    <div class="chat-header">
      <div class="chat-header-left">
        <span class="chat-header-title">tuturu</span>
        <button
          type="button"
          class="online-indicator-btn"
          onClick={onPeersClick}
          aria-label="View online users"
        >
          <span class="online-dot" />
          <span class="online-count">{peerCount}</span>
        </button>
      </div>
      <div class="chat-header-actions">
        <button
          class={`chat-header-btn${inCall ? ' in-call' : ''}`}
          type="button"
          onClick={onCallClick}
          aria-label={inCall ? 'Return to call' : 'Start call'}
          disabled={callDisabled && !inCall}
        >
          {'\uD83D\uDCDE'}
        </button>
        <button
          class="chat-header-btn"
          type="button"
          aria-label="Settings"
          onClick={onSettingsClick}
        >
          {'\u2699\uFE0F'}
        </button>
      </div>
    </div>
  );
}
