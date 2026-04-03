/**
 * Chat input bar — contenteditable div with send button.
 * Uses contenteditable instead of textarea to avoid iOS Safari's
 * form accessory bar (prev/next/done toolbar above keyboard).
 *
 * @module components/ChatInput
 */

import { useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';

interface ChatInputProps {
  /** Callback when user sends a message */
  onSend: (text: string) => void;
  /** External ref to the editable element (for parent-driven refocus) */
  inputRef: RefObject<HTMLDivElement>;
}

/** Chat input bar with contenteditable and send button */
export function ChatInput({ onSend, inputRef }: ChatInputProps) {
  /** Get plain text content from the editable div */
  const getText = (): string => inputRef.current?.textContent ?? '';

  const doSend = useCallback(() => {
    const trimmed = getText().trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    if (inputRef.current) {
      inputRef.current.textContent = '';
      inputRef.current.focus();
    }
  }, [onSend, inputRef]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    },
    [doSend],
  );

  const handleFocus = useCallback(() => {
    // Safety net for iOS keyboard: scroll input into view after keyboard appears
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'nearest' });
    }, 300);
  }, [inputRef]);

  /**
   * Prevent mousedown default on send button to stop it from stealing focus
   * from the editable div. Keeps iOS keyboard open after sending.
   */
  const preventFocusSteal = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div class="chat-input-bar">
      <div
        ref={inputRef}
        class="chat-text-input"
        contentEditable
        role="textbox"
        aria-label="Message"
        data-placeholder="Message..."
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
      />
      <button
        class="chat-send-btn"
        type="button"
        onMouseDown={preventFocusSteal}
        onClick={doSend}
        aria-label="Send message"
      >
        &#x27A4;
      </button>
    </div>
  );
}
