/**
 * Shared hook for native `<dialog>` overlays.
 *
 * Calls `showModal()` on mount, handles Escape via the native `cancel` event,
 * and closes on backdrop clicks (clicks on the dialog element itself, outside
 * its children).
 *
 * @module components/useDialogOverlay
 */

import { useEffect, useRef } from 'preact/hooks';

/**
 * Manage a `<dialog>` element as a modal overlay.
 *
 * @param onClose — callback invoked when the user dismisses the overlay
 *   (Escape key or backdrop click)
 * @returns ref to attach to the `<dialog>` element
 */
export function useDialogOverlay(onClose: () => void): preact.RefObject<HTMLDialogElement> {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('click', handleClick);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('click', handleClick);
      dialog.close();
    };
  }, [onClose]);

  return dialogRef;
}
