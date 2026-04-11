/**
 * Peer list drawer — slide-from-right panel showing online users.
 *
 * Displays the current user first ("you"), followed by all connected peers.
 * Peers show their decrypted nickname, or a truncated peerId as fallback.
 *
 * Uses native `<dialog>` for built-in Escape handling, focus trapping,
 * and proper ARIA semantics.
 *
 * @module components/PeerListDrawer
 */

import type { PeerState } from '../../shared/types';
import { useDialogOverlay } from './useDialogOverlay';

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
  const dialogRef = useDialogOverlay(onClose);
  const peerEntries = Object.values(peers);
  const totalCount = peerEntries.length + 1; // +1 for self

  return (
    <dialog ref={dialogRef} class="overlay-backdrop peer-list-backdrop" aria-label="Online users">
      <div class="peer-list-drawer">
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
    </dialog>
  );
}
