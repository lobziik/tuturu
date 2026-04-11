/**
 * Settings overlay — modal for profile management and local data.
 *
 * Sections:
 * - Profile: change nickname (persisted to IDB, triggers WS reconnect)
 * - Data: clear chat history (wipes IDB blobs, clears in-memory messages)
 * - Room: leave room (nulls aesKey, returns to login screen)
 * - About: version and project link
 *
 * Uses native `<dialog>` for built-in Escape handling, focus trapping,
 * and proper ARIA semantics.
 *
 * @module components/SettingsOverlay
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import type { Dispatch } from '../state/context';

interface SettingsOverlayProps {
  /** Current nickname */
  nickname: string;
  /** State dispatch function */
  dispatch: Dispatch;
  /** Close the overlay */
  onClose: () => void;
}

/** Settings modal overlay */
export function SettingsOverlay({ nickname, dispatch, onClose }: Readonly<SettingsOverlayProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [nicknameInput, setNicknameInput] = useState(nickname);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const trimmed = nicknameInput.trim();
  const nicknameChanged = trimmed.length > 0 && trimmed !== nickname;

  // Show as modal on mount, handle native Escape via cancel event
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.close();
    };
  }, [onClose]);

  const handleSaveNickname = useCallback(() => {
    if (!nicknameChanged) return;
    dispatch({ type: 'CHANGE_NICKNAME', nickname: trimmed });
  }, [nicknameChanged, trimmed, dispatch]);

  const handleClearHistory = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    dispatch({ type: 'CLEAR_HISTORY' });
  }, [confirmClear, dispatch]);

  const handleLeaveRoom = useCallback(() => {
    if (!confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    dispatch({ type: 'LEAVE_ROOM' });
  }, [confirmLeave, dispatch]);

  // Close when clicking the backdrop area (dialog element itself, not its children)
  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === dialogRef.current) onClose();
    },
    [onClose],
  );

  const handleNicknameKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveNickname();
      }
    },
    [handleSaveNickname],
  );

  return (
    <dialog
      ref={dialogRef}
      class="overlay-backdrop settings-backdrop"
      aria-label="Settings"
      onClick={handleBackdropClick}
    >
      <div class="settings-modal">
        <div class="settings-header">
          <span>Settings</span>
          <button
            type="button"
            class="overlay-close-btn settings-close-btn"
            onClick={onClose}
            aria-label="Close settings"
            autoFocus
          >
            {'\u2715'}
          </button>
        </div>

        {/* Profile section */}
        <div class="settings-section">
          <div class="settings-section-title">Profile</div>
          <div class="settings-nickname-row">
            <input
              type="text"
              class="settings-input"
              value={nicknameInput}
              maxLength={30}
              autocomplete="off"
              placeholder="Your name"
              onInput={(e) => setNicknameInput(e.currentTarget.value)}
              onKeyDown={handleNicknameKeyDown}
            />
            <button
              type="button"
              class="settings-save-btn"
              disabled={!nicknameChanged}
              onClick={handleSaveNickname}
            >
              Save
            </button>
          </div>
        </div>

        {/* Data section */}
        <div class="settings-section">
          <div class="settings-section-title">Data</div>
          {confirmClear ? (
            <div class="settings-confirm">
              <span>Delete all messages on this device?</span>
              <div class="settings-confirm-actions">
                <button type="button" class="settings-danger-btn" onClick={handleClearHistory}>
                  Yes, clear
                </button>
                <button
                  type="button"
                  class="settings-cancel-btn"
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" class="settings-danger-btn" onClick={handleClearHistory}>
              Clear chat history
            </button>
          )}
        </div>

        {/* Room section */}
        <div class="settings-section">
          <div class="settings-section-title">Room</div>
          {confirmLeave ? (
            <div class="settings-confirm">
              <span>Leave this room? You can rejoin with the same passphrase.</span>
              <div class="settings-confirm-actions">
                <button type="button" class="settings-danger-btn" onClick={handleLeaveRoom}>
                  Yes, leave
                </button>
                <button
                  type="button"
                  class="settings-cancel-btn"
                  onClick={() => setConfirmLeave(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" class="settings-danger-btn" onClick={handleLeaveRoom}>
              Leave room
            </button>
          )}
        </div>

        {/* About section */}
        <div class="settings-section">
          <div class="settings-section-title">About</div>
          <div class="settings-about">
            <p>tuturu v1.0.0-dev</p>
            <p>
              <a href="https://github.com/lobziik/tuturu" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </p>
          </div>
        </div>
      </div>
    </dialog>
  );
}
