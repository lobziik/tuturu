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
  /** Whether the server requires E2EE for media (drives the encryption badge) */
  e2eeMediaEnabled: boolean;
  /** Whether the room is using SFU mode (vs mesh) */
  sfuMode: boolean;
}

/**
 * Pick the security badge shown next to the room title.
 *
 * - E2EE on (any topology): "E2EE" — same trust signal everywhere.
 * - SFU + E2EE off: "SFU | media unencrypted" — explicit because SFU media
 *   passes through the server in the clear and that is worth surfacing.
 * - Mesh + E2EE off: nothing — peer-to-peer with no script transform is the
 *   plain WebRTC default; no badge needed.
 */
function pickBadge(
  e2eeMediaEnabled: boolean,
  sfuMode: boolean,
): { label: string; title: string; off: boolean } | null {
  if (e2eeMediaEnabled) {
    return { label: 'E2EE', title: 'Media is end-to-end encrypted', off: false };
  }
  if (sfuMode) {
    return {
      label: 'SFU | media unencrypted',
      title: 'Server relays media in the clear (E2EE disabled by the operator)',
      off: true,
    };
  }
  return null;
}

/** Room header bar with title, online indicator, and action buttons */
export function Header({
  onCallClick,
  onPeersClick,
  onSettingsClick,
  peerCount,
  callDisabled,
  inCall,
  e2eeMediaEnabled,
  sfuMode,
}: Readonly<HeaderProps>) {
  const badge = pickBadge(e2eeMediaEnabled, sfuMode);
  return (
    <div class="chat-header">
      <div class="chat-header-left">
        <span class="chat-header-title">tuturu</span>
        {badge && (
          <span class={`e2ee-badge${badge.off ? ' off' : ''}`} title={badge.title}>
            {badge.label}
          </span>
        )}
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
