/**
 * Peer list drawer — slide-from-right panel showing online users.
 *
 * Displays the current user first ("you"), followed by all connected peers.
 * Peers show their decrypted nickname, or a truncated peerId as fallback.
 *
 * @module components/PeerListDrawer
 */

import { useCallback, useEffect } from 'preact/hooks';
import type { PeerState } from '../../shared/types';

interface PeerListDrawerProps {
  /** Connected peers in the room (peerId → PeerState) */
  peers: Record<string, PeerState>;
  /** Current user's display name */
  selfNickname: string;
  /** Close the drawer */
  onClose: () => void;
}

/** Format a peer's display name — nickname if available, truncated peerId otherwise */
function formatPeerName(peer: PeerState): string {
  if (peer.nickname) return peer.nickname;
  return `${peer.peerId.slice(0, 8)}\u2026`;
}

/** Slide-from-right drawer listing all online users in the room */
export function PeerListDrawer({ peers, selfNickname, onClose }: Readonly<PeerListDrawerProps>) {
  const peerEntries = Object.values(peers);
  const totalCount = peerEntries.length + 1; // +1 for self

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      // Only close when clicking the backdrop itself, not the drawer content
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div class="overlay-backdrop peer-list-backdrop" onClick={handleBackdropClick}>
      <div class="peer-list-drawer" role="dialog" aria-modal="true" aria-label="Online users">
        <div class="peer-list-header">
          <span>Online ({totalCount})</span>
          <button
            type="button"
            class="overlay-close-btn peer-list-close-btn"
            onClick={onClose}
            aria-label="Close peer list"
            autoFocus
          >
            {'\u2715'}
          </button>
        </div>
        <ul class="peer-list">
          <li class="peer-list-item peer-list-self">
            <span class="peer-dot" />
            <span>{selfNickname} (you)</span>
          </li>
          {peerEntries.map((peer) => (
            <li key={peer.peerId} class="peer-list-item">
              <span class="peer-dot" />
              <span>{formatPeerName(peer)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
